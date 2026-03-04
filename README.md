# MCP Hosting Platform

Multi-tenant MCP hosting control plane for Ubuntu EC2:

- Public URL pattern: `${PUBLIC_BASE_URL}/mcp/{UNIQUE_SOLUTION}`
- Internal port-per-MCP (default pool `30001-30200`)
- Platform auth (`X-API-Key` or bearer) and allowlisted header forwarding
- Postgres-backed registry + Admin API + Health checker + Dashboard
- Redis/BullMQ provisioning queue + Docker-backed runtime worker
- OIDC/JWT auth + RBAC (`admin`, `publisher`, `viewer`) + audit logs
- Quota metering (`request_counters`) with per-minute/per-day enforcement
- Prometheus metrics + structured logs + optional OpenTelemetry tracing
- Secret references via AWS SSM/Secrets Manager (`commandEnvSecrets`)
- Public registry and metadata endpoints with auth requirements per MCP
- Nginx reverse proxy config tuned for streamable HTTP/SSE-like responses

## Architecture

```mermaid
flowchart TB
  User[Cursor / Agent] --> Proxy[Nginx reverse proxy]
  Proxy --> Platform[MCP Platform service]
  Platform --> Registry[(Postgres registry)]
  Platform --> Backends[MCP backend services by internal ports]
  Platform --> Dash[Dashboard + index]
```

## Quick Start (Local)

1. Install dependencies:
   - `npm install`
2. Start platform:
   - `npm run start`
3. Open:
   - `http://127.0.0.1:8080/dashboard`
   - `http://127.0.0.1:8080/mcp/index.json`
4. Register sample backend:
   - `POST /admin/servers` with id `echo`, target `http://127.0.0.1:30001`
   - Start it with `POST /admin/servers/echo/start`

## Environment Variables

- `PORT` (default `8080`)
- `HOST` (default `0.0.0.0`)
- `PUBLIC_BASE_URL` public base URL shown in snippets/index
- `PLATFORM_AUTH_DESCRIPTION` platform auth guidance shown on `/registry`
- `PLATFORM_SIGNUP_URL` optional link where users get platform access
- `PLATFORM_API_KEYS` comma-separated keys for platform auth
- `JWT_ISSUER` expected JWT issuer
- `JWT_AUDIENCE` expected JWT audience
- `JWT_JWKS_URI` OIDC JWKS endpoint (for RS256/ES256 validation)
- `JWT_HS256_SECRET` shared secret alternative for HS256 tokens
- `JWT_ROLES_CLAIM` claim name that contains user roles (default `roles`)
- `DATABASE_URL` Postgres connection URL
- `REDIS_URL` Redis connection URL for provisioning queue
- `PROVISIONING_QUEUE_NAME` BullMQ queue name
- `IMPORT_JOB_TIMEOUT_MS` timeout for `import-repo` jobs (default `600000`)
- `IMPORT_FETCH_TIMEOUT_MS` timeout for GitHub tarball download per attempted branch (`45000` default)
- `IMPORT_FETCH_STREAM_TIMEOUT_MS` timeout for tarball body streaming inactivity (`45000` default)
- `IMPORT_FETCH_TOTAL_TIMEOUT_MS` hard cap for full tarball download duration (`180000` default)
- `IMPORT_FETCH_MAX_BYTES` hard cap for tarball size in bytes (`262144000` default = 250MB)
- `GITHUB_TOKEN` optional GitHub token for higher API rate limits during repo import
- `DOCKER_SOCKET` Docker socket path for worker (`/var/run/docker.sock`)
- `DOCKER_NETWORK` container network mode for launched MCP containers
- `DOCKER_IMAGE_PULL` whether to pull image before start
- `REQUESTS_PER_MINUTE_PER_SUB` per-tenant+subject minute quota
- `REQUESTS_PER_DAY_PER_SUB` per-tenant+subject day quota
- `IMPORT_REQUESTS_PER_MINUTE` per-subject import request rate limit (`5` default, `0` disables)
- `LOG_LEVEL` structured log level (`info` by default)
- `OTEL_ENABLED` enable OpenTelemetry (`true` / `false`)
- `OTEL_EXPORTER_OTLP_ENDPOINT` OTLP exporter endpoint
- `AWS_REGION` region for SSM/Secrets Manager secret resolution
- `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` (compose defaults)
- `PORT_MIN` / `PORT_MAX` internal port allocation range
- `HEALTH_INTERVAL_MS` periodic health check interval

## Core Endpoints

- `GET /health` overall platform status
- `GET /metrics` Prometheus metrics endpoint
- `GET /mcp/index.json` public index of hosted MCPs
- `GET /mcp/:serverId/meta.json` public metadata (auth docs + snippet) for one MCP
- `GET /registry` public HTML registry with auth requirements and snippets
- `GET /dashboard` hosted MCP list + copyable mcp.json snippets
- `GET /api/servers` authenticated server list
- `GET /api/auth/whoami` inspect resolved subject/roles for current token
- `GET /api/audit-logs` recent admin audit events (`admin` role)
- `GET /api/provisioning-jobs` recent queued start/stop jobs
- `GET /api/import-jobs` recent GitHub import jobs
- `GET /api/import-jobs/:id` import job status/result for polling
- `GET /api/usage/current?serverId=...` current minute/day counter for a subject (`admin` role)
- `GET /api/usage/summary` aggregate per-server minute/day usage + health and 24h job counts (`publisher`/`admin`)
- `GET /api/analytics/summary?hours=24` request-event analytics summary (actors, tenants, IPs, latency, error rate)
- `GET /api/analytics/top-servers?hours=24&limit=10` top MCP routes by request volume and quality
- `POST /admin/servers` create and register MCP server
- `POST /admin/import-repo` queue a GitHub repo import (`githubUrl`, optional `branch/subdir/serverId`, `autoStart`)
- `PATCH /admin/servers/:id` update metadata/header policy
- `DELETE /admin/servers/:id` remove server
- `POST /admin/servers/:id/start` start managed process
- `POST /admin/servers/:id/stop` stop managed process
- `POST /admin/servers/:id/restart` restart server (`{ "recreate": true, "forcePull": false }` supported)
- `POST /admin/analytics/retention` cleanup old request events (`admin` role, body `{ "days": 30 }`)
- `ALL /mcp/:serverId` and `ALL /mcp/:serverId/*` proxied MCP calls
- `GET /dashboard` includes GitHub import, server actions (start/stop/delete), snippets, and collapsible jobs/audit sections

## Public Registry and Auth Requirements

- Visit `GET /registry` for a public list of hosted MCPs.
- Platform-level auth guidance is rendered from:
  - `PLATFORM_AUTH_DESCRIPTION`
  - `PLATFORM_SIGNUP_URL` (optional)
- Per-MCP auth details come from each server definition:
  - `requiredHeaders`
  - `authType`
  - `authInstructions`
  - `docsUrl`
  - `signupUrl`
- For per-server deep links, use `GET /mcp/:serverId/meta.json`.

## Add a New Hosted MCP

Use the admin endpoint (or `scripts/register-server.ps1`):

```powershell
.\scripts\register-server.ps1 `
  -Id "n8n" `
  -Name "n8n MCP" `
  -Description "Hosted n8n MCP endpoint" `
  -TargetUrl "http://127.0.0.1:30020" `
  -RequiredHeaders @("Authorization") `
  -ForwardHeaders @("authorization","x-tenant-id") `
  -ApiKey "<PLATFORM_KEY>"
```

The platform allocates an internal port if `TargetUrl` / `internalPort` is omitted.

## Cursor `mcp.json` Example

See `examples/cursor.mcp.json`:

```json
{
  "mcpServers": {
    "echoHosted": {
      "url": "https://mcp.your-real-domain.com/mcp/echo",
      "headers": {
        "X-API-Key": "<PLATFORM_KEY>",
        "Authorization": "Bearer <UPSTREAM_USER_TOKEN>"
      }
    }
  }
}
```

## Deployment (Ubuntu EC2)

### Option A: Docker Compose

1. Copy repo to `/opt/mcp-servers`.
2. Copy `.env.example` to `.env` and set real values:
   - `PUBLIC_BASE_URL=https://mcp.your-real-domain.com`
   - `DATABASE_URL=postgres://postgres:postgres@postgres:5432/mcp_hosting`
   - `PLATFORM_API_KEYS=key1,key2`
3. Run:
   - `docker compose up -d --build`
4. Optional legacy import:
   - `npm run migrate:json -- ./data/servers.json`
5. Nginx config:
   - `deploy/nginx/nginx.conf`
   - `deploy/nginx/conf.d/mcp-platform.conf`
6. Add certs in `deploy/nginx/certs` (or use certbot on host and mount cert paths).

This launches:

- `mcp-platform` (API/gateway)
- `mcp-worker` (queue worker that starts/stops Docker containers for MCP servers)
- `postgres` (registry + audit + job records)
- `redis` (queue broker)
- `nginx` (edge proxy)

When registering a server:

- `command` should be a Docker image (e.g. `ghcr.io/your-org/my-mcp:latest`)
- `commandArgs` are passed as container `Cmd`
- `commandEnv` becomes container env vars (plus `PORT`)
- `commandEnvSecrets` supports secret refs:
  - `ssm:///path/to/parameter`
  - `secretsmanager://secret-id`
  - `secretsmanager://secret-id#jsonKey`
- `authType` can be `bearer`, `api_key`, `oauth`, or `custom`
- `authInstructions` tells users exactly how to obtain credentials and format headers
- `docsUrl` and `signupUrl` are shown publicly in `/registry` and `/mcp/index.json`
- start/stop is async and returns `queuedJobId`

### Option B: systemd + host nginx

1. Copy service file `deploy/systemd/mcp-platform.service` to `/etc/systemd/system/`.
   - Also copy `deploy/systemd/mcp-worker.service` for async provisioning.
2. Add env file `/etc/mcp-platform.env`:
   - `PLATFORM_API_KEYS=...`
   - `REDIS_URL=redis://127.0.0.1:6379`
   - `DATABASE_URL=postgres://...`
3. Start service:
   - `sudo systemctl daemon-reload`
   - `sudo systemctl enable --now mcp-platform`
   - `sudo systemctl enable --now mcp-worker`
4. Apply nginx vhost from `deploy/systemd/nginx-mcp.conf.example`.

## Security/Operations Checklist

- Keep MCP backends bound to `127.0.0.1` or private network only.
- Use HTTPS at edge, rotate keys, and log request IDs.
- Use per-path/per-key rate limits at Nginx or gateway.
- Keep forwarding policy allowlist-only to avoid credential leaks.
- Add central logs + metrics before scaling to 100-200 servers.

## Auth + RBAC Quick Setup

Roles are read from your JWT claim (default claim: `roles`):

- `viewer`: can browse dashboard and use hosted MCP routes
- `publisher`: can create/update/start/stop MCP servers
- `admin`: full control including delete + audit logs

Example `.env` for OIDC/JWKS validation:

```env
JWT_ISSUER=https://YOUR_AUTH_DOMAIN/
JWT_AUDIENCE=mcp-platform-api
JWT_JWKS_URI=https://YOUR_AUTH_DOMAIN/.well-known/jwks.json
JWT_ROLES_CLAIM=roles
```

For local testing only, you can still use `PLATFORM_API_KEYS` fallback.

## GitOps Onboarding

Store MCP definitions in `servers/*.yaml`.

- Validate manifests locally:
  - `npm run gitops:validate`
- Submit manifests to platform API:
  - `ADMIN_API_BASE_URL=https://mcp.your-real-domain.com ADMIN_API_KEY=... npm run gitops:submit`
- CI workflow:
  - `.github/workflows/gitops-onboarding.yml`
  - PRs validate manifests
  - push to `main` validates then submits manifests to `/admin/servers`

See sample manifest: `servers/example-echo.yaml`.

## Queue + Docker Runtime Notes

- `POST /admin/servers/:id/start` and `POST /admin/servers/:id/stop` now return `202` with `queuedJobId`.
- Worker consumes queue jobs and manages containers named `mcp-server-{id}`.
- Check progress with `GET /api/provisioning-jobs`.
- For GitHub ingest flow, call `POST /admin/import-repo` and poll `GET /api/import-jobs/:id` until `completed`/`failed`.
- Import pipeline is resilient: it first attempts the repository `Dockerfile` when present, and automatically retries with a generated runtime Dockerfile when the repo Docker build fails.
- If runtime files are not found at repo root, import also auto-detects a likely nested subdirectory (for monorepo-style layouts) and proceeds from there.
- Provisioning/import queue jobs now use unique IDs (UUID-based) to avoid stale status/result collisions after Redis restarts.

## Operations and Scaling

- API/proxy nodes are stateless; scale horizontally behind a load balancer.
- Shared state lives in Postgres (`servers`, jobs, audit, request counters) and Redis (BullMQ queue).
- Run multiple workers (`npm run worker`) for higher start/stop/import throughput.
- Use connection pooling (for example PgBouncer) as API/worker replica count grows.
- Back up Postgres regularly and document restore procedures for your environment.
- Keep queue/job tables bounded (periodic cleanup of old `provisioning_jobs`/`import_jobs` rows).
- Clean up unused local Docker images periodically to recover disk on worker hosts.
- Server removal flow is: `POST /admin/servers/:id/stop` (optional) then `DELETE /admin/servers/:id`.

## Analytics, Alerts, and Retention

- The proxy now writes per-request events to Postgres (`request_events`) with server id, tenant id, actor sub, client IP, status code, path, and latency.
- Prometheus now includes per-server proxy latency histogram and per-server status-code counters:
  - `mcp_platform_mcp_proxy_latency_ms{server_id,status_code}`
  - `mcp_platform_mcp_proxy_status_code_total{server_id,status_code}`
- Dashboard includes an analytics block for:
  - request volume
  - p95 latency
  - error rate
  - unique actors/tenants/IPs
  - top servers by traffic
- Suggested Grafana panels:
  - Requests/sec by `server_id`
  - p95 latency by `server_id`
  - 4xx/5xx rate by `server_id`
  - active streams over time
  - top actors/tenants (from `/api/analytics/summary`)
- Suggested alerts:
  - p95 latency > 2000ms for 5m
  - error rate > 5% for 5m
  - unhealthy servers > 0 for 10m
  - auth failures spike > baseline
- Retention:
  - run `POST /admin/analytics/retention` with `{"days":30}` daily (cron/job scheduler)
  - keep high-cardinality raw events shorter than aggregate counters

## Smoke Test

Run smoke checks locally:

```bash
npm test
```

Run against a deployed instance:

```bash
BASE_URL=https://mcp.your-real-domain.com API_KEY=<PLATFORM_KEY> MCP_SERVER_ID=echo node scripts/smoke-test.js
```

`MCP_SERVER_ID` is optional; when set, the smoke test also checks the MCP proxy path and asserts it does not return `502`.
