const assert = require("assert");

async function run() {
  const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
  const apiKey = process.env.API_KEY || "";
  const mcpServerId = process.env.MCP_SERVER_ID || "";
  const authHeaders = apiKey ? { "x-api-key": apiKey } : {};

  const healthRes = await fetch(`${baseUrl}/health`);
  assert.strictEqual(typeof healthRes.status, "number");
  assert.strictEqual(healthRes.ok, true, `health endpoint failed with ${healthRes.status}`);
  const healthJson = await healthRes.json();
  assert.strictEqual(healthJson.ok, true, "health payload missing ok=true");

  const indexRes = await fetch(`${baseUrl}/mcp/index.json`, { headers: authHeaders });
  assert.strictEqual(indexRes.ok, true, `index endpoint failed with ${indexRes.status}`);
  const indexJson = await indexRes.json();
  assert.ok(Array.isArray(indexJson.servers), "index payload missing servers array");

  if (apiKey) {
    const whoamiRes = await fetch(`${baseUrl}/api/auth/whoami`, { headers: authHeaders });
    assert.strictEqual(whoamiRes.ok, true, `whoami failed with ${whoamiRes.status}`);
  }

  if (mcpServerId) {
    const mcpRes = await fetch(`${baseUrl}/mcp/${encodeURIComponent(mcpServerId)}`, {
      headers: {
        accept: "application/json, text/event-stream",
        ...authHeaders,
      },
    });
    assert.notStrictEqual(mcpRes.status, 502, "MCP proxy returned 502");
  }

  console.log(`Smoke check completed for ${baseUrl}.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
