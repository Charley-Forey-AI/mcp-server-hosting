const express = require("express");

const app = express();
const port = Number(process.env.PORT || 30001);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "echo-mcp" }));

app.get("/", (_req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.write("event: message\n");
  res.write(`data: ${JSON.stringify({ message: "stream started" })}\n\n`);
  setTimeout(() => res.end(), 250);
});

app.post("/", (req, res) => {
  res.json({
    ok: true,
    transport: "streamable-http-compatible",
    received: req.body,
    headers: {
      authorization: req.get("authorization") ? "present" : "missing",
      tenant: req.get("x-tenant-id") || null,
      user: req.get("x-user-id") || null,
    },
  });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Echo MCP listening on 127.0.0.1:${port}`);
});
