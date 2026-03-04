const fs = require("fs");
const path = require("path");
const { migrate, createServer } = require("../src/db");

const PORT_MIN = Number(process.env.PORT_MIN || 30001);
const PORT_MAX = Number(process.env.PORT_MAX || 30200);
const sourcePath = process.argv[2] || path.join(__dirname, "..", "data", "servers.json");

async function run() {
  if (!fs.existsSync(sourcePath)) {
    console.log(`No legacy JSON found at ${sourcePath}; skipping.`);
    return;
  }

  const raw = fs.readFileSync(sourcePath, "utf8");
  const parsed = JSON.parse(raw);
  const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
  await migrate();

  for (const server of servers) {
    try {
      await createServer(
        {
          id: server.id,
          name: server.name || server.id,
          description: server.description || "",
          internalPort: Number(server.internalPort),
          targetUrl: server.targetUrl,
          healthPath: server.healthPath || "/health",
          requiredHeaders: Array.isArray(server.requiredHeaders) ? server.requiredHeaders : ["Authorization"],
          forwardHeaders: Array.isArray(server.forwardHeaders) ? server.forwardHeaders : ["authorization"],
          command: server.command || null,
          commandArgs: Array.isArray(server.commandArgs) ? server.commandArgs : [],
          commandEnv: server.commandEnv && typeof server.commandEnv === "object" ? server.commandEnv : {},
          commandEnvSecrets:
            server.commandEnvSecrets && typeof server.commandEnvSecrets === "object" ? server.commandEnvSecrets : {},
          authInstructions: server.authInstructions || null,
          docsUrl: server.docsUrl || null,
          authType: server.authType || null,
          signupUrl: server.signupUrl || null,
        },
        PORT_MIN,
        PORT_MAX,
      );
      console.log(`Migrated ${server.id}`);
    } catch (error) {
      console.log(`Skipped ${server.id}: ${error.message}`);
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
