const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { globSync } = require("glob");

const manifestDir = process.env.MANIFEST_DIR || path.join(__dirname, "..", "servers");
const files = globSync("**/*.{yml,yaml}", { cwd: manifestDir, absolute: true });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function validateManifest(data, filePath) {
  assert(data && typeof data === "object", "manifest must be a YAML object");
  assert(typeof data.id === "string" && /^[a-zA-Z0-9_-]+$/.test(data.id), "id is required and must match /^[a-zA-Z0-9_-]+$/");
  assert(typeof data.name === "string" && data.name.trim(), "name is required");
  assert(typeof data.description === "string", "description must be a string");
  if (data.targetUrl !== undefined) assert(typeof data.targetUrl === "string", "targetUrl must be a string");
  if (data.healthPath !== undefined) assert(typeof data.healthPath === "string", "healthPath must be a string");
  if (data.command !== undefined) assert(typeof data.command === "string", "command must be a string (Docker image)");
  if (data.commandArgs !== undefined) assert(Array.isArray(data.commandArgs), "commandArgs must be an array");
  if (data.commandEnv !== undefined) assert(typeof data.commandEnv === "object", "commandEnv must be an object");
  if (data.commandEnvSecrets !== undefined) assert(typeof data.commandEnvSecrets === "object", "commandEnvSecrets must be an object");
  if (data.requiredHeaders !== undefined) assert(Array.isArray(data.requiredHeaders), "requiredHeaders must be an array");
  if (data.forwardHeaders !== undefined) assert(Array.isArray(data.forwardHeaders), "forwardHeaders must be an array");
  if (data.authInstructions !== undefined) assert(typeof data.authInstructions === "string", "authInstructions must be a string");
  if (data.authInstructions !== undefined) assert(data.authInstructions.length <= 4000, "authInstructions max length is 4000");
  if (data.docsUrl !== undefined) assert(typeof data.docsUrl === "string" && isValidHttpUrl(data.docsUrl), "docsUrl must be a valid http(s) URL");
  if (data.signupUrl !== undefined)
    assert(typeof data.signupUrl === "string" && isValidHttpUrl(data.signupUrl), "signupUrl must be a valid http(s) URL");
  if (data.authType !== undefined)
    assert(["bearer", "api_key", "oauth", "custom"].includes(String(data.authType)), "authType must be one of bearer, api_key, oauth, custom");
  return { filePath, id: data.id };
}

function main() {
  if (!fs.existsSync(manifestDir)) {
    console.log(`Manifest dir not found: ${manifestDir}`);
    process.exit(0);
  }

  const ids = new Set();
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = yaml.load(raw);
    const info = validateManifest(parsed, file);
    if (ids.has(info.id)) {
      throw new Error(`duplicate id '${info.id}' across manifests`);
    }
    ids.add(info.id);
    console.log(`Validated ${path.relative(manifestDir, file)} (${info.id})`);
  }

  console.log(`Validated ${files.length} manifest(s).`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
