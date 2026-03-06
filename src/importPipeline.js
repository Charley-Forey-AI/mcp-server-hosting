const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { execFile } = require("child_process");
const crypto = require("crypto");
const { Readable } = require("stream");
const Docker = require("dockerode");
const {
  createServer,
  getServerById,
  nextFreePort,
  updateImportJobStatus,
} = require("./db");
const { enqueueProvisionJob } = require("./queue");

const execFileAsync = promisify(execFile);
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" });
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://your-domain.example.com";
const PORT_MIN = Number(process.env.PORT_MIN || 30001);
const PORT_MAX = Number(process.env.PORT_MAX || 30200);
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const DOCKER_NETWORK = (process.env.DOCKER_NETWORK || "bridge").trim();
const DOCKER_BRIDGE_FALLBACK = (process.env.DOCKER_BRIDGE_FALLBACK || "mcp_net").trim();
const RUNTIME_MARKERS = ["Dockerfile", "package.json", "pyproject.toml", "requirements.txt"];
const IMPORT_FETCH_TIMEOUT_MS = Number(process.env.IMPORT_FETCH_TIMEOUT_MS || 45000);
const IMPORT_FETCH_STREAM_TIMEOUT_MS = Number(process.env.IMPORT_FETCH_STREAM_TIMEOUT_MS || 45000);
const IMPORT_FETCH_TOTAL_TIMEOUT_MS = Number(process.env.IMPORT_FETCH_TOTAL_TIMEOUT_MS || 180000);
const IMPORT_FETCH_MAX_BYTES = Number(process.env.IMPORT_FETCH_MAX_BYTES || 250 * 1024 * 1024);

function truncate(value, max = 6000) {
  const str = String(value || "");
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n...[truncated]`;
}

function buildRuntimeEnvDefaults(runtimeInfo, assignedPort, transportPath) {
  const defaults = {};
  if (runtimeInfo.runtime === "python") {
    defaults.MCP_TRANSPORT = "streamable-http";
    defaults.MCP_HTTP_HOST = "0.0.0.0";
    defaults.MCP_HTTP_PORT = String(assignedPort);
    defaults.MCP_HTTP_PATH = transportPath || "/mcp";
    defaults.HOST = "0.0.0.0";
    defaults.PORT = String(assignedPort);
  } else if (runtimeInfo.runtime === "node") {
    defaults.HOST = "0.0.0.0";
    defaults.PORT = String(assignedPort);
  }
  return defaults;
}

function inferImportFailureHints(message) {
  const raw = String(message || "");
  const lower = raw.toLowerCase();
  const hints = [];
  if (lower.includes("readme file does not exist")) {
    hints.push("Repository Dockerfile is missing README copy before package install (e.g. COPY README.md .).");
  }
  if (lower.includes("returned a non-zero code")) {
    hints.push("Docker build step failed. Review buildLog and Dockerfile commands for missing files or dependency errors.");
  }
  if (lower.includes("could not detect supported runtime")) {
    hints.push("No supported runtime was detected. Add a Dockerfile, package.json, or Python project files.");
  }
  if (lower.includes("server.command must be set to a docker image name")) {
    hints.push("Server registration is missing command image. Ensure import produced an image tag.");
  }
  if (lower.includes("subdir") && lower.includes("not found")) {
    hints.push("Provided subdir does not exist in repository. Verify exact path and casing.");
  }
  if (!hints.length) {
    hints.push("Review the import job result.buildLog for the failing build/install step.");
  }
  return hints;
}

function toKebabCase(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function parseGitHubUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("githubUrl is required");
  const withProtocol = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error("githubUrl must be a github.com repository URL");
  }
  const segments = url.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (segments.length < 2) throw new Error("githubUrl must match github.com/<owner>/<repo>");
  const owner = segments[0];
  const repo = segments[1];
  return {
    owner,
    repo,
    canonicalRepoUrl: `https://github.com/${owner}/${repo}`,
  };
}

function deriveServerId(preferredId, repoName) {
  const preferred = toKebabCase(preferredId || "");
  if (preferred) return preferred;
  const base = toKebabCase(repoName) || "mcp-import";
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

function buildCursorSnippet(serverId, requiredHeaders = []) {
  const blocked = new Set(["x-api-key", "x-platform-api-key", "x-portkey-api-key"]);
  const headers = {};
  for (const header of requiredHeaders) {
    const normalized = String(header || "").trim();
    if (!normalized) continue;
    const lowered = normalized.toLowerCase();
    if (blocked.has(lowered)) continue;
    if (lowered === "authorization") headers[normalized] = "Bearer <YOUR_TOKEN>";
    else if (lowered === "x-api-key") headers[normalized] = "<API_KEY>";
    else headers[normalized] = `<${normalized}-VALUE>`;
  }
  return JSON.stringify(
    {
      mcpServers: {
        [serverId]: {
          url: `${PUBLIC_BASE_URL}/mcp/${serverId}`,
          headers,
        },
      },
    },
    null,
    2,
  );
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function scoreRuntimeCandidate(relativeDir, markerSet) {
  let score = 0;
  if (markerSet.has("Dockerfile")) score += 100;
  if (markerSet.has("package.json")) score += 90;
  if (markerSet.has("pyproject.toml")) score += 90;
  if (markerSet.has("requirements.txt")) score += 70;
  const lower = String(relativeDir || "").toLowerCase();
  if (lower.includes("mcp")) score += 20;
  if (lower.includes("server")) score += 10;
  // Prefer shallower directories when scores tie.
  score -= Math.max(0, lower.split(path.sep).filter(Boolean).length);
  return score;
}

async function findRuntimeSubdir(rootDir, maxDepth = 4) {
  const candidates = [];
  async function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const entryNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const markerSet = new Set(RUNTIME_MARKERS.filter((marker) => entryNames.has(marker)));
    if (markerSet.size > 0) {
      const relativeDir = path.relative(rootDir, currentDir) || ".";
      candidates.push({
        absoluteDir: currentDir,
        relativeDir,
        markerSet,
        score: scoreRuntimeCandidate(relativeDir, markerSet),
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (
        name === ".git" ||
        name === ".venv" ||
        name === "venv" ||
        name === "__pycache__" ||
        name === "node_modules" ||
        name.startsWith(".")
      ) {
        continue;
      }
      await walk(path.join(currentDir, name), depth + 1);
    }
  }
  await walk(rootDir, 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.relativeDir.localeCompare(b.relativeDir));
  return candidates[0];
}

async function fetchTarball(owner, repo, branch, tarballPath, onProgress = null) {
  const attempted = [branch || "main"];
  if (!branch) attempted.push("master");
  let lastError = null;
  for (const ref of attempted) {
    const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`;
    const headers = {
      "user-agent": "mcp-hosting-importer",
      accept: "application/vnd.github+json",
    };
    if (GITHUB_TOKEN) headers.authorization = `Bearer ${GITHUB_TOKEN}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("github_tarball_timeout")), IMPORT_FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("github_tarball_timeout") || message.toLowerCase().includes("aborted")) {
        lastError = new Error(`tarball fetch timed out (${IMPORT_FETCH_TIMEOUT_MS}ms) for branch '${ref}'`);
      } else {
        lastError = new Error(`tarball fetch failed for branch '${ref}': ${message}`);
      }
      clearTimeout(timeout);
      continue;
    }
    clearTimeout(timeout);
    if (!response.ok || !response.body) {
      lastError = new Error(`tarball fetch failed (${response.status}) for branch '${ref}'`);
      continue;
    }
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(tarballPath);
      const bodyStream = Readable.fromWeb(response.body);
      let settled = false;
      let timeout = null;
      const startedAt = Date.now();
      let downloadedBytes = 0;
      let lastProgressAt = 0;
      const clear = () => {
        if (timeout) clearTimeout(timeout);
        timeout = null;
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clear();
        try {
          bodyStream.destroy();
        } catch {
          // noop
        }
        try {
          stream.destroy();
        } catch {
          // noop
        }
        reject(error);
      };
      const heartbeat = () => {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs > IMPORT_FETCH_TOTAL_TIMEOUT_MS) {
          fail(new Error(`tarball total fetch timeout (${IMPORT_FETCH_TOTAL_TIMEOUT_MS}ms) for branch '${ref}'`));
          return;
        }
        clear();
        timeout = setTimeout(
          () => fail(new Error(`tarball stream timed out (${IMPORT_FETCH_STREAM_TIMEOUT_MS}ms) for branch '${ref}'`)),
          IMPORT_FETCH_STREAM_TIMEOUT_MS,
        );
      };

      heartbeat();
      bodyStream.on("data", (chunk) => {
        downloadedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ""));
        if (downloadedBytes > IMPORT_FETCH_MAX_BYTES) {
          fail(new Error(`tarball exceeded max size (${IMPORT_FETCH_MAX_BYTES} bytes) for branch '${ref}'`));
          return;
        }
        const now = Date.now();
        if (typeof onProgress === "function" && now - lastProgressAt >= 5000) {
          lastProgressAt = now;
          Promise.resolve(
            onProgress({
              branch: ref,
              downloadedBytes,
              elapsedMs: now - startedAt,
            }),
          ).catch(() => {});
        }
        heartbeat();
      });
      bodyStream.on("error", (error) => fail(error));
      stream.on("error", (error) => fail(error));
      stream.on("finish", () => {
        if (settled) return;
        settled = true;
        clear();
        resolve();
      });
      bodyStream.pipe(stream);
    });
    return ref;
  }
  throw lastError || new Error("failed to fetch repository tarball");
}

async function extractTarball(tarballPath, extractRoot) {
  await fsp.mkdir(extractRoot, { recursive: true });
  await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractRoot]);
  const entries = await fsp.readdir(extractRoot, { withFileTypes: true });
  const topDir = entries.find((e) => e.isDirectory());
  if (!topDir) throw new Error("invalid tarball: no extracted root folder");
  return path.join(extractRoot, topDir.name);
}

async function detectRuntime(contextDir, options = {}) {
  const useRepoDockerfile = options.useRepoDockerfile !== false;
  const dockerfilePath = path.join(contextDir, "Dockerfile");
  if (useRepoDockerfile && (await fileExists(dockerfilePath))) {
    return { runtime: "dockerfile", useRepoDockerfile: true, dockerfilePath };
  }

  const packageJsonPath = path.join(contextDir, "package.json");
  if (await fileExists(packageJsonPath)) {
    let startCmd = ["npm", "start"];
    try {
      const pkg = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"));
      if (!pkg.scripts || !pkg.scripts.start) {
        if (await fileExists(path.join(contextDir, "index.js"))) startCmd = ["node", "index.js"];
        else if (await fileExists(path.join(contextDir, "server.js"))) startCmd = ["node", "server.js"];
      }
    } catch {
      // Keep default command if package.json is malformed.
    }
    return { runtime: "node", useRepoDockerfile: false, startCmd };
  }

  const hasPyproject = await fileExists(path.join(contextDir, "pyproject.toml"));
  const hasReq = await fileExists(path.join(contextDir, "requirements.txt"));
  if (hasPyproject || hasReq) {
    let entrypoint = "server.py";
    if (await fileExists(path.join(contextDir, "mcp", "main.py"))) entrypoint = "mcp/main.py";
    else if (await fileExists(path.join(contextDir, "app.py"))) entrypoint = "app.py";
    else if (await fileExists(path.join(contextDir, "main.py"))) entrypoint = "main.py";
    const readme = await readMaybeText(path.join(contextDir, "README.md"));
    const pyproject = await readMaybeText(path.join(contextDir, "pyproject.toml"));
    const pythonStartCmd = inferPythonStartCommand(contextDir, readme, pyproject, entrypoint);
    const pythonDependencies = extractPythonDependencies(pyproject);
    const pythonInferredDependencies = await inferPythonDependenciesFromImports(contextDir);
    return {
      runtime: "python",
      useRepoDockerfile: false,
      entrypoint,
      pythonStartCmd,
      pythonDependencies,
      pythonInferredDependencies,
    };
  }

  throw new Error("Could not detect supported runtime (Node/Python) and no Dockerfile was found");
}

async function ensureGeneratedDockerfile(contextDir, runtimeInfo, dockerfileName = "Dockerfile") {
  if (runtimeInfo.useRepoDockerfile) return;

  let contents = "";
  if (runtimeInfo.runtime === "node") {
    const cmd = JSON.stringify(runtimeInfo.startCmd);
    contents = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ${cmd}
`;
  } else if (runtimeInfo.runtime === "python") {
    const cmd = JSON.stringify(runtimeInfo.pythonStartCmd || ["python", runtimeInfo.entrypoint]);
    const fallbackDeps = (runtimeInfo.pythonDependencies || []).join(" ");
    const inferredDeps = (runtimeInfo.pythonInferredDependencies || []).join(" ");
    const pyprojectInstall = `if [ -f pyproject.toml ]; then pip install --no-cache-dir . || echo "pyproject install failed; continuing with fallback deps"; fi`;
    contents = `FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi && ${pyprojectInstall}${fallbackDeps ? ` && pip install --no-cache-dir ${fallbackDeps}` : ""}${inferredDeps ? ` && pip install --no-cache-dir ${inferredDeps}` : ""}
ENV PORT=3000
EXPOSE 3000
CMD ${cmd}
`;
  } else {
    throw new Error(`Unsupported runtime '${runtimeInfo.runtime}'`);
  }

  await fsp.writeFile(path.join(contextDir, dockerfileName), contents, "utf8");
}

async function createBuildContextTar(contextDir, outputTarPath) {
  await execFileAsync("tar", ["-czf", outputTarPath, "-C", contextDir, "."]);
}

async function buildImageFromContextTar(tarPath, imageTag, options = {}) {
  const stream = fs.createReadStream(tarPath);
  const buildOptions = { t: imageTag };
  const dockerfile = String(options.dockerfile || "").trim();
  if (dockerfile) buildOptions.dockerfile = dockerfile;
  const buildStream = await docker.buildImage(stream, buildOptions);
  const logLines = [];
  let buildError = null;
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err, output) => {
        if (Array.isArray(output)) {
          for (const event of output) {
            if (event.error) {
              buildError = buildError || String(event.error);
              logLines.push(String(event.error));
            }
            if (event.errorDetail && event.errorDetail.message) {
              buildError = buildError || String(event.errorDetail.message);
              logLines.push(String(event.errorDetail.message));
            }
            if (event.stream) logLines.push(String(event.stream).trim());
            if (event.status) {
              const detail = event.id ? `${event.status} ${event.id}` : event.status;
              logLines.push(detail);
            }
          }
        }
        if (err || buildError) {
          return reject(new Error(truncate(logLines.join("\n") || buildError || err.message)));
        }
        return resolve();
      },
      (event) => {
        if (event.error) {
          buildError = buildError || String(event.error);
          logLines.push(String(event.error));
        }
        if (event.errorDetail && event.errorDetail.message) {
          buildError = buildError || String(event.errorDetail.message);
          logLines.push(String(event.errorDetail.message));
        }
        if (event.stream) logLines.push(String(event.stream).trim());
      },
    );
  });
  const builtImage = await imageExistsByTag(imageTag);
  if (!builtImage) {
    throw new Error(truncate(`${logLines.join("\n")}\nimage '${imageTag}' was not created by docker build`));
  }
  return { imageTag, buildLog: truncate(logLines.filter(Boolean).join("\n"), 12000) };
}

async function imageExistsByTag(imageTag) {
  const images = await docker.listImages({ filters: { reference: [imageTag] } });
  return images.length > 0;
}

async function inferAuthMetadata(contextDir, canonicalRepoUrl) {
  const candidates = ["README.md", "readme.md", ".env.example", ".env.sample"];
  let corpus = "";
  for (const name of candidates) {
    const p = path.join(contextDir, name);
    if (await fileExists(p)) {
      const part = await fsp.readFile(p, "utf8");
      corpus += `\n${part.slice(0, 30000)}`;
    }
  }
  const lower = corpus.toLowerCase();
  const requiredHeaders = [];
  const optionalHeaders = [];
  const hasBearerMention = lower.includes("authorization") || lower.includes("bearer");
  const hasApiKeyMention = lower.includes("x-api-key");
  const lines = corpus.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const requiredAuthorization = lines.some(
    (line) =>
      /authorization/i.test(line) &&
      /(required|must include|must send|mandatory)/i.test(line) &&
      !/optional|if set|when set|if you set/i.test(line),
  );
  if (requiredAuthorization) requiredHeaders.push("Authorization");
  else if (hasBearerMention) optionalHeaders.push("Authorization");
  if (hasApiKeyMention) optionalHeaders.push("X-API-Key");
  const discoveredHeaderMatches = corpus.match(/\bX-[A-Za-z0-9-]+\b/g) || [];
  const discoveredHeaders = [...new Set(discoveredHeaderMatches.map((h) => h.trim()))];
  const uniqueRequiredHeaders = [...new Set(requiredHeaders)];
  const uniqueOptionalHeaders = [...new Set(optionalHeaders)];
  const forwardHeaders = [...new Set([...uniqueRequiredHeaders, ...uniqueOptionalHeaders, ...discoveredHeaders].map((h) => h.toLowerCase()))];

  let authType = "custom";
  if (uniqueRequiredHeaders.includes("Authorization") || uniqueOptionalHeaders.includes("Authorization")) authType = "bearer";
  else if (uniqueRequiredHeaders.includes("X-API-Key") || uniqueOptionalHeaders.includes("X-API-Key")) authType = "api_key";

  let authInstructions = "Review repository documentation for credential setup and header values.";
  if (hasBearerMention) authInstructions = "Set `Authorization: Bearer <token>` using your account credentials.";
  else if (lower.includes("x-api-key")) {
    authInstructions = "Set `X-API-Key: <your-api-key>` from the provider dashboard.";
  }
  if (discoveredHeaders.length) {
    authInstructions += ` Optional request headers detected: ${discoveredHeaders.join(", ")}.`;
  }

  return {
    requiredHeaders: uniqueRequiredHeaders,
    forwardHeaders: forwardHeaders.length ? forwardHeaders : ["authorization"],
    authType,
    authInstructions,
    docsUrl: canonicalRepoUrl,
  };
}

async function inferEnvTemplate(contextDir) {
  const envPathCandidates = [".env.example", ".env.sample", ".env.template"];
  let envText = "";
  for (const name of envPathCandidates) {
    const abs = path.join(contextDir, name);
    if (await fileExists(abs)) {
      envText = await fsp.readFile(abs, "utf8");
      break;
    }
  }
  if (!envText.trim()) return { commandEnv: {}, requiredEnvKeys: [] };
  const commandEnv = {};
  const requiredEnvKeys = [];
  const lines = envText.split(/\r?\n/);
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
    const idx = raw.indexOf("=");
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!key || !/^[A-Z0-9_]+$/i.test(key)) continue;
    const normalizedValue = value.replace(/^['"]|['"]$/g, "");
    commandEnv[key] = normalizedValue && !/^your_|^changeme|^replace/i.test(normalizedValue) ? normalizedValue : "";
    if (!normalizedValue || /^your_|^changeme|^replace/i.test(normalizedValue)) {
      requiredEnvKeys.push(key);
    }
  }
  return { commandEnv, requiredEnvKeys: [...new Set(requiredEnvKeys)] };
}

async function readMaybeText(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function inferPythonStartCommand(contextDir, readme, pyproject, fallbackEntrypoint) {
  const corpus = `${readme || ""}\n${pyproject || ""}`;
  const lower = corpus.toLowerCase();

  // ArcGIS MCP server layout: package module runner exposes /mcp.
  if (fileExistsSync(path.join(contextDir, "arcgis_mcp_server", "server.py"))) {
    return ["python", "-m", "arcgis_mcp_server.server", "--host", "0.0.0.0"];
  }

  const moduleHttpMatch = corpus.match(/python\s+-m\s+([A-Za-z0-9_.]+)\s+--http/);
  if (moduleHttpMatch) {
    return ["python", "-m", moduleHttpMatch[1], "--http"];
  }
  if (lower.includes("--http")) {
    if (fileExistsSync(path.join(contextDir, "mcp", "main.py"))) return ["python", "mcp/main.py", "--http"];
    if (fileExistsSync(path.join(contextDir, "src", "main.py"))) return ["python", "-m", "src.main", "--http"];
    if (fileExistsSync(path.join(contextDir, "main.py"))) return ["python", "main.py", "--http"];
  }
  if (fileExistsSync(path.join(contextDir, "mcp", "main.py"))) {
    return ["python", "mcp/main.py", "--http"];
  }

  if (fileExistsSync(path.join(contextDir, "src", "main.py"))) {
    return ["python", "-m", "src.main", "--http"];
  }
  return ["python", fallbackEntrypoint];
}

function extractPythonDependencies(pyproject) {
  const text = String(pyproject || "");
  if (!text.trim()) return [];
  const block = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (!block || !block[1]) return [];
  const matches = [...block[1].matchAll(/"([^"]+)"/g)];
  return [...new Set(matches.map((match) => match[1].trim()).filter(Boolean))];
}

async function inferPythonDependenciesFromImports(contextDir) {
  const files = await listPythonFiles(contextDir);
  const detectedImports = new Set();
  for (const file of files) {
    const text = await readMaybeText(file);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_\.]+)/);
      if (importMatch) {
        detectedImports.add(importMatch[1].split(".")[0]);
      }
      const fromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+/);
      if (fromMatch) {
        detectedImports.add(fromMatch[1].split(".")[0]);
      }
    }
  }

  const importToPackage = {
    mcp: "mcp",
    fastmcp: "fastmcp",
    dotenv: "python-dotenv",
    yaml: "PyYAML",
    cv2: "opencv-python-headless",
    PIL: "Pillow",
  };

  const out = [];
  for (const mod of detectedImports) {
    const pkg = importToPackage[mod];
    if (pkg) out.push(pkg);
  }
  return [...new Set(out)];
}

async function listPythonFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "__pycache__" || entry.name === ".venv" || entry.name === "venv") {
          continue;
        }
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".py")) {
        out.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return out;
}

function inferTransportPath(contextDir, runtimeInfo) {
  if (fileExistsSync(path.join(contextDir, "arcgis_mcp_server", "server.py"))) {
    return "/mcp";
  }
  if (runtimeInfo.runtime === "python" && Array.isArray(runtimeInfo.pythonStartCmd)) {
    const cmd = runtimeInfo.pythonStartCmd.map((x) => String(x).toLowerCase());
    if (
      cmd.includes("--http") &&
      (fileExistsSync(path.join(contextDir, "src", "main.py")) || fileExistsSync(path.join(contextDir, "mcp", "main.py")))
    ) {
      return "/mcp";
    }
  }
  return "/";
}

function buildImportedTargetUrl(serverId, assignedPort, targetPath = "/") {
  const normalizedPath = `/${String(targetPath || "/").replace(/^\/+/, "")}`.replace(/\/+$/, "");
  const pathSuffix = normalizedPath === "/" ? "" : normalizedPath;
  if (DOCKER_NETWORK === "host") {
    if (fileExistsSync("/.dockerenv")) {
      return `http://mcp-server-${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, "-")}:${assignedPort}${pathSuffix}`;
    }
    return `http://127.0.0.1:${assignedPort}${pathSuffix}`;
  }
  if (DOCKER_NETWORK === "bridge" && DOCKER_BRIDGE_FALLBACK) {
    return `http://mcp-server-${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, "-")}:${assignedPort}${pathSuffix}`;
  }
  return `http://mcp-server-${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, "-")}:${assignedPort}${pathSuffix}`;
}

function fileExistsSync(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runImportJob(job) {
  const importJobId = String(job.id);
  const payload = job.data?.payload || {};
  const githubUrl = String(payload.githubUrl || "").trim();
  const branch = String(payload.branch || "").trim() || null;
  const subdir = String(payload.subdir || "").trim() || null;
  const serverIdHint = String(payload.serverId || "").trim() || "";
  const autoStart = payload.autoStart !== false;

  const { owner, repo, canonicalRepoUrl } = parseGitHubUrl(githubUrl);
  const serverId = deriveServerId(serverIdHint, repo);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-import-"));
  const tarballPath = path.join(tmpRoot, "repo.tar.gz");
  const extractRoot = path.join(tmpRoot, "extract");
  const contextTar = path.join(tmpRoot, "context.tar.gz");

  try {
    await updateImportJobStatus(importJobId, "fetching", { phase: "fetching" }, serverId);
    const resolvedBranch = await fetchTarball(owner, repo, branch, tarballPath, ({ branch: fetchedBranch, downloadedBytes, elapsedMs }) =>
      updateImportJobStatus(
        importJobId,
        "fetching",
        {
          phase: "fetching",
          branch: fetchedBranch,
          downloadedBytes,
          elapsedMs,
        },
        serverId,
      ),
    );
    const extractedRoot = await extractTarball(tarballPath, extractRoot);
    const requestedContextDir = subdir ? path.resolve(extractedRoot, subdir) : extractedRoot;
    if (!requestedContextDir.startsWith(path.resolve(extractedRoot))) {
      throw new Error("subdir must resolve within the extracted repository");
    }
    if (!(await fileExists(requestedContextDir))) {
      throw new Error(`subdir '${subdir}' was not found in repository`);
    }

    await updateImportJobStatus(importJobId, "building", { phase: "detecting-runtime", branch: resolvedBranch }, serverId);
    let contextDir = requestedContextDir;
    let autoDetectedSubdir = null;
    let runtimeInfo;
    try {
      runtimeInfo = await detectRuntime(contextDir, { useRepoDockerfile: true });
    } catch (detectError) {
      if (subdir) throw detectError;
      const candidate = await findRuntimeSubdir(extractedRoot);
      if (!candidate || !candidate.absoluteDir) throw detectError;
      contextDir = candidate.absoluteDir;
      autoDetectedSubdir = candidate.relativeDir === "." ? null : candidate.relativeDir.replaceAll(path.sep, "/");
      runtimeInfo = await detectRuntime(contextDir, { useRepoDockerfile: true });
      await updateImportJobStatus(
        importJobId,
        "building",
        {
          phase: "detected-subdir-runtime",
          branch: resolvedBranch,
          autoDetectedSubdir,
          markers: Array.from(candidate.markerSet || []),
        },
        serverId,
      );
    }
    const shortTag = crypto.randomBytes(4).toString("hex");
    const imageTag = `mcp-import/${serverId}:${shortTag}`;
    let buildResult = null;
    let buildStrategy = runtimeInfo.useRepoDockerfile ? "repo-dockerfile" : "generated-dockerfile";
    let fallbackBuildError = null;
    try {
      if (!runtimeInfo.useRepoDockerfile) {
        await ensureGeneratedDockerfile(contextDir, runtimeInfo, "Dockerfile");
      }
      await createBuildContextTar(contextDir, contextTar);
      buildResult = await buildImageFromContextTar(contextTar, imageTag, {
        dockerfile: runtimeInfo.useRepoDockerfile ? "Dockerfile" : "Dockerfile",
      });
    } catch (error) {
      if (!runtimeInfo.useRepoDockerfile) {
        throw error;
      }
      fallbackBuildError = String(error.message || error);
      runtimeInfo = await detectRuntime(contextDir, { useRepoDockerfile: false });
      await ensureGeneratedDockerfile(contextDir, runtimeInfo, "Dockerfile.mcp-import");
      buildStrategy = "generated-dockerfile-fallback";
      await updateImportJobStatus(
        importJobId,
        "building",
        {
          phase: "retrying-generated-dockerfile",
          branch: resolvedBranch,
          previousError: truncate(fallbackBuildError, 3000),
        },
        serverId,
      );
      await createBuildContextTar(contextDir, contextTar);
      buildResult = await buildImageFromContextTar(contextTar, imageTag, { dockerfile: "Dockerfile.mcp-import" });
    }

    await updateImportJobStatus(
      importJobId,
      "registering",
      {
        phase: "registering",
        runtime: runtimeInfo.runtime,
        buildStrategy,
        imageTag: buildResult.imageTag,
      },
      serverId,
    );
    const auth = await inferAuthMetadata(contextDir, canonicalRepoUrl);
    const envTemplate = await inferEnvTemplate(contextDir);
    const assignedPort = await nextFreePort(PORT_MIN, PORT_MAX);
    const transportPath = inferTransportPath(contextDir, runtimeInfo);
    const targetUrl = buildImportedTargetUrl(serverId, assignedPort, transportPath);
    const healthPath = transportPath === "/" ? "/health" : "/";
    const runtimeEnvDefaults = buildRuntimeEnvDefaults(runtimeInfo, assignedPort, transportPath);
    const commandEnv = {
      ...runtimeEnvDefaults,
      ...(envTemplate.commandEnv || {}),
    };
    const server = await createServer(
      {
        id: serverId,
        name: repo,
        description: `Imported from GitHub: ${owner}/${repo}`,
        internalPort: assignedPort,
        targetUrl,
        healthPath,
        requiredHeaders: auth.requiredHeaders,
        forwardHeaders: auth.forwardHeaders,
        command: imageTag,
        commandArgs: [],
        commandEnv,
        commandEnvSecrets: {},
        authInstructions: auth.authInstructions,
        docsUrl: auth.docsUrl,
        authType: auth.authType,
        signupUrl: null,
      },
      PORT_MIN,
      PORT_MAX,
    );

    let startJobId = null;
    const missingRequiredEnvKeys = (envTemplate.requiredEnvKeys || []).filter(
      (key) => !String((envTemplate.commandEnv || {})[key] || "").trim(),
    );
    const canAutoStart = autoStart && missingRequiredEnvKeys.length === 0;
    if (canAutoStart) {
      await updateImportJobStatus(importJobId, "starting", { phase: "starting", serverId: server.id }, server.id);
      const startJob = await enqueueProvisionJob(
        "start-server",
        { serverId: server.id, source: "import-repo" },
        { actorSub: job.data?.meta?.actorSub || "system-worker", actorRoles: job.data?.meta?.actorRoles || [] },
      );
      startJobId = String(startJob.id);
    }

    const latestServer = (await getServerById(server.id)) || server;
    const mcpJsonSnippet = buildCursorSnippet(latestServer.id, latestServer.requiredHeaders || auth.requiredHeaders);
    const result = {
      serverId: latestServer.id,
      url: `${PUBLIC_BASE_URL}/mcp/${latestServer.id}`,
      mcpJsonSnippet,
      requiredHeaders: latestServer.requiredHeaders,
      authType: latestServer.authType,
      authInstructions: latestServer.authInstructions,
      docsUrl: latestServer.docsUrl,
      imageTag,
      runtime: runtimeInfo.runtime,
      buildStrategy,
      autoDetectedSubdir,
      fallbackBuildError: fallbackBuildError ? truncate(fallbackBuildError, 3000) : null,
      startJobId,
      requiredEnvKeys: envTemplate.requiredEnvKeys || [],
      missingRequiredEnvKeys,
      nextAction:
        missingRequiredEnvKeys.length > 0
          ? "Set required env vars in Runtime config, then restart server."
          : autoStart
            ? "Server start queued."
            : "Server registered. Start it from dashboard when ready.",
      buildLog: buildResult.buildLog,
    };
    await updateImportJobStatus(importJobId, missingRequiredEnvKeys.length > 0 ? "awaiting_config" : "completed", result, latestServer.id);
    return result;
  } catch (error) {
    const message = String(error.message || error);
    await updateImportJobStatus(
      importJobId,
      "failed",
      {
        error: truncate(message),
        hints: inferImportFailureHints(message),
        failedAt: new Date().toISOString(),
      },
      serverId,
    );
    throw error;
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

module.exports = {
  runImportJob,
  parseGitHubUrl,
  deriveServerId,
};
