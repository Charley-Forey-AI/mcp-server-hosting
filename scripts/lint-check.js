const fs = require("fs");
const path = require("path");

const files = [
  path.join(__dirname, "..", "src", "index.js"),
  path.join(__dirname, "..", "src", "db.js"),
  path.join(__dirname, "..", "src", "auth.js"),
  path.join(__dirname, "..", "src", "queue.js"),
  path.join(__dirname, "..", "src", "dockerRunner.js"),
  path.join(__dirname, "..", "src", "worker.js"),
  path.join(__dirname, "..", "src", "logger.js"),
  path.join(__dirname, "..", "src", "metrics.js"),
  path.join(__dirname, "..", "src", "telemetry.js"),
  path.join(__dirname, "..", "src", "secrets.js"),
  path.join(__dirname, "..", "src", "importPipeline.js"),
  path.join(__dirname, "validate-server-manifests.js"),
  path.join(__dirname, "submit-server-manifests.js"),
];
let failed = false;

for (const file of files) {
  try {
    const source = fs.readFileSync(file, "utf8");
    new Function(source);
  } catch (error) {
    failed = true;
    console.error(`Syntax error in ${file}:`, error.message);
  }
}

if (failed) process.exit(1);
console.log("Lint check passed.");
