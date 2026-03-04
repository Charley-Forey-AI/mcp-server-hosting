const client = require("prom-client");

client.collectDefaultMetrics({ prefix: "mcp_platform_" });

const httpRequestDurationMs = new client.Histogram({
  name: "mcp_platform_http_request_duration_ms",
  help: "HTTP request duration in ms",
  labelNames: ["method", "route", "status_code"],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const httpRequestsTotal = new client.Counter({
  name: "mcp_platform_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
});

const mcpProxyRequestsTotal = new client.Counter({
  name: "mcp_platform_mcp_proxy_requests_total",
  help: "Total proxied MCP requests",
  labelNames: ["server_id", "status"],
});

const mcpProxyStatusCodeTotal = new client.Counter({
  name: "mcp_platform_mcp_proxy_status_code_total",
  help: "Total proxied MCP responses by status code",
  labelNames: ["server_id", "status_code"],
});

const mcpProxyLatencyMs = new client.Histogram({
  name: "mcp_platform_mcp_proxy_latency_ms",
  help: "Latency of proxied MCP requests in ms",
  labelNames: ["server_id", "status_code"],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const authFailuresTotal = new client.Counter({
  name: "mcp_platform_auth_failures_total",
  help: "Total authentication/authorization failures",
  labelNames: ["reason"],
});

const activeStreamsGauge = new client.Gauge({
  name: "mcp_platform_active_streams",
  help: "Current active MCP proxied streams",
});

const quotaBlocksTotal = new client.Counter({
  name: "mcp_platform_quota_blocks_total",
  help: "Total requests blocked by quota limits",
  labelNames: ["window_type", "server_id"],
});

function requestMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const route = (req.route && req.route.path) || (req.baseUrl && req.baseUrl.length ? req.baseUrl : req.path) || "unknown";
    const statusCode = String(res.statusCode);
    httpRequestDurationMs.labels(req.method, route, statusCode).observe(durationMs);
    httpRequestsTotal.labels(req.method, route, statusCode).inc();
  });
  next();
}

module.exports = {
  register: client.register,
  metricsContentType: client.register.contentType,
  requestMetricsMiddleware,
  mcpProxyRequestsTotal,
  mcpProxyStatusCodeTotal,
  mcpProxyLatencyMs,
  authFailuresTotal,
  activeStreamsGauge,
  quotaBlocksTotal,
};
