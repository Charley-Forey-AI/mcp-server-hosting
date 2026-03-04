const JWT_ISSUER = process.env.JWT_ISSUER || "";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "";
const JWT_JWKS_URI = process.env.JWT_JWKS_URI || "";
const JWT_HS256_SECRET = process.env.JWT_HS256_SECRET || "";
const JWT_ROLES_CLAIM = process.env.JWT_ROLES_CLAIM || "roles";
const PLATFORM_API_KEYS = (process.env.PLATFORM_API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

let cachedJwksFn = null;
const { authFailuresTotal } = require("./metrics");

function jwtEnabled() {
  return Boolean(JWT_JWKS_URI || JWT_HS256_SECRET);
}

function parseRoles(payload) {
  const raw = payload?.[JWT_ROLES_CLAIM] ?? payload?.role ?? payload?.roles;
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return [];
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

async function authenticate(req, res, next) {
  try {
    const apiKey = req.get("x-api-key");
    const token = getBearerToken(req);

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
};
