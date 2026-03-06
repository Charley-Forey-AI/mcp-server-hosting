require("dotenv").config();

const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Example: postgres://postgres:postgres@localhost:5432/mcp_hosting");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      internal_port INTEGER NOT NULL UNIQUE,
      target_url TEXT NOT NULL,
      health_path TEXT NOT NULL DEFAULT '/health',
      required_headers JSONB NOT NULL DEFAULT '["Authorization"]'::jsonb,
      forward_headers JSONB NOT NULL DEFAULT '["authorization"]'::jsonb,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_health_check TIMESTAMPTZ NULL,
      health_message TEXT NOT NULL DEFAULT 'pending',
      command TEXT NULL,
      command_args JSONB NOT NULL DEFAULT '[]'::jsonb,
      command_env JSONB NOT NULL DEFAULT '{}'::jsonb,
      command_env_secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
      auth_instructions TEXT NULL,
      docs_url TEXT NULL,
      auth_type TEXT NULL,
      signup_url TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS command_env_secrets JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS auth_instructions TEXT NULL;`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS docs_url TEXT NULL;`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS auth_type TEXT NULL;`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS signup_url TEXT NULL;`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS last_tools_check TIMESTAMPTZ NULL;`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS tools_check_status TEXT NOT NULL DEFAULT 'unknown';`);
  await pool.query(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS tools_check_message TEXT NOT NULL DEFAULT 'not_checked';`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_sub TEXT NOT NULL,
      actor_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NULL,
      request_path TEXT NOT NULL,
      method TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS provisioning_jobs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      server_id TEXT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY,
      github_url TEXT NOT NULL,
      branch TEXT NULL,
      subdir TEXT NULL,
      server_id TEXT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS request_counters (
      counter_key TEXT NOT NULL,
      server_id TEXT NOT NULL,
      window_type TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      request_count BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (counter_key, server_id, window_type, window_start)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS request_events (
      id BIGSERIAL PRIMARY KEY,
      server_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_sub TEXT NOT NULL DEFAULT 'anonymous',
      client_ip TEXT NULL,
      method TEXT NOT NULL,
      request_path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_request_events_created_at ON request_events (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_request_events_server_id ON request_events (server_id, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_request_events_actor_sub ON request_events (actor_sub, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_request_events_tenant_id ON request_events (tenant_id, created_at DESC);`);
}

function toServer(row) {
  const blockedRequiredHeaders = new Set(["x-api-key", "x-platform-api-key", "x-portkey-api-key"]);
  const requiredHeaders = (row.required_headers || []).filter(
    (header) => !blockedRequiredHeaders.has(String(header || "").trim().toLowerCase()),
  );
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    internalPort: row.internal_port,
    targetUrl: row.target_url,
    healthPath: row.health_path,
    requiredHeaders,
    forwardHeaders: row.forward_headers || [],
    status: row.status,
    lastHealthCheck: row.last_health_check ? new Date(row.last_health_check).toISOString() : null,
    healthMessage: row.health_message,
    command: row.command,
    commandArgs: row.command_args || [],
    commandEnv: row.command_env || {},
    commandEnvSecrets: row.command_env_secrets || {},
    authInstructions: row.auth_instructions,
    docsUrl: row.docs_url,
    authType: row.auth_type,
    signupUrl: row.signup_url,
    lastToolsCheck: row.last_tools_check ? new Date(row.last_tools_check).toISOString() : null,
    toolsCheckStatus: row.tools_check_status || "unknown",
    toolsCheckMessage: row.tools_check_message || "not_checked",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function listServers() {
  const { rows } = await pool.query("SELECT * FROM servers ORDER BY created_at DESC");
  return rows.map(toServer);
}

async function getServerById(id) {
  const { rows } = await pool.query("SELECT * FROM servers WHERE id = $1", [id]);
  if (!rows[0]) return null;
  return toServer(rows[0]);
}

async function nextFreePort(portMin, portMax) {
  const { rows } = await pool.query(
    "SELECT internal_port FROM servers WHERE internal_port BETWEEN $1 AND $2",
    [portMin, portMax],
  );
  const inUse = new Set(rows.map((r) => Number(r.internal_port)));
  for (let p = portMin; p <= portMax; p += 1) {
    if (!inUse.has(p)) return p;
  }
  throw new Error(`no free ports in range ${portMin}-${portMax}`);
}

async function createServer(input, portMin, portMax) {
  const assignedPort = input.internalPort || (await nextFreePort(portMin, portMax));
  const targetUrl = input.targetUrl || `http://127.0.0.1:${assignedPort}`;

  const { rows } = await pool.query(
    `INSERT INTO servers (
      id, name, description, internal_port, target_url, health_path,
      required_headers, forward_headers, status, last_health_check,
      health_message, command, command_args, command_env, command_env_secrets,
      auth_instructions, docs_url, auth_type, signup_url
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7::jsonb, $8::jsonb, 'unknown', NULL,
      'pending', $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16
    )
    RETURNING *`,
    [
      input.id,
      input.name,
      input.description,
      assignedPort,
      targetUrl,
      input.healthPath,
      JSON.stringify(input.requiredHeaders),
      JSON.stringify(input.forwardHeaders),
      input.command,
      JSON.stringify(input.commandArgs),
      JSON.stringify(input.commandEnv),
      JSON.stringify(input.commandEnvSecrets || {}),
      input.authInstructions || null,
      input.docsUrl || null,
      input.authType || null,
      input.signupUrl || null,
    ],
  );

  return toServer(rows[0]);
}

async function updateServer(id, updates) {
  const { rows } = await pool.query(
    `UPDATE servers SET
      name = $2,
      description = $3,
      target_url = $4,
      health_path = $5,
      required_headers = $6::jsonb,
      forward_headers = $7::jsonb,
      command = $8,
      command_args = $9::jsonb,
      command_env = $10::jsonb,
      command_env_secrets = $11::jsonb,
      auth_instructions = $12,
      docs_url = $13,
      auth_type = $14,
      signup_url = $15,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *`,
    [
      id,
      updates.name,
      updates.description,
      updates.targetUrl,
      updates.healthPath,
      JSON.stringify(updates.requiredHeaders),
      JSON.stringify(updates.forwardHeaders),
      updates.command,
      JSON.stringify(updates.commandArgs),
      JSON.stringify(updates.commandEnv),
      JSON.stringify(updates.commandEnvSecrets || {}),
      updates.authInstructions || null,
      updates.docsUrl || null,
      updates.authType || null,
      updates.signupUrl || null,
    ],
  );

  if (!rows[0]) return null;
  return toServer(rows[0]);
}

async function deleteServer(id) {
  const { rowCount } = await pool.query("DELETE FROM servers WHERE id = $1", [id]);
  return rowCount > 0;
}

async function updateServerHealth(id, status, message) {
  await pool.query(
    `UPDATE servers
     SET status = $2, health_message = $3, last_health_check = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [id, status, message],
  );
}

async function clearAllServers() {
  await pool.query("DELETE FROM servers");
}

async function insertAuditLog(entry) {
  await pool.query(
    `INSERT INTO audit_logs (
      actor_sub, actor_roles, action, resource_type, resource_id,
      request_path, method, metadata
    ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      entry.actorSub,
      JSON.stringify(entry.actorRoles || []),
      entry.action,
      entry.resourceType,
      entry.resourceId || null,
      entry.requestPath,
      entry.method,
      JSON.stringify(entry.metadata || {}),
    ],
  );
}

async function listAuditLogs(limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, actor_sub, actor_roles, action, resource_type, resource_id,
            request_path, method, metadata, created_at
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    actorSub: r.actor_sub,
    actorRoles: r.actor_roles || [],
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    requestPath: r.request_path,
    method: r.method,
    metadata: r.metadata || {},
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
}

async function createProvisioningJobRecord(id, action, serverId, status, payload = {}, meta = {}) {
  await pool.query(
    `INSERT INTO provisioning_jobs (id, action, server_id, status, payload, meta, result)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '{}'::jsonb)
     ON CONFLICT (id)
     DO UPDATE SET
       action = EXCLUDED.action,
       server_id = EXCLUDED.server_id,
       status = EXCLUDED.status,
       payload = EXCLUDED.payload,
       meta = EXCLUDED.meta,
       result = '{}'::jsonb,
       created_at = NOW(),
       updated_at = NOW()`,
    [String(id), action, serverId || null, status, JSON.stringify(payload), JSON.stringify(meta)],
  );
}

async function setProvisioningJobStatus(id, status, result = {}) {
  await pool.query(
    `UPDATE provisioning_jobs
     SET status = $2, result = $3::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [String(id), status, JSON.stringify(result)],
  );
}

async function listProvisioningJobs(limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, action, server_id, status, payload, meta, result, created_at, updated_at
     FROM provisioning_jobs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    serverId: r.server_id,
    status: r.status,
    payload: r.payload || {},
    meta: r.meta || {},
    result: r.result || {},
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }));
}

async function createImportJobRecord(id, githubUrl, branch, subdir, serverId, status, payload = {}) {
  await pool.query(
    `INSERT INTO import_jobs (id, github_url, branch, subdir, server_id, status, payload, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '{}'::jsonb)
     ON CONFLICT (id)
     DO UPDATE SET
       github_url = EXCLUDED.github_url,
       branch = EXCLUDED.branch,
       subdir = EXCLUDED.subdir,
       server_id = EXCLUDED.server_id,
       status = EXCLUDED.status,
       payload = EXCLUDED.payload,
       result = '{}'::jsonb,
       created_at = NOW(),
       updated_at = NOW()`,
    [String(id), githubUrl, branch || null, subdir || null, serverId || null, status, JSON.stringify(payload)],
  );
}

async function updateImportJobStatus(id, status, result = {}, serverId = null) {
  await pool.query(
    `UPDATE import_jobs
     SET status = $2,
         result = $3::jsonb,
         server_id = COALESCE($4, server_id),
         updated_at = NOW()
     WHERE id = $1`,
    [String(id), status, JSON.stringify(result), serverId],
  );
}

async function getImportJobById(id) {
  const { rows } = await pool.query(
    `SELECT id, github_url, branch, subdir, server_id, status, payload, result, created_at, updated_at
     FROM import_jobs
     WHERE id = $1`,
    [String(id)],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    githubUrl: r.github_url,
    branch: r.branch,
    subdir: r.subdir,
    serverId: r.server_id,
    status: r.status,
    payload: r.payload || {},
    result: r.result || {},
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

async function listImportJobs(limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, github_url, branch, subdir, server_id, status, payload, result, created_at, updated_at
     FROM import_jobs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    githubUrl: r.github_url,
    branch: r.branch,
    subdir: r.subdir,
    serverId: r.server_id,
    status: r.status,
    payload: r.payload || {},
    result: r.result || {},
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }));
}

function getWindowStart(windowType, now = new Date()) {
  const date = new Date(now);
  if (windowType === "minute") {
    date.setUTCSeconds(0, 0);
    return date;
  }
  if (windowType === "day") {
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }
  throw new Error(`unsupported window type '${windowType}'`);
}

async function incrementAndGetRequestCount(counterKey, serverId, windowType) {
  const windowStart = getWindowStart(windowType);
  const { rows } = await pool.query(
    `INSERT INTO request_counters (counter_key, server_id, window_type, window_start, request_count, updated_at)
     VALUES ($1, $2, $3, $4, 1, NOW())
     ON CONFLICT (counter_key, server_id, window_type, window_start)
     DO UPDATE SET request_count = request_counters.request_count + 1, updated_at = NOW()
     RETURNING request_count`,
    [counterKey, serverId, windowType, windowStart.toISOString()],
  );
  return Number(rows[0].request_count);
}

async function getRequestCount(counterKey, serverId, windowType) {
  const windowStart = getWindowStart(windowType);
  const { rows } = await pool.query(
    `SELECT request_count
     FROM request_counters
     WHERE counter_key = $1 AND server_id = $2 AND window_type = $3 AND window_start = $4`,
    [counterKey, serverId, windowType, windowStart.toISOString()],
  );
  return rows[0] ? Number(rows[0].request_count) : 0;
}

async function setServerToolsCheck(serverId, status, message = "") {
  await pool.query(
    `UPDATE servers
     SET tools_check_status = $2,
         tools_check_message = $3,
         last_tools_check = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [serverId, status, String(message || "").slice(0, 2000)],
  );
}

async function listServerLastRequestAt() {
  const { rows } = await pool.query(
    `SELECT server_id, MAX(updated_at) AS last_request_at
     FROM request_counters
     GROUP BY server_id`,
  );
  return rows.map((row) => ({
    serverId: row.server_id,
    lastRequestAt: row.last_request_at ? new Date(row.last_request_at).toISOString() : null,
  }));
}

async function insertRequestEvent(event) {
  await pool.query(
    `INSERT INTO request_events (
      server_id, tenant_id, actor_sub, client_ip, method, request_path, status_code, latency_ms
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.serverId,
      event.tenantId || "default",
      event.actorSub || "anonymous",
      event.clientIp || null,
      event.method,
      event.requestPath,
      Number(event.statusCode),
      Number(event.latencyMs),
    ],
  );
}

async function getAnalyticsSummary(hours = 24) {
  const horizon = Math.max(1, Number(hours || 24));
  const { rows } = await pool.query(
    `WITH filtered AS (
       SELECT *
       FROM request_events
       WHERE created_at >= NOW() - make_interval(hours => $1::int)
     )
     SELECT
       COUNT(*)::bigint AS total_requests,
       COUNT(DISTINCT server_id)::bigint AS unique_servers,
       COUNT(DISTINCT actor_sub)::bigint AS unique_actors,
       COUNT(DISTINCT tenant_id)::bigint AS unique_tenants,
       COUNT(DISTINCT client_ip)::bigint AS unique_ips,
       COALESCE(AVG(latency_ms), 0)::double precision AS avg_latency_ms,
       COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::double precision AS p95_latency_ms,
       COALESCE(
         100.0 * SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)::double precision / NULLIF(COUNT(*), 0),
         0
       )::double precision AS error_rate_pct
     FROM filtered`,
    [horizon],
  );
  const base = rows[0] || {};

  const topActors = await pool.query(
    `SELECT actor_sub, COUNT(*)::bigint AS request_count
     FROM request_events
     WHERE created_at >= NOW() - make_interval(hours => $1::int)
     GROUP BY actor_sub
     ORDER BY request_count DESC
     LIMIT 10`,
    [horizon],
  );
  const topIps = await pool.query(
    `SELECT client_ip, COUNT(*)::bigint AS request_count
     FROM request_events
     WHERE created_at >= NOW() - make_interval(hours => $1::int)
       AND client_ip IS NOT NULL
       AND client_ip <> ''
     GROUP BY client_ip
     ORDER BY request_count DESC
     LIMIT 10`,
    [horizon],
  );
  return {
    hours: horizon,
    totalRequests: Number(base.total_requests || 0),
    uniqueServers: Number(base.unique_servers || 0),
    uniqueActors: Number(base.unique_actors || 0),
    uniqueTenants: Number(base.unique_tenants || 0),
    uniqueIps: Number(base.unique_ips || 0),
    avgLatencyMs: Number(base.avg_latency_ms || 0),
    p95LatencyMs: Number(base.p95_latency_ms || 0),
    errorRatePct: Number(base.error_rate_pct || 0),
    topActors: topActors.rows.map((row) => ({ actorSub: row.actor_sub, requestCount: Number(row.request_count || 0) })),
    topIps: topIps.rows.map((row) => ({ clientIp: row.client_ip, requestCount: Number(row.request_count || 0) })),
  };
}

async function getTopServersAnalytics(hours = 24, limit = 10) {
  const horizon = Math.max(1, Number(hours || 24));
  const topLimit = Math.min(100, Math.max(1, Number(limit || 10)));
  const { rows } = await pool.query(
    `SELECT
       server_id,
       COUNT(*)::bigint AS request_count,
       COUNT(DISTINCT actor_sub)::bigint AS unique_actors,
       COUNT(DISTINCT tenant_id)::bigint AS unique_tenants,
       COALESCE(AVG(latency_ms), 0)::double precision AS avg_latency_ms,
       COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::double precision AS p95_latency_ms,
       COALESCE(
         100.0 * SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)::double precision / NULLIF(COUNT(*), 0),
         0
       )::double precision AS error_rate_pct
     FROM request_events
     WHERE created_at >= NOW() - make_interval(hours => $1::int)
     GROUP BY server_id
     ORDER BY request_count DESC
     LIMIT $2`,
    [horizon, topLimit],
  );
  return rows.map((row) => ({
    serverId: row.server_id,
    requestCount: Number(row.request_count || 0),
    uniqueActors: Number(row.unique_actors || 0),
    uniqueTenants: Number(row.unique_tenants || 0),
    avgLatencyMs: Number(row.avg_latency_ms || 0),
    p95LatencyMs: Number(row.p95_latency_ms || 0),
    errorRatePct: Number(row.error_rate_pct || 0),
  }));
}

async function cleanupRequestEventsOlderThan(days = 30) {
  const retentionDays = Math.max(1, Number(days || 30));
  const { rowCount } = await pool.query(
    `DELETE FROM request_events
     WHERE created_at < NOW() - make_interval(days => $1::int)`,
    [retentionDays],
  );
  return rowCount || 0;
}

async function listUsageSummaryByServer() {
  const minuteWindowStart = getWindowStart("minute").toISOString();
  const dayWindowStart = getWindowStart("day").toISOString();
  const { rows } = await pool.query(
    `SELECT
       server_id,
       COALESCE(SUM(request_count) FILTER (WHERE window_type = 'minute' AND window_start = $1), 0)::bigint AS minute_count,
       COALESCE(SUM(request_count) FILTER (WHERE window_type = 'day' AND window_start = $2), 0)::bigint AS day_count
     FROM request_counters
     GROUP BY server_id`,
    [minuteWindowStart, dayWindowStart],
  );
  return rows.map((row) => ({
    serverId: row.server_id,
    minuteCount: Number(row.minute_count || 0),
    dayCount: Number(row.day_count || 0),
  }));
}

async function countProvisioningJobsSince(hours = 24) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS count
     FROM provisioning_jobs
     WHERE created_at >= NOW() - make_interval(hours => $1::int)`,
    [Number(hours)],
  );
  return Number(rows[0]?.count || 0);
}

async function countImportJobsSince(hours = 24) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS count
     FROM import_jobs
     WHERE created_at >= NOW() - make_interval(hours => $1::int)`,
    [Number(hours)],
  );
  return Number(rows[0]?.count || 0);
}

module.exports = {
  pool,
  migrate,
  listServers,
  getServerById,
  nextFreePort,
  createServer,
  updateServer,
  deleteServer,
  updateServerHealth,
  clearAllServers,
  insertAuditLog,
  listAuditLogs,
  createProvisioningJobRecord,
  setProvisioningJobStatus,
  listProvisioningJobs,
  createImportJobRecord,
  updateImportJobStatus,
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
};
