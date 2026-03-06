const SERVER_SNIPPETS = window.DASHBOARD_DATA?.snippets || {};
const SERVER_URLS = window.DASHBOARD_DATA?.serverUrls || {};
const MASK_TOKEN = window.DASHBOARD_DATA?.maskToken || "__MCP_MASKED__";
const SYSTEM_MANAGED_ENV_KEYS = new Set([
  "HOST",
  "PORT",
  "MCP_HOST",
  "MCP_PORT",
  "MCP_TRANSPORT",
  "MCP_HTTP_HOST",
  "MCP_HTTP_PORT",
  "MCP_HTTP_PATH",
]);
let importPollTimer = null;
const SERVER_VIEW_KEY = "dashboard:server-view";

function authHeaders() {
  const apiKey = document.getElementById("apiKey")?.value.trim();
  const bearerToken = document.getElementById("bearerToken")?.value.trim();
  return {
    ...(bearerToken ? { authorization: "Bearer " + bearerToken } : {}),
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
}

function extractJsonRpcPayload(text) {
  const body = String(text || "").trim();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    const lines = body.split(/\r?\n/).map((line) => line.trim());
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const candidate = line.slice(5).trim();
      if (!candidate || candidate === "[DONE]") continue;
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    return null;
  }
}

function getTestHeaders(serverId) {
  const raw = document.getElementById("testHeaders-" + serverId)?.value || "{}";
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Test headers must be a JSON object");
    }
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      const headerName = String(key || "").trim();
      const headerValue = String(value ?? "").trim();
      if (!headerName || !headerValue) continue;
      out[headerName] = headerValue;
    }
    return out;
  } catch (error) {
    throw new Error("Invalid test headers JSON: " + String(error.message || error));
  }
}

function showToast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.style.display = "block";
  setTimeout(() => {
    el.style.display = "none";
  }, 2500);
}

function applyServerFilters() {
  const q = (document.getElementById("serverSearch")?.value || "").trim().toLowerCase();
  const status = (document.getElementById("serverStatusFilter")?.value || "").trim().toLowerCase();
  const cards = document.querySelectorAll(".server-card");
  cards.forEach((card) => {
    const name = card.getAttribute("data-name") || "";
    const id = card.getAttribute("data-id") || "";
    const cardStatus = card.getAttribute("data-status") || "";
    const searchMatch = !q || name.includes(q) || id.includes(q);
    const statusMatch = !status || cardStatus === status;
    card.style.display = searchMatch && statusMatch ? "" : "none";
  });
}

function setServerView(mode) {
  const normalized = mode === "list" ? "list" : "cards";
  const grid = document.querySelector(".server-grid");
  if (grid) {
    grid.classList.toggle("list-view", normalized === "list");
  }
  const viewButtons = document.querySelectorAll("[data-server-view]");
  viewButtons.forEach((button) => {
    const isActive = String(button.getAttribute("data-server-view") || "") === normalized;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  try {
    window.localStorage.setItem(SERVER_VIEW_KEY, normalized);
  } catch {
    // ignore storage write failures
  }
}

function filterLogRows(rowSelector, matcher, emptyStateId) {
  const rows = document.querySelectorAll(rowSelector);
  let visibleCount = 0;
  rows.forEach((row) => {
    const visible = matcher(row);
    row.style.display = visible ? "" : "none";
    if (visible) visibleCount += 1;
  });
  const emptyState = document.getElementById(emptyStateId);
  if (emptyState) {
    emptyState.style.display = rows.length > 0 && visibleCount === 0 ? "" : "none";
  }
}

function applyProvisioningLogFilters() {
  const search = (document.getElementById("provisioningSearch")?.value || "").trim().toLowerCase();
  const action = (document.getElementById("provisioningActionFilter")?.value || "").trim().toLowerCase();
  const status = (document.getElementById("provisioningStatusFilter")?.value || "").trim().toLowerCase();
  filterLogRows(
    'tr[data-log-row="provisioning"]',
    (row) => {
      const searchBlob = (row.getAttribute("data-search") || "").toLowerCase();
      const rowAction = (row.getAttribute("data-action") || "").toLowerCase();
      const rowStatus = (row.getAttribute("data-status") || "").toLowerCase();
      return (!search || searchBlob.includes(search)) && (!action || rowAction === action) && (!status || rowStatus === status);
    },
    "provisioningEmptyState",
  );
}

function applyImportLogFilters() {
  const search = (document.getElementById("importLogSearch")?.value || "").trim().toLowerCase();
  const status = (document.getElementById("importLogStatusFilter")?.value || "").trim().toLowerCase();
  filterLogRows(
    'tr[data-log-row="import"]',
    (row) => {
      const searchBlob = (row.getAttribute("data-search") || "").toLowerCase();
      const rowStatus = (row.getAttribute("data-status") || "").toLowerCase();
      return (!search || searchBlob.includes(search)) && (!status || rowStatus === status);
    },
    "importEmptyState",
  );
}

function applyAuditLogFilters() {
  const search = (document.getElementById("auditLogSearch")?.value || "").trim().toLowerCase();
  const actionSearch = (document.getElementById("auditActionFilter")?.value || "").trim().toLowerCase();
  filterLogRows(
    'tr[data-log-row="audit"]',
    (row) => {
      const searchBlob = (row.getAttribute("data-search") || "").toLowerCase();
      const rowAction = (row.getAttribute("data-action") || "").toLowerCase();
      return (!search || searchBlob.includes(search)) && (!actionSearch || rowAction.includes(actionSearch));
    },
    "auditEmptyState",
  );
}

function showLogSection(section) {
  const normalized = String(section || "all").toLowerCase();
  const panels = document.querySelectorAll("[data-log-section]");
  panels.forEach((panel) => {
    const panelName = (panel.getAttribute("data-log-section") || "").toLowerCase();
    panel.style.display = normalized === "all" || panelName === normalized ? "" : "none";
  });

  const tabs = document.querySelectorAll("[data-log-tab]");
  tabs.forEach((tab) => {
    const tabName = (tab.getAttribute("data-log-tab") || "").toLowerCase();
    tab.classList.toggle("active", tabName === normalized);
  });
}

async function copySnippet(serverId) {
  const snippet = SERVER_SNIPPETS[serverId];
  if (!snippet) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(snippet);
      showToast("mcp.json template copied");
      return;
    }
    window.prompt("Copy mcp.json template:", snippet);
  } catch (error) {
    showToast("Copy failed: " + String(error.message || error));
  }
}

async function copyServerUrl(serverId) {
  const url = SERVER_URLS[serverId];
  if (!url) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      showToast("Server URL copied");
      return;
    }
    window.prompt("Copy MCP server URL:", url);
  } catch (error) {
    showToast("Copy failed: " + String(error.message || error));
  }
}

async function runServerAction(action, serverId) {
  if (!serverId) return;
  if (action === "delete") {
    const ok = window.confirm("Delete server " + serverId + "? This will stop it and remove it from the registry.");
    if (!ok) return;
  }
  const endpoint =
    action === "start"
      ? "/admin/servers/" + encodeURIComponent(serverId) + "/start"
      : action === "stop"
        ? "/admin/servers/" + encodeURIComponent(serverId) + "/stop"
        : "/admin/servers/" + encodeURIComponent(serverId);
  const method = action === "delete" ? "DELETE" : "POST";
  try {
    const res = await fetch(endpoint, { method, headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast("Action failed: " + (data.error || res.status));
      return;
    }
    showToast(action === "delete" ? "Server deleted" : "Action queued");
    if (action === "start" || action === "stop") {
      await refreshServerStatusUntilChanged(serverId);
    } else {
      setTimeout(() => window.location.reload(), 1200);
    }
  } catch (error) {
    showToast("Action failed: " + String(error.message || error));
  }
}

async function saveServerConfig(serverId) {
  try {
    const commandEnvRaw = document.getElementById("env-" + serverId)?.value || "{}";
    const commandEnvSecretsRaw = document.getElementById("envSecrets-" + serverId)?.value || "{}";
    const requiredHeadersCsv = document.getElementById("requiredHeaders-" + serverId)?.value || "";
    const forwardHeadersCsv = document.getElementById("forwardHeaders-" + serverId)?.value || "";
    const payload = {
      commandEnv: await restoreMaskedEnvValues(serverId, JSON.parse(commandEnvRaw || "{}")),
      commandEnvSecrets: JSON.parse(commandEnvSecretsRaw || "{}"),
      requiredHeaders: requiredHeadersCsv
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      forwardHeaders: forwardHeadersCsv
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    };
    const res = await fetch("/admin/servers/" + encodeURIComponent(serverId), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast("Config update failed: " + (data.error || res.status));
      return false;
    }
    showToast("Server config updated");
    return true;
  } catch (error) {
    showToast("Config update failed: " + String(error.message || error));
    return false;
  }
}

async function restartServer(serverId) {
  const previousStatus = getCardStatus(serverId);
  const saved = await saveServerConfig(serverId);
  if (!saved) return;
  try {
    const res = await fetch("/admin/servers/" + encodeURIComponent(serverId) + "/restart", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ recreate: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast("Restart failed: " + (data.error || res.status));
      return;
    }
    showToast("Restart queued");
    await refreshServerStatusUntilChanged(serverId, previousStatus);
  } catch (error) {
    showToast("Restart failed: " + String(error.message || error));
  }
}

async function discoverTools(serverId, testHeaders = null) {
  const output = document.getElementById("tools-" + serverId);
  if (output) output.textContent = "Discovering tools...";
  try {
    const upstreamHeaders = testHeaders || getTestHeaders(serverId);
    const res = await fetch("/api/servers/" + encodeURIComponent(serverId) + "/discover-tools", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ headers: upstreamHeaders }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (output) output.textContent = JSON.stringify(data, null, 2);
      updateToolBadges(serverId, false, null, null);
      showToast("Tools discovery failed");
      return;
    }
    const tools = data?.toolsList?.result?.tools || [];
    const initializeStatus = data?.initializeStatus || {};
    const toolsStatus = data?.toolsStatus || {};
    const view = {
      serverId: data.serverId,
      serverInfo: data?.initialize?.result?.serverInfo || null,
      sessionId: data.sessionId || null,
      initializeStatus,
      toolsStatus,
      toolsCount: tools.length,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description || "" })),
      discoveredAt: data.discoveredAt,
    };
    if (output) output.textContent = JSON.stringify(view, null, 2);
    updateToolBadges(serverId, true, tools.length, view.discoveredAt);
    showToast("Discovered " + tools.length + " tools");
  } catch (error) {
    if (output) output.textContent = JSON.stringify({ error: String(error.message || error) }, null, 2);
    updateToolBadges(serverId, false, null, null);
    showToast("Tools discovery failed");
  }
}

async function testConnection(serverId) {
  showToast("Testing connection...");
  const output = document.getElementById("tools-" + serverId);
  try {
    const upstreamHeaders = getTestHeaders(serverId);
    const res = await fetch("/mcp/" + encodeURIComponent(serverId), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...authHeaders(),
        ...upstreamHeaders,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "test-initialize",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "mcp-hosting-dashboard",
            version: "1.0.0",
          },
        },
      }),
    });
    const responseText = await res.text();
    const responsePayload = extractJsonRpcPayload(responseText);
    const proxyValidation = {
      stage: "proxy_validation",
      status: res.status,
      ok: res.ok,
      payload: responsePayload,
    };
    if (!res.ok) {
      if (output) output.textContent = JSON.stringify(proxyValidation, null, 2);
      showToast("Validation failed: " + res.status);
      return;
    }
    await discoverTools(serverId, upstreamHeaders);
  } catch (error) {
    if (output) output.textContent = JSON.stringify({ error: String(error.message || error) }, null, 2);
    showToast("Validation failed");
  }
}

async function pollImportJob(importJobId) {
  if (!importJobId) return;
  if (importPollTimer) clearTimeout(importPollTimer);
  try {
    const res = await fetch("/api/import-jobs/" + encodeURIComponent(importJobId), { headers: authHeaders() });
    const data = await res.json();
    const output = document.getElementById("importResult");
    if (output) output.textContent = JSON.stringify(data, null, 2);
    const normalizedStatus = String(data.status || "").toLowerCase();
    if (res.ok && !["completed", "failed", "awaiting_config"].includes(normalizedStatus)) {
      importPollTimer = setTimeout(() => pollImportJob(importJobId), 2500);
    } else if (res.ok) {
      if (normalizedStatus === "awaiting_config") {
        showToast("Import ready: set required env vars then restart");
      } else if (normalizedStatus === "completed") {
        showToast("Import completed. Logs/results kept on this page");
      } else {
        showToast("Import finished with status: " + normalizedStatus);
      }
    }
  } catch (error) {
    const output = document.getElementById("importResult");
    if (output) output.textContent = JSON.stringify({ error: String(error.message || error) }, null, 2);
  }
}

async function importRepo() {
  const githubUrl = document.getElementById("importGithubUrl")?.value.trim();
  if (!githubUrl) {
    showToast("GitHub URL is required");
    return;
  }
  try {
    const payload = {
      githubUrl,
      branch: document.getElementById("importBranch")?.value.trim() || undefined,
      subdir: document.getElementById("importSubdir")?.value.trim() || undefined,
      serverId: document.getElementById("importServerId")?.value.trim() || undefined,
      autoStart: document.getElementById("importAutoStart") ? Boolean(document.getElementById("importAutoStart").checked) : true,
    };
    const res = await fetch("/admin/import-repo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const output = document.getElementById("importResult");
    if (output) output.textContent = JSON.stringify(data, null, 2);
    if (!res.ok) {
      showToast("Import failed: " + (data.error || res.status));
      return;
    }
    showToast("Import queued");
    if (data.importJobId) pollImportJob(data.importJobId);
  } catch (error) {
    const output = document.getElementById("importResult");
    if (output) output.textContent = JSON.stringify({ error: String(error.message || error) }, null, 2);
  }
}

window.applyServerFilters = applyServerFilters;
window.copySnippet = copySnippet;
window.copyServerUrl = copyServerUrl;
window.runServerAction = runServerAction;
window.saveServerConfig = saveServerConfig;
window.restartServer = restartServer;
window.discoverTools = discoverTools;
window.testConnection = testConnection;
window.importRepo = importRepo;
window.applyProvisioningLogFilters = applyProvisioningLogFilters;
window.applyImportLogFilters = applyImportLogFilters;
window.applyAuditLogFilters = applyAuditLogFilters;
window.showLogSection = showLogSection;
window.setServerView = setServerView;

document.addEventListener("DOMContentLoaded", () => {
  if (document.querySelector(".server-card")) {
    applyServerFilters();
    let preferredView = "cards";
    try {
      preferredView = window.localStorage.getItem(SERVER_VIEW_KEY) || "cards";
    } catch {
      preferredView = "cards";
    }
    setServerView(preferredView);
  }
  if (document.querySelector('[data-log-row="provisioning"]')) {
    applyProvisioningLogFilters();
  }
  if (document.querySelector('[data-log-row="import"]')) {
    applyImportLogFilters();
  }
  if (document.querySelector('[data-log-row="audit"]')) {
    applyAuditLogFilters();
  }
  if (document.querySelector("[data-log-section]")) {
    showLogSection("all");
  }
});

async function restoreMaskedEnvValues(serverId, env) {
  const original = await getServerCommandEnv(serverId);
  const out = {};
  for (const [key, value] of Object.entries(original || {})) {
    if (SYSTEM_MANAGED_ENV_KEYS.has(String(key || "").trim().toUpperCase())) {
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env || {})) {
    const normalized = String(key || "").trim().toUpperCase();
    if (SYSTEM_MANAGED_ENV_KEYS.has(normalized)) {
      // Runtime keys are managed by the platform and preserved from original config.
      continue;
    }
    out[key] = value === MASK_TOKEN && Object.prototype.hasOwnProperty.call(original, key) ? original[key] : value;
  }
  return out;
}

async function getServerCommandEnv(serverId) {
  try {
    const res = await fetch("/api/servers", { headers: authHeaders() });
    const servers = await res.json();
    if (!Array.isArray(servers)) return {};
    const server = servers.find((item) => item.id === serverId);
    return server?.commandEnv && typeof server.commandEnv === "object" ? server.commandEnv : {};
  } catch {
    return {};
  }
}

function updateToolBadges(serverId, passed, toolsCount, discoveredAt) {
  const toolsStatus = document.getElementById("tools-status-" + serverId);
  const toolsMeta = document.getElementById("tools-meta-" + serverId);
  if (toolsStatus) {
    toolsStatus.textContent = passed ? "pass" : "failed";
  }
  if (toolsMeta) {
    const at = discoveredAt ? " • " + new Date(discoveredAt).toISOString() : "";
    toolsMeta.textContent = passed ? "Tool discovery: " + String(toolsCount ?? 0) + " tools" + at : "Tool discovery: failed";
  }
}

function getCardStatus(serverId) {
  const card = document.getElementById("server-card-" + serverId);
  return card?.getAttribute("data-status") || "";
}

function setCardStatus(serverId, status) {
  const card = document.getElementById("server-card-" + serverId);
  const badge = document.getElementById("status-badge-" + serverId);
  if (!card || !badge) return;
  const normalized = String(status || "unknown").toLowerCase();
  card.setAttribute("data-status", normalized);
  badge.className = "status-badge status-" + normalized;
  badge.textContent = normalized;
}

async function refreshServerStatusUntilChanged(serverId, previousStatus = "") {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const res = await fetch("/api/servers", { headers: authHeaders() });
      const servers = await res.json();
      if (!Array.isArray(servers)) continue;
      const match = servers.find((item) => item.id === serverId);
      if (!match) continue;
      setCardStatus(serverId, match.status);
      const next = String(match.status || "").toLowerCase();
      const prev = String(previousStatus || "").toLowerCase();
      if (!prev || next !== prev || next === "healthy") {
        showToast("Server status updated: " + next);
        return;
      }
    } catch {
      // keep polling until timeout
    }
  }
  window.location.reload();
}
