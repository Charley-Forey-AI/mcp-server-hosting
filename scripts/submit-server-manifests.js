const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { globSync } = require("glob");

const baseUrl = process.env.ADMIN_API_BASE_URL || "";
const apiKey = process.env.ADMIN_API_KEY || "";
const manifestDir = process.env.MANIFEST_DIR || path.join(__dirname, "..", "servers");

if (!baseUrl) {
  console.error("ADMIN_API_BASE_URL is required");
  process.exit(1);
}

async function submitManifest(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const body = yaml.load(raw);
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const upsertUrl = `${baseUrl.replace(/\/$/, "")}/admin/servers`;
  const patchUrl = `${baseUrl.replace(/\/$/, "")}/admin/servers/${encodeURIComponent(body.id)}`;

  const createRes = await fetch(upsertUrl, { method: "POST", headers, body: JSON.stringify(body) });
  if (createRes.status === 409) {
    const patchRes = await fetch(patchUrl, { method: "PATCH", headers, body: JSON.stringify(body) });
    const patchJson = await patchRes.json();
    if (!patchRes.ok) {
      throw new Error(`PATCH failed for ${body.id}: ${JSON.stringify(patchJson)}`);
    }
    return { id: body.id, action: "patched" };
  }

  const createJson = await createRes.json();
  if (!createRes.ok) {
    throw new Error(`POST failed for ${body.id}: ${JSON.stringify(createJson)}`);
  }
  return { id: body.id, action: "created" };
}

async function main() {
  if (!fs.existsSync(manifestDir)) {
    console.log(`Manifest dir not found: ${manifestDir}`);
    return;
  }
  const files = globSync("**/*.{yml,yaml}", { cwd: manifestDir, absolute: true });
  for (const file of files) {
    const result = await submitManifest(file);
    console.log(`${result.action}: ${result.id}`);
  }
  console.log(`Submitted ${files.length} manifest(s).`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
