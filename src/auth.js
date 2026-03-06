const crypto = require("crypto");

const JWT_ISSUER = process.env.JWT_ISSUER || "";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "";
const JWT_JWKS_URI = process.env.JWT_JWKS_URI || "";
const JWT_HS256_SECRET = process.env.JWT_HS256_SECRET || "";
const JWT_ROLES_CLAIM = process.env.JWT_ROLES_CLAIM || "roles";
const WEB_ADMIN_EMAIL = String(process.env.WEB_ADMIN_EMAIL || "").trim().toLowerCase();
const WEB_ADMIN_PASSWORD = String(process.env.WEB_ADMIN_PASSWORD || "");
const WEB_SESSION_COOKIE_NAME = String(process.env.WEB_SESSION_COOKIE_NAME || "mcp_session").trim() || "mcp_session";
const WEB_SESSION_TTL_MS = Math.max(60_000, Number(process.env.WEB_SESSION_TTL_MS || 12 * 60 * 60 * 1000));
const PLATFORM_API_KEYS = (process.env.PLATFORM_API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

let cachedJwksFn = null;
const { authFailuresTotal } = require("./metrics");
const browserSessions = new Map();

function jwtEnabled() {
  return Boolean(JWT_JWKS_URI || JWT_HS256_SECRET);
}

function browserLoginEnabled() {
  return Boolean(WEB_ADMIN_EMAIL && WEB_ADMIN_PASSWORD);
}

function parseRoles(payload) {
  const raw = payload?.[JWT_ROLES_CLAIM] ?? payload?.role ?? payload?.roles;
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return [];
}

function secureCompare(a, b) {
  const aBuf = Buffer.from(String(a || ""));
  const bBuf = Buffer.from(String(b || ""));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyBrowserCredentials(email, password) {
  if (!browserLoginEnabled()) return false;
  const normalizedEmail = String(email || "").trim().toLowerCase();
  return secureCompare(normalizedEmail, WEB_ADMIN_EMAIL) && secureCompare(String(password || ""), WEB_ADMIN_PASSWORD);
}

function parseCookies(req) {
  const raw = String(req.get("cookie") || "");
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf("=");
        if (idx < 0) return [pair, ""];
        return [pair.slice(0, idx).trim(), decodeURIComponent(pair.slice(idx + 1))];
      }),
  );
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of browserSessions.entries()) {
    if (!session || session.expiresAt <= now) browserSessions.delete(token);
  }
}

function createBrowserSession({ sub = WEB_ADMIN_EMAIL || "web-admin", roles = ["admin", "publisher", "viewer"] } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + WEB_SESSION_TTL_MS;
  browserSessions.set(token, { sub, roles, expiresAt });
  return { token, expiresAt };
}

function clearBrowserSession(token) {
  if (token) browserSessions.delete(token);
}

function getBrowserSession(req) {
  pruneExpiredSessions();
  const cookies = parseCookies(req);
  const token = cookies[WEB_SESSION_COOKIE_NAME];
  if (!token) return null;
  const session = browserSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    browserSessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function shouldRedirectToLogin(req) {
  if (req.method !== "GET") return false;
  return String(req.path || "").startsWith("/dashboard");
}

function setBrowserSessionCookie(res, token, req) {
  const forwardedProto = String(req.get("x-forwarded-proto") || "").toLowerCase();
  const secure = req.secure || forwardedProto === "https";
  const cookieParts = [
    `${WEB_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) cookieParts.push("Secure");
  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function clearBrowserSessionCookie(res) {
  res.setHeader("Set-Cookie", `${WEB_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function verifyJwt(token) {
  const jose = await import("jose");

  if (JWT_JWKS_URI) {
    if (!cachedJwksFn) {
      cachedJwksFn = jose.createRemoteJWKSet(new URL(JWT_JWKS_URI));
    }
    const { payload } = await jose.jwtVerify(token, cachedJwksFn, {
      issuer: JWT_ISSUER || undefined,
      audience: JWT_AUDIENCE || undefined,
    });
    return payload;
  }

  const secret = new TextEncoder().encode(JWT_HS256_SECRET);
  const { payload } = await jose.jwtVerify(token, secret, {
    issuer: JWT_ISSUER || undefined,
    audience: JWT_AUDIENCE || undefined,
  });
  return payload;
}

function getBearerToken(req) {
  const auth = req.get("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice("bearer ".length).trim();
}

function isMcpProxyRequest(req) {
  const originalUrl = String(req.originalUrl || req.url || "");
  return originalUrl.startsWith("/mcp/");
}

async function authenticate(req, res, next) {
  try {
    const apiKey = req.get("x-api-key");
    const token = getBearerToken(req);
    const browserSession = getBrowserSession(req);

    if (jwtEnabled() && token) {
      const payload = await verifyJwt(token);
      req.auth = {
        sub: String(payload.sub || payload.email || "unknown"),
        roles: parseRoles(payload),
        authType: "jwt",
        claims: payload,
      };
      return next();
    }

    if (apiKey && PLATFORM_API_KEYS.includes(apiKey)) {
      req.auth = {
        sub: `apiKey:${apiKey.slice(0, 6)}`,
        roles: ["admin"],
        authType: "apiKey",
        claims: {},
      };
      return next();
    }

    if (browserSession) {
      req.auth = {
        sub: browserSession.sub,
        roles: browserSession.roles,
        authType: "session",
        claims: {},
      };
      return next();
    }

    if (isMcpProxyRequest(req)) {
      req.auth = {
        sub: "anonymous-mcp",
        roles: ["viewer"],
        authType: "none",
        claims: {},
      };
      return next();
    }

    if (!jwtEnabled() && !PLATFORM_API_KEYS.length) {
      req.auth = {
        sub: "anonymous-local",
        roles: ["admin"],
        authType: "none",
        claims: {},
      };
      return next();
    }

    authFailuresTotal.labels("missing_or_invalid_credentials").inc();
    if (shouldRedirectToLogin(req)) {
      const nextPath = encodeURIComponent(String(req.originalUrl || req.url || "/dashboard"));
      return res.redirect(`/login?next=${nextPath}`);
    }
    return res.status(401).json({ error: "unauthorized", message: "Provide valid bearer token or platform API key" });
  } catch (error) {
    authFailuresTotal.labels("jwt_verification_failed").inc();
    return res.status(401).json({ error: "unauthorized", message: String(error.message || error) });
  }
}

function requireRole(...allowedRoles) {
  const normalized = new Set(allowedRoles.map((r) => r.toLowerCase()));
  return (req, res, next) => {
    const roles = (req.auth?.roles || []).map((r) => String(r).toLowerCase());
    const ok = roles.some((r) => normalized.has(r));
    if (!ok) {
      authFailuresTotal.labels("rbac_forbidden").inc();
      return res.status(403).json({ error: "forbidden", message: `Required role: ${[...normalized].join(" or ")}` });
    }
    return next();
  };
}

module.exports = {
  authenticate,
  requireRole,
  jwtEnabled,
  browserLoginEnabled,
  verifyBrowserCredentials,
  createBrowserSession,
  clearBrowserSession,
  getBrowserSession,
  setBrowserSessionCookie,
  clearBrowserSessionCookie,
  WEB_SESSION_COOKIE_NAME,
};
