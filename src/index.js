const express = require("express");
const Docker = require("dockerode");
const path = require("path");
const {
  migrate,
  listServers,
  getServerById,
  createServer,
  updateServer,
  deleteServer,
  updateServerHealth,
  insertAuditLog,
  listAuditLogs,
  createProvisioningJobRecord,
  listProvisioningJobs,
  createImportJobRecord,
  getImportJobById,
  listImportJobs,
  incrementAndGetRequestCount,
  getRequestCount,
  listUsageSummaryByServer,
  countProvisioningJobsSince,
  countImportJobsSince,
  setServerToolsCheck,
  listServerLastRequestAt,
  insertRequestEvent,
  getAnalyticsSummary,
  getTopServersAnalytics,
  cleanupRequestEventsOlderThan,
} = require("./db");
const {
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
} = require("./auth");
const { enqueueProvisionJob } = require("./queue");
const { parseGitHubUrl, deriveServerId } = require("./importPipeline");
const { initTelemetry } = require("./telemetry");
const logger = require("./logger");
const pinoHttp = require("pino-http");
const {
  register,
  metricsContentType,
  requestMetricsMiddleware,
  mcpProxyRequestsTotal,
  mcpProxyStatusCodeTotal,
  mcpProxyLatencyMs,
  authFailuresTotal,
  activeStreamsGauge,
  quotaBlocksTotal,
} = require("./metrics");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://your-domain.example.com";
const PORT_MIN = Number(process.env.PORT_MIN || 30001);
const PORT_MAX = Number(process.env.PORT_MAX || 30200);
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 15000);
const REQUESTS_PER_MINUTE_PER_SUB = Number(process.env.REQUESTS_PER_MINUTE_PER_SUB || 600);
const REQUESTS_PER_DAY_PER_SUB = Number(process.env.REQUESTS_PER_DAY_PER_SUB || 50000);
const IMPORT_REQUESTS_PER_MINUTE = Number(process.env.IMPORT_REQUESTS_PER_MINUTE || 5);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const PLATFORM_AUTH_DESCRIPTION =
  process.env.PLATFORM_AUTH_DESCRIPTION || "Use your platform API key or JWT for hosted MCP access.";
const PLATFORM_SIGNUP_URL = process.env.PLATFORM_SIGNUP_URL || "";

const app = express();
const importRateLimiter = new Map();
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" });
initTelemetry();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(
  pinoHttp({
    logger,
    customLogLevel(_req, res, error) {
      if (error || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return `request completed ${req.method} ${req.url} ${res.statusCode}`;
    },
  }),
);
app.use(requestMetricsMiddleware);
app.use("/public", express.static(path.join(__dirname, "..", "public")));
app.use("/dashboard/assets", express.static(path.join(__dirname, "..", "public")));

function validateServerInput(input) {
  const id = String(input.id || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("id is required and must match /^[a-zA-Z0-9_-]+$/");
  }

  const internalPort = input.internalPort ? Number(input.internalPort) : undefined;
  if (internalPort !== undefined && !Number.isInteger(internalPort)) {
    throw new Error("internalPort must be a valid integer");
  }

  const authType = input.authType ? String(input.authType).trim().toLowerCase() : null;
  const supportedAuthTypes = new Set(["bearer", "api_key", "oauth", "custom"]);
  if (authType && !supportedAuthTypes.has(authType)) {
    throw new Error("authType must be one of: bearer, api_key, oauth, custom");
  }

  return {
    id,
    name: String(input.name || id),
    description: String(input.description || ""),
    internalPort,
    targetUrl: input.targetUrl ? String(input.targetUrl) : undefined,
    healthPath: String(input.healthPath || "/health"),
    requiredHeaders: Array.isArray(input.requiredHeaders) ? input.requiredHeaders : ["Authorization"],
    forwardHeaders: Array.isArray(input.forwardHeaders) ? input.forwardHeaders : ["authorization"],
    command: input.command ? String(input.command) : null,
    commandArgs: Array.isArray(input.commandArgs) ? input.commandArgs : [],
    commandEnv: input.commandEnv && typeof input.commandEnv === "object" ? input.commandEnv : {},
    commandEnvSecrets:
      input.commandEnvSecrets && typeof input.commandEnvSecrets === "object" ? input.commandEnvSecrets : {},
    authInstructions: input.authInstructions ? String(input.authInstructions) : null,
    docsUrl: input.docsUrl ? String(input.docsUrl) : null,
    authType,
    signupUrl: input.signupUrl ? String(input.signupUrl) : null,
  };
}

function normalizeImportRequest(input = {}) {
  const githubUrl = String(input.githubUrl || "").trim();
  if (!githubUrl) throw new Error("githubUrl is required");
  const parsed = parseGitHubUrl(githubUrl);
  const branch = String(input.branch || "").trim() || null;
  const subdir = String(input.subdir || "").trim() || null;
  const serverId = deriveServerId(String(input.serverId || "").trim(), parsed.repo);
  const autoStart = input.autoStart !== false;
  return {
    githubUrl: parsed.canonicalRepoUrl,
    branch,
    subdir,
    serverId,
    autoStart,
  };
}

async function writeAudit(req, action, resourceType, resourceId, metadata = {}) {
  try {
    await insertAuditLog({
      actorSub: req.auth?.sub || "unknown",
      actorRoles: req.auth?.roles || [],
      action,
      resourceType,
      resourceId,
      requestPath: req.path,
      method: req.method,
      metadata,
    });
  } catch (error) {
    console.error("audit log failed", error);
  }
}

function getUsageCounterKey(req) {
  const tenant = (req.get("x-tenant-id") || "default").trim();
  const sub = String(req.auth?.sub || "anonymous");
  return `${tenant}:${sub}`;
}

async function enforceUsageQuota(req, res, serverId) {
  const counterKey = getUsageCounterKey(req);
  const minuteCount = await incrementAndGetRequestCount(counterKey, serverId, "minute");
  if (minuteCount > REQUESTS_PER_MINUTE_PER_SUB) {
    quotaBlocksTotal.labels("minute", serverId).inc();
    return res.status(429).json({
      error: "rate_limited",
      message: `Per-minute quota exceeded (${REQUESTS_PER_MINUTE_PER_SUB})`,
      window: "minute",
    });
  }

  const dayCount = await incrementAndGetRequestCount(counterKey, serverId, "day");
  if (dayCount > REQUESTS_PER_DAY_PER_SUB) {
    quotaBlocksTotal.labels("day", serverId).inc();
    return res.status(429).json({
      error: "quota_exceeded",
      message: `Per-day quota exceeded (${REQUESTS_PER_DAY_PER_SUB})`,
      window: "day",
    });
  }
  return null;
}

function enforceImportRateLimit(req, res) {
  if (!Number.isFinite(IMPORT_REQUESTS_PER_MINUTE) || IMPORT_REQUESTS_PER_MINUTE <= 0) {
    return null;
  }
  const counterKey = `${getUsageCounterKey(req)}:import_repo`;
  const now = Date.now();
  const windowMs = 60_000;
  const current = importRateLimiter.get(counterKey);
  if (!current || now - current.windowStart >= windowMs) {
    importRateLimiter.set(counterKey, { windowStart: now, count: 1 });
    return null;
  }
  if (current.count >= IMPORT_REQUESTS_PER_MINUTE) {
    return res.status(429).json({
      error: "rate_limited",
      message: `Import rate limit exceeded (${IMPORT_REQUESTS_PER_MINUTE}/minute)`,
      window: "minute",
    });
  }
  current.count += 1;
  importRateLimiter.set(counterKey, current);
  return null;
}

function sanitizeForwardHeaders(reqHeaders, serverConfig) {
  const allow = new Set((serverConfig.forwardHeaders || []).map((h) => h.toLowerCase()));
  const out = {};
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    const lowered = key.toLowerCase();
    if (!allow.has(lowered)) continue;
    if (lowered === "x-api-key" || lowered === "x-platform-api-key" || lowered === "x-portkey-api-key") continue;
    out[key] = value;
  }
  return out;
}

function getClientIp(req) {
  const forwarded = String(req.get("x-forwarded-for") || "").trim();
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return String(req.ip || req.socket?.remoteAddress || "").trim() || null;
}

function ensureStreamAccept(value) {
  const incoming = String(value || "").trim();
  if (!incoming) return "application/json, text/event-stream";
  if (incoming.toLowerCase().includes("text/event-stream")) return incoming;
  const parts = new Set(
    incoming
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  parts.add("text/event-stream");
  return Array.from(parts).join(", ");
}

async function enqueueProvisionAction(req, action, serverId, payload = {}) {
  const job = await enqueueProvisionJob(action, { serverId, ...payload }, { actorSub: req.auth.sub, actorRoles: req.auth.roles });
  await createProvisioningJobRecord(job.id, action, serverId, "queued", { serverId, ...payload }, {
    actorSub: req.auth.sub,
    actorRoles: req.auth.roles,
  });
  return job;
}

function buildCursorSnippet(server, includePlatformAuth = false) {
  const requiredHeaders = Array.isArray(server.requiredHeaders) ? server.requiredHeaders : [];
  const forwardHeaders = Array.isArray(server.forwardHeaders) ? server.forwardHeaders : [];
  const headerSource = requiredHeaders.length > 0 ? requiredHeaders : forwardHeaders;
  const allHeaders = [];
  for (const headerName of headerSource) {
    if (!headerName) continue;
    const normalized = String(headerName).trim();
    if (!normalized) continue;
    if (allHeaders.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) continue;
    allHeaders.push(normalized);
  }
  const headers = Object.fromEntries(
    allHeaders.map((headerName) => {
      const lowered = headerName.toLowerCase();
      if (lowered === "authorization") return [headerName, "Bearer <YOUR_TOKEN>"];
      if (lowered === "x-api-key") return [headerName, "<API_KEY>"];
      return [headerName, `<${headerName}-VALUE>`];
    }),
  );
  const platformAuthEnabled = Boolean((process.env.PLATFORM_API_KEYS || "").trim()) || jwtEnabled();
  if (includePlatformAuth && platformAuthEnabled && !Object.keys(headers).some((headerName) => String(headerName).toLowerCase() === "x-api-key")) {
    headers["X-API-Key"] = "<PLATFORM_KEY>";
  }
  return JSON.stringify(
    {
      mcpServers: {
        [server.id]: {
          url: `${PUBLIC_BASE_URL}/mcp/${server.id}`,
          headers,
        },
      },
    },
    null,
    2,
  );
}

function extractJsonRpcPayload(text) {
  const body = String(text || "").trim();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    // Some implementations stream SSE lines; try to parse data payload chunks.
    const lines = body.split(/\r?\n/).map((line) => line.trim());
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const candidate = line.slice(5).trim();
      if (!candidate || candidate === "[DONE]") continue;
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    return null;
  }
}

function containerNameForServerId(serverId) {
  return `mcp-server-${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

async function getContainerRunningMap(serverIds) {
  try {
    const names = serverIds.map((serverId) => containerNameForServerId(serverId));
    const containers = await docker.listContainers({ all: true });
    const byName = new Map();
    for (const container of containers) {
      const aliases = Array.isArray(container.Names) ? container.Names.map((name) => String(name || "").replace(/^\//, "")) : [];
      for (const alias of aliases) {
        byName.set(alias, container);
      }
    }
    const out = new Map();
    for (const name of names) {
      const container = byName.get(name);
      if (!container) {
        out.set(name, { known: false, running: false, statusText: "not_found" });
      } else {
        out.set(name, {
          known: true,
          running: String(container.State || "").toLowerCase() === "running",
          statusText: String(container.Status || container.State || "unknown"),
        });
      }
    }
    return out;
  } catch {
    const out = new Map();
    for (const serverId of serverIds) {
      const name = containerNameForServerId(serverId);
      out.set(name, { known: false, running: false, statusText: "unavailable" });
    }
    return out;
  }
}

async function discoverServerTools(server, requestHeaders = {}) {
  const cleanHeaders = {};
  for (const [key, value] of Object.entries(requestHeaders || {})) {
    if (!key) continue;
    const val = String(value ?? "").trim();
    if (!val) continue;
    cleanHeaders[key] = val;
  }
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...cleanHeaders,
  };

  const initResponse = await fetch(server.targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "mcp-hosting-platform",
          version: "1.0.0",
        },
      },
    }),
  });
  const initText = await initResponse.text();
  const initPayload = extractJsonRpcPayload(initText);
  const sessionId =
    initResponse.headers.get("mcp-session-id") ||
    initResponse.headers.get("x-mcp-session-id") ||
    initPayload?.result?.sessionId ||
    initPayload?.result?.session_id ||
    cleanHeaders["mcp-session-id"] ||
    cleanHeaders["MCP-Session-Id"] ||
    "";
  const followupHeaders = { ...headers };
  if (sessionId) {
    followupHeaders["mcp-session-id"] = sessionId;
  }

  const toolsResponse = await fetch(server.targetUrl, {
    method: "POST",
    headers: followupHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tools-list",
      method: "tools/list",
      params: {},
    }),
  });
  const toolsText = await toolsResponse.text();
  const toolsPayload = extractJsonRpcPayload(toolsText);
  if (!toolsResponse.ok && !(toolsPayload && toolsPayload.error)) {
    throw new Error(`tools discovery failed with status ${toolsResponse.status}`);
  }
  return {
    serverId: server.id,
    targetUrl: server.targetUrl,
    sessionId: sessionId || null,
    initialize: initPayload,
    toolsList: toolsPayload,
    discoveredAt: new Date().toISOString(),
  };
}

async function buildUsageSummary() {
  const [servers, usageRows, importJobsLast24h, provisioningJobsLast24h] = await Promise.all([
    listServers(),
    listUsageSummaryByServer(),
    countImportJobsSince(24),
    countProvisioningJobsSince(24),
  ]);
  const usageByServerId = new Map(usageRows.map((row) => [row.serverId, row]));
  const serverSummaries = servers.map((server) => {
    const usage = usageByServerId.get(server.id) || { minuteCount: 0, dayCount: 0 };
    return {
      serverId: server.id,
      name: server.name,
      status: server.status,
      minuteCount: usage.minuteCount,
      dayCount: usage.dayCount,
    };
  });
  return {
    totalServers: servers.length,
    healthyServers: servers.filter((server) => server.status === "healthy").length,
    unhealthyServers: servers.filter((server) => server.status === "unhealthy").length,
    requestsToday: serverSummaries.reduce((sum, server) => sum + server.dayCount, 0),
    importJobsLast24h,
    provisioningJobsLast24h,
    servers: serverSummaries,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getLoginRedirectTarget(req) {
  const candidate = String(req.body?.next || req.query?.next || "/dashboard");
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/dashboard";
  return candidate;
}

function renderLoginPage({ nextPath = "/dashboard", error = "", info = "" } = {}) {
  const safeNextPath = escapeHtml(nextPath);
  const errorBanner = error ? `<p style="color:#b00020; margin-bottom: 12px;">${escapeHtml(error)}</p>` : "";
  const infoBanner = info ? `<p style="color:#1a5fb4; margin-bottom: 12px;">${escapeHtml(info)}</p>` : "";
  const loginEnabled = browserLoginEnabled();
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8"/>
      <title>MCP Dashboard Login</title>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <style>
        body { font-family: Arial, sans-serif; background: #f5f6f8; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .card { width: 100%; max-width: 420px; background: #fff; border-radius: 10px; padding: 24px; box-shadow: 0 12px 24px rgba(0, 0, 0, 0.08); }
        h1 { margin-top: 0; }
        label { display: block; margin-bottom: 12px; font-size: 14px; }
        input { box-sizing: border-box; width: 100%; margin-top: 6px; padding: 10px 12px; border: 1px solid #ccd1d7; border-radius: 8px; }
        button { width: 100%; margin-top: 8px; padding: 10px 14px; border: 0; border-radius: 8px; background: #1f6feb; color: #fff; font-weight: 600; cursor: pointer; }
        p.subtle { color: #57606a; font-size: 13px; margin-top: 12px; }
        code { background: #f6f8fa; padding: 2px 4px; border-radius: 4px; }
      </style>
    </head>
    <body>
      <main class="card">
        <h1>Sign in</h1>
        ${errorBanner}
        ${infoBanner}
        ${
          loginEnabled
            ? `<form method="POST" action="/login">
          <input type="hidden" name="next" value="${safeNextPath}"/>
          <label>Email
            <input type="email" name="email" autocomplete="username" required />
          </label>
          <label>Password
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <button type="submit">Sign in</button>
        </form>
        <p class="subtle">If you prefer API auth, you can still use <code>X-API-Key</code> or bearer token headers.</p>`
            : `<p>Browser login is not enabled. Configure <code>WEB_ADMIN_EMAIL</code> and <code>WEB_ADMIN_PASSWORD</code>, then restart the service.</p>`
        }
      </main>
    </body>
  </html>`;
}

const MASK_TOKEN = "__MCP_MASKED__";
const SYSTEM_MANAGED_ENV_KEYS = new Set([
  "HOST",
  "PORT",
  "MCP_HOST",
  "MCP_PORT",
  "MCP_TRANSPORT",
  "MCP_HTTP_HOST",
  "MCP_HTTP_PORT",
  "MCP_HTTP_PATH",
]);

function isSecretLikeKey(key) {
  return /(secret|token|password|private|api[_-]?key)/i.test(String(key || ""));
}

function maskEnvForDisplay(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (isSecretLikeKey(key) && value !== null && value !== undefined && String(value).length > 0) {
      out[key] = MASK_TOKEN;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function editableEnvForDisplay(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (SYSTEM_MANAGED_ENV_KEYS.has(String(key || "").trim().toUpperCase())) continue;
    out[key] = value;
  }
  return out;
}

function parseToolsCountFromMessage(message) {
  const match = String(message || "").match(/tools_count:(\d+)/i);
  return match ? Number(match[1]) : null;
}

app.get("/", (_req, res) => {
  return res.redirect("/dashboard");
});

app.get("/login", async (req, res) => {
  const nextPath = getLoginRedirectTarget(req);
  const existingSession = getBrowserSession(req);
  if (existingSession) return res.redirect(nextPath);
  return res.type("html").send(renderLoginPage({ nextPath }));
});

app.post("/login", async (req, res) => {
  const nextPath = getLoginRedirectTarget(req);
  if (!browserLoginEnabled()) {
    return res.status(503).type("html").send(renderLoginPage({ nextPath, error: "Browser login is not configured." }));
  }
  const email = String(req.body?.email || "");
  const password = String(req.body?.password || "");
  if (!verifyBrowserCredentials(email, password)) {
    authFailuresTotal.labels("web_login_failed").inc();
    return res.status(401).type("html").send(renderLoginPage({ nextPath, error: "Invalid email or password." }));
  }
  const session = createBrowserSession({
    sub: String(email || "").trim().toLowerCase(),
    roles: ["admin", "publisher", "viewer"],
  });
  setBrowserSessionCookie(res, session.token, req);
  return res.redirect(nextPath);
});

app.post("/logout", (req, res) => {
  const session = getBrowserSession(req);
  if (session?.token) clearBrowserSession(session.token);
  clearBrowserSessionCookie(res);
  return res.redirect("/login");
});

app.get("/health", async (_req, res) => {
  const servers = await listServers();
  const healthy = servers.filter((s) => s.status === "healthy").length;
  res.json({ ok: true, timestamp: new Date().toISOString(), totalServers: servers.length, healthyServers: healthy });
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", metricsContentType);
  res.end(await register.metrics());
});

app.get("/mcp/index.json", async (_req, res) => {
  const servers = await listServers();
  res.json({
    updatedAt: new Date().toISOString(),
    servers: servers.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      url: `${PUBLIC_BASE_URL}/mcp/${s.id}`,
      status: s.status,
      requiredHeaders: s.requiredHeaders,
      forwardHeaders: s.forwardHeaders,
      authType: s.authType,
      authInstructions: s.authInstructions,
      docsUrl: s.docsUrl,
      signupUrl: s.signupUrl,
      healthMessage: s.healthMessage,
    })),
  });
});

app.get("/mcp/:serverId/meta.json", async (req, res) => {
  const server = await getServerById(req.params.serverId);
  if (!server) return res.status(404).json({ error: "unknown_server" });
  return res.json({
    id: server.id,
    name: server.name,
    description: server.description,
    url: `${PUBLIC_BASE_URL}/mcp/${server.id}`,
    status: server.status,
    requiredHeaders: server.requiredHeaders,
    forwardHeaders: server.forwardHeaders,
    authType: server.authType,
    authInstructions: server.authInstructions,
    docsUrl: server.docsUrl,
    signupUrl: server.signupUrl,
    healthMessage: server.healthMessage,
    mcpJsonSnippet: JSON.parse(buildCursorSnippet(server, true)),
  });
});

app.get("/registry", async (_req, res) => {
  const servers = await listServers();
  const rows = servers
    .map((s) => {
      const snippet = buildCursorSnippet(s, true);
      const docsLink = s.docsUrl ? `<a href="${escapeHtml(s.docsUrl)}" target="_blank" rel="noreferrer">Docs</a>` : "-";
      const signupLink = s.signupUrl
        ? `<a href="${escapeHtml(s.signupUrl)}" target="_blank" rel="noreferrer">Get credentials</a>`
        : "-";
      return `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td><code>${escapeHtml(`/mcp/${s.id}`)}</code></td>
        <td>${escapeHtml(s.status)}</td>
        <td>${escapeHtml(s.authType || "custom")}<br/><code>${escapeHtml((s.requiredHeaders || []).join(", "))}</code></td>
        <td>${escapeHtml(s.authInstructions || "No specific instructions provided.")}</td>
        <td>${docsLink}</td>
        <td>${signupLink}</td>
        <td><details><summary>Copy mcp.json</summary><pre>${escapeHtml(snippet)}</pre></details></td>
      </tr>`;
    })
    .join("");
  const platformSignup =
    PLATFORM_SIGNUP_URL && PLATFORM_SIGNUP_URL.trim()
      ? `<a href="${escapeHtml(PLATFORM_SIGNUP_URL)}" target="_blank" rel="noreferrer">Get platform access</a>`
      : "";

  res.type("html").send(`<!doctype html>
  <html>
    <head>
      <meta charset="utf-8"/>
      <title>MCP Registry</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 24px; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th, td { text-align: left; border-bottom: 1px solid #ddd; padding: 8px; vertical-align: top; }
        code, pre { background: #f6f8fa; padding: 2px 4px; border-radius: 4px; }
        pre { overflow-x: auto; white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <h1>Hosted MCP Registry</h1>
      <p><strong>Platform auth:</strong> ${escapeHtml(PLATFORM_AUTH_DESCRIPTION)} ${platformSignup}</p>
      <p><strong>Per-MCP auth:</strong> Each server can require additional headers. See the Auth and Instructions columns below.</p>
      <table>
        <thead>
          <tr><th>Name</th><th>Path</th><th>Status</th><th>Auth</th><th>Instructions</th><th>Docs</th><th>Signup</th><th>Snippet</th></tr>
        </thead>
        <tbody>${rows || "<tr><td colspan='8'>No servers published yet.</td></tr>"}</tbody>
      </table>
    </body>
  </html>`);
});

app.get("/api/servers", authenticate, requireRole("viewer", "publisher", "admin"), async (_req, res) => {
  res.json(await listServers());
});

app.post("/admin/servers", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  try {
    const server = await createServer(validateServerInput(req.body || {}), PORT_MIN, PORT_MAX);
    let queuedJobId = null;
    if (req.body.autoStart) {
      const job = await enqueueProvisionAction(req, "start-server", server.id);
      queuedJobId = job.id;
    }
    await writeAudit(req, "server.create", "server", server.id, {
      internalPort: server.internalPort,
      autoStart: Boolean(req.body.autoStart),
      queuedJobId,
    });
    res.status(201).json({ ...server, queuedJobId });
  } catch (error) {
    if (String(error.message).includes("duplicate key value")) {
      return res.status(409).json({ error: "duplicate id or port" });
    }
    return res.status(400).json({ error: String(error.message || error) });
  }
});

app.patch("/admin/servers/:id", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const existing = await getServerById(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  if (req.body.authType !== undefined) {
    const authType = String(req.body.authType || "")
      .trim()
      .toLowerCase();
    if (!["bearer", "api_key", "oauth", "custom", ""].includes(authType)) {
      return res.status(400).json({ error: "authType must be one of: bearer, api_key, oauth, custom" });
    }
  }

  const updates = {
    ...existing,
    ...req.body,
    requiredHeaders: Array.isArray(req.body.requiredHeaders) ? req.body.requiredHeaders : existing.requiredHeaders,
    forwardHeaders: Array.isArray(req.body.forwardHeaders) ? req.body.forwardHeaders : existing.forwardHeaders,
    commandArgs: Array.isArray(req.body.commandArgs) ? req.body.commandArgs : existing.commandArgs,
    commandEnv: req.body.commandEnv && typeof req.body.commandEnv === "object" ? req.body.commandEnv : existing.commandEnv,
    commandEnvSecrets:
      req.body.commandEnvSecrets && typeof req.body.commandEnvSecrets === "object"
        ? req.body.commandEnvSecrets
        : existing.commandEnvSecrets,
    authInstructions:
      req.body.authInstructions !== undefined ? String(req.body.authInstructions || "").trim() || null : existing.authInstructions,
    docsUrl: req.body.docsUrl !== undefined ? String(req.body.docsUrl || "").trim() || null : existing.docsUrl,
    authType:
      req.body.authType !== undefined
        ? String(req.body.authType || "")
            .trim()
            .toLowerCase() || null
        : existing.authType,
    signupUrl: req.body.signupUrl !== undefined ? String(req.body.signupUrl || "").trim() || null : existing.signupUrl,
  };
  const updated = await updateServer(req.params.id, updates);
  await writeAudit(req, "server.update", "server", req.params.id, { fields: Object.keys(req.body || {}) });
  return res.json(updated);
});

app.delete("/admin/servers/:id", authenticate, requireRole("admin"), async (req, res) => {
  const job = await enqueueProvisionAction(req, "stop-server", req.params.id);
  const ok = await deleteServer(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  await writeAudit(req, "server.delete", "server", req.params.id, { queuedJobId: job.id });
  return res.json({ ok: true, queuedJobId: job.id });
});

app.post("/admin/servers/:id/start", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const server = await getServerById(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  const job = await enqueueProvisionAction(req, "start-server", req.params.id);
  await writeAudit(req, "server.start.queued", "server", req.params.id, { queuedJobId: job.id });
  return res.status(202).json({ ok: true, queuedJobId: job.id, status: "queued" });
});

app.post("/admin/servers/:id/stop", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const job = await enqueueProvisionAction(req, "stop-server", req.params.id);
  await writeAudit(req, "server.stop.queued", "server", req.params.id, { queuedJobId: job.id });
  return res.status(202).json({ ok: true, queuedJobId: job.id, status: "queued" });
});

app.patch("/admin/servers/:id/config", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const existing = await getServerById(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const updates = {
    ...existing,
    commandEnv: req.body.commandEnv && typeof req.body.commandEnv === "object" ? req.body.commandEnv : existing.commandEnv,
    commandEnvSecrets:
      req.body.commandEnvSecrets && typeof req.body.commandEnvSecrets === "object"
        ? req.body.commandEnvSecrets
        : existing.commandEnvSecrets,
    requiredHeaders: Array.isArray(req.body.requiredHeaders) ? req.body.requiredHeaders : existing.requiredHeaders,
    forwardHeaders: Array.isArray(req.body.forwardHeaders) ? req.body.forwardHeaders : existing.forwardHeaders,
    authType:
      req.body.authType !== undefined
        ? String(req.body.authType || "")
            .trim()
            .toLowerCase() || null
        : existing.authType,
    authInstructions:
      req.body.authInstructions !== undefined ? String(req.body.authInstructions || "").trim() || null : existing.authInstructions,
  };
  const updated = await updateServer(req.params.id, updates);
  await writeAudit(req, "server.config.update", "server", req.params.id, { fields: Object.keys(req.body || {}) });
  return res.json(updated);
});

app.post("/admin/servers/:id/restart", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const server = await getServerById(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  const recreate = req.body?.recreate !== false;
  const forcePull = req.body?.forcePull === true;
  const stopJob = await enqueueProvisionAction(req, "stop-server", req.params.id);
  const startJob = await enqueueProvisionAction(req, "start-server", req.params.id, {
    recreate,
    forcePull,
  });
  await writeAudit(req, "server.restart.queued", "server", req.params.id, {
    stopQueuedJobId: stopJob.id,
    startQueuedJobId: startJob.id,
    recreate,
    forcePull,
  });
  return res.status(202).json({
    ok: true,
    status: "queued",
    stopQueuedJobId: stopJob.id,
    startQueuedJobId: startJob.id,
    recreate,
    forcePull,
  });
});

app.post("/api/servers/:id/discover-tools", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  try {
    const server = await getServerById(req.params.id);
    if (!server) return res.status(404).json({ error: "not found" });
    const requestHeaders = req.body && typeof req.body.headers === "object" ? req.body.headers : {};
    const result = await discoverServerTools(server, requestHeaders);
    const toolsPayload = result.toolsList || {};
    if (toolsPayload.error) {
      await setServerToolsCheck(server.id, "failed", String(toolsPayload.error.message || "tools_list_error"));
    } else {
      const toolsCount = Array.isArray(toolsPayload?.result?.tools) ? toolsPayload.result.tools.length : 0;
      await setServerToolsCheck(server.id, "passed", `tools_count:${toolsCount}`);
    }
    return res.json(result);
  } catch (error) {
    try {
      await setServerToolsCheck(req.params.id, "failed", String(error.message || error));
    } catch {
      // ignore secondary write errors
    }
    return res.status(400).json({ error: "tools_discovery_failed", message: String(error.message || error) });
  }
});

app.get("/api/audit-logs", authenticate, requireRole("admin"), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const logs = await listAuditLogs(limit);
  return res.json(logs);
});

app.get("/api/provisioning-jobs", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const jobs = await listProvisioningJobs(limit);
  return res.json(jobs);
});

app.post("/admin/import-repo", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const rateLimitResponse = enforceImportRateLimit(req, res);
  if (rateLimitResponse) return;
  try {
    const payload = normalizeImportRequest(req.body || {});
    const job = await enqueueProvisionJob(
      "import-repo",
      {
        githubUrl: payload.githubUrl,
        branch: payload.branch,
        subdir: payload.subdir,
        serverId: payload.serverId,
        autoStart: payload.autoStart,
      },
      {
        actorSub: req.auth.sub,
        actorRoles: req.auth.roles,
      },
    );
    await createProvisioningJobRecord(
      job.id,
      "import-repo",
      payload.serverId,
      "queued",
      {
        githubUrl: payload.githubUrl,
        branch: payload.branch,
        subdir: payload.subdir,
        serverId: payload.serverId,
        autoStart: payload.autoStart,
      },
      {
        actorSub: req.auth.sub,
        actorRoles: req.auth.roles,
      },
    );
    await createImportJobRecord(
      job.id,
      payload.githubUrl,
      payload.branch,
      payload.subdir,
      payload.serverId,
      "queued",
      {
        githubUrl: payload.githubUrl,
        branch: payload.branch,
        subdir: payload.subdir,
        serverId: payload.serverId,
        autoStart: payload.autoStart,
        actorSub: req.auth.sub,
        actorRoles: req.auth.roles,
      },
    );
    await writeAudit(req, "repo.import.queued", "import_job", String(job.id), {
      githubUrl: payload.githubUrl,
      branch: payload.branch,
      subdir: payload.subdir,
      serverId: payload.serverId,
      autoStart: payload.autoStart,
    });
    return res.status(201).json({
      importJobId: String(job.id),
      serverId: payload.serverId,
      status: "queued",
    });
  } catch (error) {
    if (String(error.message).includes("duplicate key value")) {
      return res.status(409).json({ error: "duplicate id or port" });
    }
    return res.status(400).json({ error: String(error.message || error) });
  }
});

app.get("/api/import-jobs", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const jobs = await listImportJobs(limit);
  return res.json(jobs);
});

app.get("/api/import-jobs/:id", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const job = await getImportJobById(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  return res.json(job);
});

app.get("/api/usage/current", authenticate, requireRole("admin"), async (req, res) => {
  const serverId = String(req.query.serverId || "").trim();
  if (!serverId) return res.status(400).json({ error: "serverId query param is required" });
  const sub = String(req.query.sub || req.auth.sub || "");
  const tenant = String(req.query.tenant || "default");
  const counterKey = `${tenant}:${sub}`;
  const minuteCount = await getRequestCount(counterKey, serverId, "minute");
  const dayCount = await getRequestCount(counterKey, serverId, "day");
  return res.json({
    counterKey,
    serverId,
    minuteCount,
    dayCount,
    limits: {
      perMinute: REQUESTS_PER_MINUTE_PER_SUB,
      perDay: REQUESTS_PER_DAY_PER_SUB,
    },
  });
});

app.get("/api/usage/summary", authenticate, requireRole("publisher", "admin"), async (_req, res) => {
  return res.json(await buildUsageSummary());
});

app.get("/api/analytics/summary", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours || 24)));
  return res.json(await getAnalyticsSummary(hours));
});

app.get("/api/analytics/top-servers", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours || 24)));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
  return res.json({ hours, limit, servers: await getTopServersAnalytics(hours, limit) });
});

app.post("/admin/analytics/retention", authenticate, requireRole("admin"), async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.body?.days || 30)));
  const deleted = await cleanupRequestEventsOlderThan(days);
  await writeAudit(req, "analytics.retention.cleanup", "request_events", "request_events", { days, deleted });
  return res.json({ ok: true, days, deleted });
});

app.get("/api/auth/whoami", authenticate, async (req, res) => {
  res.json({
    sub: req.auth.sub,
    roles: req.auth.roles,
    authType: req.auth.authType,
    jwtEnabled: jwtEnabled(),
  });
});

app.use("/mcp/:serverId", authenticate, requireRole("viewer", "publisher", "admin"), async (req, res) => {
  const server = await getServerById(req.params.serverId);
  if (!server) return res.status(404).json({ error: "unknown_server", message: `No MCP server '${req.params.serverId}'` });

  const quotaResponse = await enforceUsageQuota(req, res, server.id);
  if (quotaResponse) return;
  const proxyStart = process.hrtime.bigint();
  let finalStatusCode = 502;

  const upstreamUrl = new URL(`${server.targetUrl}${req.url || ""}`);
  const headers = {
    ...sanitizeForwardHeaders(req.headers, server),
    "x-forwarded-host": req.get("host") || "",
    "x-forwarded-proto": req.protocol,
    accept: ensureStreamAccept(req.get("accept")),
    "content-type": req.get("content-type") || "application/json",
  };

  const body = req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body ?? {}) : undefined;

  try {
    activeStreamsGauge.inc();
    const upstream = await fetch(upstreamUrl, { method: req.method, headers, body });
    finalStatusCode = upstream.status;
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "transfer-encoding") res.setHeader(key, value);
    });
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    mcpProxyRequestsTotal.labels(server.id, upstream.ok ? "ok" : "error").inc();
    return res.end();
  } catch (error) {
    finalStatusCode = 502;
    mcpProxyRequestsTotal.labels(server.id, "error").inc();
    return res.status(502).json({ error: "upstream_error", message: String(error.message || error) });
  } finally {
    const latencyMs = Number(process.hrtime.bigint() - proxyStart) / 1e6;
    mcpProxyStatusCodeTotal.labels(server.id, String(finalStatusCode)).inc();
    mcpProxyLatencyMs.labels(server.id, String(finalStatusCode)).observe(latencyMs);
    try {
      await insertRequestEvent({
        serverId: server.id,
        tenantId: String(req.get("x-tenant-id") || "default"),
        actorSub: String(req.auth?.sub || "anonymous"),
        clientIp: getClientIp(req),
        method: req.method,
        requestPath: req.originalUrl || req.url || "/",
        statusCode: finalStatusCode,
        latencyMs,
      });
    } catch (error) {
      logger.warn({ err: String(error.message || error), serverId: server.id }, "request event write failed");
    }
    activeStreamsGauge.dec();
  }
});

function renderDashboardNav(active, canManage) {
  const links = [`<a class="${active === "overview" ? "active" : ""}" href="/dashboard">Overview</a>`];
  if (canManage) {
    links.push(`<a class="${active === "analytics" ? "active" : ""}" href="/dashboard/analytics">Analytics</a>`);
    links.push(`<a class="${active === "logs" ? "active" : ""}" href="/dashboard/logs">Logs</a>`);
    links.push(`<a class="${active === "import" ? "active" : ""}" href="/dashboard/import">Import</a>`);
  }
  return links.join("");
}

function renderDashboardPage({ title, active, canManage, req, content, scriptData = null, includeScript = false }) {
  const roles = req.auth.roles || [];
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8"/>
      <title>${escapeHtml(title)}</title>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <link rel="stylesheet" href="/dashboard/assets/dashboard.css"/>
    </head>
    <body>
      <main class="dashboard-shell">
        <header class="dashboard-header">
          <div>
            <h1>MCP Hosting Dashboard</h1>
            <p class="subtle">Public base URL: <code>${escapeHtml(PUBLIC_BASE_URL)}</code></p>
            <p class="subtle">Signed in as <code>${escapeHtml(req.auth.sub)}</code> (${escapeHtml(roles.join(", "))}) via ${escapeHtml(req.auth.authType)}</p>
          </div>
          <div>
            <a class="button-link" href="/metrics">Advanced metrics</a>
            <form method="POST" action="/logout" style="display:inline;">
              <button class="button-link" type="submit">Sign out</button>
            </form>
          </div>
        </header>
        <nav class="dashboard-nav">${renderDashboardNav(active, canManage)}</nav>
        ${content}
      </main>
      <div id="toast" class="toast"></div>
      ${scriptData ? `<script>window.DASHBOARD_DATA = ${JSON.stringify(scriptData)};</script>` : ""}
      ${includeScript ? `<script src="/dashboard/assets/dashboard.js" defer></script>` : ""}
    </body>
  </html>`;
}

app.get("/dashboard", authenticate, requireRole("viewer", "publisher", "admin"), async (req, res) => {
  const servers = await listServers();
  const roles = req.auth.roles || [];
  const canManage = roles.some((role) => ["publisher", "admin"].includes(role));
  const isAdmin = roles.includes("admin");
  const [usageSummary, lastRequestRows, containerStateByName] = await Promise.all([
    canManage ? buildUsageSummary() : Promise.resolve(null),
    listServerLastRequestAt(),
    getContainerRunningMap(servers.map((server) => server.id)),
  ]);
  const lastRequestByServerId = new Map(lastRequestRows.map((row) => [row.serverId, row.lastRequestAt]));
  const snippets = Object.fromEntries(servers.map((server) => [server.id, buildCursorSnippet(server, true)]));
  const serverEnvJson = Object.fromEntries(
    servers.map((server) => [server.id, JSON.stringify(maskEnvForDisplay(editableEnvForDisplay(server.commandEnv || {})), null, 2)]),
  );
  const serverEnvSecretsJson = Object.fromEntries(
    servers.map((server) => [server.id, JSON.stringify(server.commandEnvSecrets || {}, null, 2)]),
  );
  const serverCards = servers
    .map((server) => {
      const status = String(server.status || "unknown").toLowerCase();
      const required = (server.requiredHeaders || []).join(", ") || "-";
      const forwarded = (server.forwardHeaders || []).join(", ") || "-";
      const usage = usageSummary?.servers?.find((item) => item.serverId === server.id) || { minuteCount: 0, dayCount: 0 };
      const containerState = containerStateByName.get(containerNameForServerId(server.id)) || {
        known: false,
        running: false,
        statusText: "unknown",
      };
      const healthPass = String(server.status || "").toLowerCase() === "healthy";
      const toolsPass = String(server.toolsCheckStatus || "").toLowerCase() === "passed";
      const toolsCount = parseToolsCountFromMessage(server.toolsCheckMessage);
      const lastToolsCheck = server.lastToolsCheck ? new Date(server.lastToolsCheck).toISOString() : null;
      const toolsStatusLabel = toolsPass ? "pass" : String(server.toolsCheckStatus || "unknown");
      const toolsMetaLabel = toolsPass
        ? `${toolsCount ?? "unknown"} tools${lastToolsCheck ? ` • ${lastToolsCheck}` : ""}`
        : `not successful yet${lastToolsCheck ? ` • ${lastToolsCheck}` : ""}`;
      const primaryActionButton =
        status === "healthy" || status === "unknown"
          ? `<button type="button" onclick="runServerAction('stop', '${escapeHtml(server.id)}')">Stop</button>`
          : `<button type="button" onclick="runServerAction('start', '${escapeHtml(server.id)}')">Start</button>`;
      const adminActions = isAdmin
        ? `<button type="button" class="danger" onclick="runServerAction('delete', '${escapeHtml(server.id)}')">Delete</button>`
        : "";

      return `<article class="server-card" data-name="${escapeHtml(server.name.toLowerCase())}" data-id="${escapeHtml(
        server.id.toLowerCase(),
      )}" data-status="${escapeHtml(status)}" id="server-card-${escapeHtml(server.id)}">
        <div class="server-card-header">
          <div>
            <h3>${escapeHtml(server.name)}</h3>
            <div class="server-path"><code>/mcp/${escapeHtml(server.id)}</code></div>
          </div>
          <div class="server-header-actions">
            <span id="status-badge-${escapeHtml(server.id)}" class="status-badge status-${status}">${escapeHtml(status)}</span>
          </div>
        </div>
        <div class="server-meta">
          <div class="readiness-row">
            <span class="meta-pill"><strong>Container</strong>: ${containerState.running ? "ok" : escapeHtml(containerState.statusText)}</span>
            <span class="meta-pill"><strong>Health</strong>: ${healthPass ? "pass" : "fail"}</span>
            <span class="meta-pill"><strong>Tools</strong>: <span id="tools-status-${escapeHtml(server.id)}">${escapeHtml(toolsStatusLabel)}</span></span>
            <span class="meta-pill"><strong>Today</strong>: ${usage.dayCount}</span>
          </div>
          <div class="meta-row">${usage.minuteCount} this minute • ${usage.dayCount} today</div>
        </div>
        ${
          canManage
            ? `<div class="server-actions">
          ${primaryActionButton.replace("<button", '<button class="primary-action"')}
          <button type="button" class="secondary-action" onclick="copySnippet('${escapeHtml(server.id)}')">Copy mcp.json</button>
        </div>`
            : ""
        }
        <details>
          <summary>Details</summary>
          <div class="meta-row"><strong>Last request</strong>: ${escapeHtml(lastRequestByServerId.get(server.id) || "none")}</div>
          <div class="meta-row" id="tools-meta-${escapeHtml(server.id)}">Tool discovery: ${escapeHtml(toolsMetaLabel)}</div>
          <div class="meta-row">Forwarded headers: <code>${escapeHtml(forwarded)}</code></div>
          ${required !== "-" ? `<div class="meta-row">Required headers: <code>${escapeHtml(required)}</code></div>` : ""}
          <p>${escapeHtml(server.authInstructions || "No specific auth instructions provided.")}</p>
          <pre id="snippet-${escapeHtml(server.id)}">${escapeHtml(snippets[server.id])}</pre>
          ${
            canManage
              ? `<div class="server-actions">
            <button type="button" onclick="restartServer('${escapeHtml(server.id)}')">Restart</button>
            <button type="button" onclick="testConnection('${escapeHtml(server.id)}')">Test connection</button>
            ${adminActions}
          </div>
          <div class="config-grid">
            <div>
              <label>Env JSON
                <textarea id="env-${escapeHtml(server.id)}" rows="6">${escapeHtml(serverEnvJson[server.id])}</textarea>
              </label>
            </div>
            <div>
              <label>Env Secrets JSON
                <textarea id="envSecrets-${escapeHtml(server.id)}" rows="6">${escapeHtml(serverEnvSecretsJson[server.id])}</textarea>
              </label>
            </div>
          </div>
          <div class="config-grid">
            <div>
              <label>Required headers (csv)
                <input id="requiredHeaders-${escapeHtml(server.id)}" value="${escapeHtml((server.requiredHeaders || []).join(", "))}"/>
              </label>
            </div>
            <div>
              <label>Optional forwarded headers (csv)
                <input id="forwardHeaders-${escapeHtml(server.id)}" value="${escapeHtml((server.forwardHeaders || []).join(", "))}"/>
              </label>
            </div>
          </div>
          <p class="subtle">Only user-editable env vars are shown here. Runtime keys (host/port/transport) are managed by the platform. Keep <code>${escapeHtml(MASK_TOKEN)}</code> to preserve existing secret values.</p>
          <div class="server-actions">
            <button type="button" onclick="saveServerConfig('${escapeHtml(server.id)}')">Save config</button>
            <button type="button" onclick="discoverTools('${escapeHtml(server.id)}')">Discover tools</button>
          </div>
          <pre id="tools-${escapeHtml(server.id)}">No discovery yet.</pre>`
              : ""
          }
        </details>
      </article>`;
    })
    .join("");
  const healthyCount = servers.filter((server) => String(server.status || "").toLowerCase() === "healthy").length;
  const summaryItems = [
    `<span><strong>${servers.length}</strong> servers</span>`,
    `<span><strong>${healthyCount}</strong> healthy</span>`,
    canManage && usageSummary ? `<span><strong>${usageSummary.requestsToday}</strong> requests today</span>` : "",
    canManage && usageSummary ? `<span><strong>${usageSummary.provisioningJobsLast24h}</strong> jobs (24h)</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const content = `<section class="panel summary-strip">${summaryItems}</section>
      <section class="panel">
        <div class="section-title-row">
          <h2>Hosted Servers</h2>
          ${
            canManage
              ? `<div class="section-actions">
            <a class="button-link" href="/dashboard/import">Import from GitHub</a>
            <a class="button-link" href="/dashboard/logs">View logs</a>
          </div>`
              : ""
          }
        </div>
        <div class="toolbar">
          <input id="serverSearch" placeholder="Search by name or id" oninput="applyServerFilters()"/>
          <select id="serverStatusFilter" onchange="applyServerFilters()">
            <option value="">All statuses</option>
            <option value="healthy">Healthy</option>
            <option value="unhealthy">Unhealthy</option>
            <option value="unknown">Unknown</option>
          </select>
          <div class="view-toggle" role="group" aria-label="Server layout">
            <button type="button" class="view-toggle-btn active" data-server-view="cards" onclick="setServerView('cards')">Cards</button>
            <button type="button" class="view-toggle-btn" data-server-view="list" onclick="setServerView('list')">List</button>
          </div>
        </div>
        <section class="server-grid">
          ${serverCards || "<div class='empty-state'>No servers registered.</div>"}
        </section>
      </section>`;
  res.type("html").send(
    renderDashboardPage({
      title: "MCP Hosting Dashboard",
      active: "overview",
      canManage,
      req,
      content,
      scriptData: { snippets, maskToken: MASK_TOKEN },
      includeScript: true,
    }),
  );
});

app.get("/dashboard/analytics", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const roles = req.auth.roles || [];
  const canManage = roles.some((role) => ["publisher", "admin"].includes(role));
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours || 24)));
  const [usageSummary, analyticsSummary, topServersAnalytics] = await Promise.all([
    buildUsageSummary(),
    getAnalyticsSummary(hours),
    getTopServersAnalytics(hours, 12),
  ]);
  const usageRows = (usageSummary?.servers || [])
    .map(
      (server) => `<tr>
      <td>${escapeHtml(server.name)}</td>
      <td><code>${escapeHtml(server.serverId)}</code></td>
      <td>${escapeHtml(server.status)}</td>
      <td class="num">${server.minuteCount}</td>
      <td class="num">${server.dayCount}</td>
    </tr>`,
    )
    .join("");
  const topServerMax = Math.max(1, ...topServersAnalytics.map((row) => row.requestCount || 0));
  const topServerRows = topServersAnalytics
    .map(
      (row) => `<tr>
      <td><code>${escapeHtml(row.serverId)}</code></td>
      <td>
        <div class="bar-wrap"><div class="bar-fill" style="width:${Math.max(4, Math.round((row.requestCount / topServerMax) * 100))}%"></div></div>
        <div class="num">${row.requestCount}</div>
      </td>
      <td class="num">${row.p95LatencyMs.toFixed(1)} ms</td>
      <td class="num">${row.errorRatePct.toFixed(2)}%</td>
    </tr>`,
    )
    .join("");
  const topActorsRows = (analyticsSummary?.topActors || [])
    .map((row) => `<tr><td>${escapeHtml(row.actorSub)}</td><td class="num">${row.requestCount}</td></tr>`)
    .join("");
  const topIpsRows = (analyticsSummary?.topIps || [])
    .map((row) => `<tr><td><code>${escapeHtml(row.clientIp)}</code></td><td class="num">${row.requestCount}</td></tr>`)
    .join("");
  const content = `<section class="panel">
      <div class="section-title-row">
        <h2>Analytics</h2>
        <form method="GET" action="/dashboard/analytics" class="inline-form">
          <label>Range
            <select name="hours">
              <option value="24" ${hours === 24 ? "selected" : ""}>24h</option>
              <option value="168" ${hours === 168 ? "selected" : ""}>7d</option>
              <option value="720" ${hours === 720 ? "selected" : ""}>30d</option>
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Total requests</div><div class="stat-value">${analyticsSummary.totalRequests}</div></div>
        <div class="stat-card"><div class="stat-label">p95 latency</div><div class="stat-value">${analyticsSummary.p95LatencyMs.toFixed(1)} ms</div></div>
        <div class="stat-card"><div class="stat-label">Error rate</div><div class="stat-value">${analyticsSummary.errorRatePct.toFixed(2)}%</div></div>
        <div class="stat-card"><div class="stat-label">Unique servers</div><div class="stat-value">${analyticsSummary.uniqueServers}</div></div>
      </div>
    </section>
    <section class="panel">
      <h3>Usage by server</h3>
      <table>
        <thead><tr><th>Name</th><th>Server ID</th><th>Status</th><th class="num">Minute</th><th class="num">Today</th></tr></thead>
        <tbody>${usageRows || "<tr><td colspan='5'>No usage data yet.</td></tr>"}</tbody>
      </table>
    </section>
    <section class="panel">
      <h3>Top servers by traffic</h3>
      <table>
        <thead><tr><th>Server</th><th>Requests</th><th class="num">P95</th><th class="num">Error rate</th></tr></thead>
        <tbody>${topServerRows || "<tr><td colspan='4'>No request events yet.</td></tr>"}</tbody>
      </table>
    </section>
    <section class="panel split-grid">
      <div>
        <h3>Top actors</h3>
        <table>
          <thead><tr><th>Actor</th><th class="num">Requests</th></tr></thead>
          <tbody>${topActorsRows || "<tr><td colspan='2'>No actor data yet.</td></tr>"}</tbody>
        </table>
      </div>
      <div>
        <h3>Top IPs</h3>
        <table>
          <thead><tr><th>Client IP</th><th class="num">Requests</th></tr></thead>
          <tbody>${topIpsRows || "<tr><td colspan='2'>No IP data yet.</td></tr>"}</tbody>
        </table>
      </div>
    </section>`;

  res.type("html").send(
    renderDashboardPage({
      title: "MCP Hosting Analytics",
      active: "analytics",
      canManage,
      req,
      content,
    }),
  );
});

app.get("/dashboard/import", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const roles = req.auth.roles || [];
  const canManage = roles.some((role) => ["publisher", "admin"].includes(role));
  const content = `<section class="panel">
      <h2>Import from GitHub</h2>
      <p class="subtle">Use this workflow to register and optionally auto-start a hosted MCP server from a public repository.</p>
      <p class="subtle">This page now keeps import output visible after completion/failure so you can troubleshoot without being redirected.</p>
      <div class="split-grid">
        <div>
          <label>GitHub URL
            <input id="importGithubUrl" placeholder="https://github.com/owner/repo"/>
          </label>
        </div>
      </div>
      <details>
        <summary>Advanced import options</summary>
        <div class="split-grid">
          <div><label>Branch (optional)<input id="importBranch" placeholder="main"/></label></div>
          <div><label>Subdir (optional)<input id="importSubdir" placeholder="packages/mcp-server"/></label></div>
          <div><label>Server ID (optional)<input id="importServerId" placeholder="auto-derived if empty"/></label></div>
          <div><label>Auto-start <input id="importAutoStart" type="checkbox" checked/></label></div>
        </div>
      </details>
      <div class="server-actions">
        <button type="button" onclick="importRepo()">Import GitHub repo</button>
      </div>
      <pre id="importResult">No import submitted yet. Job output will stay here.</pre>
      <p class="subtle">Need historical jobs? Open <a href="/dashboard/logs">Logs</a>.</p>
    </section>`;
  res.type("html").send(
    renderDashboardPage({
      title: "MCP Hosting Import",
      active: "import",
      canManage,
      req,
      content,
      includeScript: true,
    }),
  );
});

app.get("/dashboard/logs", authenticate, requireRole("publisher", "admin"), async (req, res) => {
  const roles = req.auth.roles || [];
  const canManage = roles.some((role) => ["publisher", "admin"].includes(role));
  const isAdmin = roles.includes("admin");
  const [jobs, importJobs, auditLogs] = await Promise.all([
    listProvisioningJobs(100),
    listImportJobs(100),
    isAdmin ? listAuditLogs(100) : Promise.resolve([]),
  ]);
  const jobRows = jobs
    .map(
      (job) => `<tr data-log-row="provisioning" data-search="${escapeHtml(
        `${job.createdAt || ""} ${job.id || ""} ${job.action || ""} ${job.serverId || ""} ${job.status || ""}`.toLowerCase(),
      )}" data-action="${escapeHtml(String(job.action || "").toLowerCase())}" data-status="${escapeHtml(
        String(job.status || "").toLowerCase(),
      )}">
      <td>${escapeHtml(job.createdAt || "-")}</td>
      <td>${escapeHtml(job.id)}</td>
      <td>${escapeHtml(job.action)}</td>
      <td>${escapeHtml(job.serverId || "-")}</td>
      <td>${escapeHtml(job.status)}</td>
    </tr>`,
    )
    .join("");
  const importRows = importJobs
    .map(
      (job) => `<tr data-log-row="import" data-search="${escapeHtml(
        `${job.createdAt || ""} ${job.id || ""} ${job.serverId || ""} ${job.status || ""} ${job.githubUrl || ""}`.toLowerCase(),
      )}" data-status="${escapeHtml(String(job.status || "").toLowerCase())}">
      <td>${escapeHtml(job.createdAt || "-")}</td>
      <td>${escapeHtml(job.id)}</td>
      <td>${escapeHtml(job.serverId || "-")}</td>
      <td>${escapeHtml(job.status)}</td>
      <td><code>${escapeHtml(job.githubUrl || "-")}</code></td>
    </tr>`,
    )
    .join("");
  const auditRows = auditLogs
    .map(
      (log) => `<tr data-log-row="audit" data-search="${escapeHtml(
        `${log.createdAt || ""} ${log.actorSub || ""} ${(log.actorRoles || []).join(" ")} ${log.action || ""} ${
          log.resourceType || ""
        } ${log.resourceId || ""}`.toLowerCase(),
      )}" data-action="${escapeHtml(String(log.action || "").toLowerCase())}">
      <td>${escapeHtml(log.createdAt || "-")}</td>
      <td>${escapeHtml(log.actorSub || "-")}</td>
      <td>${escapeHtml((log.actorRoles || []).join(", "))}</td>
      <td>${escapeHtml(log.action || "-")}</td>
      <td>${escapeHtml(`${log.resourceType || "-"}:${log.resourceId || "-"}`)}</td>
    </tr>`,
    )
    .join("");
  const content = `<section class="panel">
      <div class="section-title-row">
        <h2>Logs</h2>
        <div class="section-actions logs-section-tabs">
          <button type="button" class="logs-tab active" data-log-tab="all" onclick="showLogSection('all')">All sections</button>
          <button type="button" class="logs-tab" data-log-tab="provisioning" onclick="showLogSection('provisioning')">Provisioning</button>
          <button type="button" class="logs-tab" data-log-tab="import" onclick="showLogSection('import')">Import</button>
          ${isAdmin ? `<button type="button" class="logs-tab" data-log-tab="audit" onclick="showLogSection('audit')">Audit</button>` : ""}
        </div>
      </div>
      <p class="subtle">Use section tabs plus search and filters to quickly narrow long log tables.</p>
    </section>
    <section class="panel" data-log-section="provisioning">
      <h2>Provisioning Jobs (${jobs.length})</h2>
      <div class="toolbar">
        <input id="provisioningSearch" placeholder="Search provisioning logs" oninput="applyProvisioningLogFilters()"/>
        <select id="provisioningActionFilter" onchange="applyProvisioningLogFilters()">
          <option value="">All actions</option>
          <option value="start-server">start-server</option>
          <option value="stop-server">stop-server</option>
          <option value="import-repo">import-repo</option>
        </select>
        <select id="provisioningStatusFilter" onchange="applyProvisioningLogFilters()">
          <option value="">All statuses</option>
          <option value="queued">queued</option>
          <option value="running">running</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
        </select>
      </div>
      <table>
        <thead><tr><th>Created</th><th>Job ID</th><th>Action</th><th>Server</th><th>Status</th></tr></thead>
        <tbody>${jobRows || "<tr><td colspan='5'>No jobs yet.</td></tr>"}</tbody>
      </table>
      <p id="provisioningEmptyState" class="subtle" style="display:none;">No provisioning jobs match the current filters.</p>
    </section>
    <section class="panel" data-log-section="import">
      <h2>Import Jobs (${importJobs.length})</h2>
      <div class="toolbar">
        <input id="importLogSearch" placeholder="Search import logs" oninput="applyImportLogFilters()"/>
        <select id="importLogStatusFilter" onchange="applyImportLogFilters()">
          <option value="">All statuses</option>
          <option value="queued">queued</option>
          <option value="running">running</option>
          <option value="completed">completed</option>
          <option value="awaiting_config">awaiting_config</option>
          <option value="failed">failed</option>
        </select>
      </div>
      <table>
        <thead><tr><th>Created</th><th>Job ID</th><th>Server</th><th>Status</th><th>Repo</th></tr></thead>
        <tbody>${importRows || "<tr><td colspan='5'>No import jobs yet.</td></tr>"}</tbody>
      </table>
      <p id="importEmptyState" class="subtle" style="display:none;">No import jobs match the current filters.</p>
    </section>
    ${
      isAdmin
        ? `<section class="panel" data-log-section="audit">
      <h2>Recent Audit Logs (${auditLogs.length})</h2>
      <div class="toolbar">
        <input id="auditLogSearch" placeholder="Search audit logs" oninput="applyAuditLogFilters()"/>
        <input id="auditActionFilter" placeholder="Filter by action (e.g. queue.stop-server)" oninput="applyAuditLogFilters()"/>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Actor</th><th>Roles</th><th>Action</th><th>Resource</th></tr></thead>
        <tbody>${auditRows || "<tr><td colspan='5'>No logs yet.</td></tr>"}</tbody>
      </table>
      <p id="auditEmptyState" class="subtle" style="display:none;">No audit logs match the current filters.</p>
    </section>`
        : ""
    }`;
  res.type("html").send(
    renderDashboardPage({
      title: "MCP Hosting Logs",
      active: "logs",
      canManage,
      req,
      content,
      includeScript: true,
    }),
  );
});

async function runHealthChecks() {
  const servers = await listServers();
  for (const server of servers) {
    try {
      const response = await fetch(`${server.targetUrl}${server.healthPath || "/health"}`, { method: "GET" });
      if (response.status < 500) {
        await updateServerHealth(server.id, "healthy", `HTTP ${response.status}`);
      } else {
        await updateServerHealth(server.id, "unhealthy", `HTTP ${response.status}`);
      }
    } catch (error) {
      await updateServerHealth(server.id, "unhealthy", String(error.message || error));
    }
  }
}

async function bootstrap() {
  await migrate();
  await runHealthChecks();
  setInterval(
    () =>
      runHealthChecks().catch((error) => {
        logger.error({ err: error.message }, "health check failed");
      }),
    HEALTH_INTERVAL_MS,
  );
  app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT, logLevel: LOG_LEVEL }, "MCP hosting platform listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error.message }, "Bootstrap failed");
  process.exit(1);
});
