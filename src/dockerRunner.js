const Docker = require("dockerode");
const fs = require("fs");
const { resolveCommandEnvSecrets } = require("./secrets");

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const DOCKER_NETWORK = process.env.DOCKER_NETWORK || "bridge";
const DOCKER_BRIDGE_FALLBACK = process.env.DOCKER_BRIDGE_FALLBACK || "mcp_net";
const DOCKER_IMAGE_PULL = (process.env.DOCKER_IMAGE_PULL || "false").toLowerCase() === "true";
const RUNNING_IN_DOCKER = fs.existsSync("/.dockerenv");

const docker = new Docker({ socketPath: DOCKER_SOCKET });

function containerNameForServer(serverId) {
  return `mcp-server-${String(serverId).replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

async function parseContainerSpec(server) {
  const image = server.command;
  if (!image) {
    throw new Error("server.command must be set to a Docker image name");
  }
  const cmd = Array.isArray(server.commandArgs) && server.commandArgs.length ? server.commandArgs : undefined;
  const envMap = server.commandEnv && typeof server.commandEnv === "object" ? server.commandEnv : {};
  const envSecrets = await resolveCommandEnvSecrets(
    server.commandEnvSecrets && typeof server.commandEnvSecrets === "object" ? server.commandEnvSecrets : {},
  );
  const env = Object.entries({
    PORT: String(server.internalPort),
    MCP_PORT: String(server.internalPort),
    MCP_HOST: "0.0.0.0",
    ...envMap,
    ...envSecrets,
  }).map(
    ([k, v]) => `${k}=${String(v)}`,
  );
  return { image, cmd, env };
}

async function imageExists(image) {
  const images = await docker.listImages({ filters: { reference: [image] } });
  return images.length > 0;
}

async function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (followErr) => {
          if (followErr) return reject(followErr);
          return resolve();
        },
        () => {},
      );
    });
  });
}

async function removeContainerIfExists(name) {
  const existing = await getContainerByName(name);
  if (!existing) return false;
  const inspect = await existing.inspect();
  if (inspect.State.Running) {
    await existing.stop({ t: 10 });
  }
  await existing.remove({ force: true });
  return true;
}

async function getContainerByName(name) {
  const containers = await docker.listContainers({ all: true, filters: { name: [name] } });
  if (!containers.length) return null;
  return docker.getContainer(containers[0].Id);
}

async function resolveNetworkMode() {
  if (!(DOCKER_NETWORK === "host" && RUNNING_IN_DOCKER)) {
    return DOCKER_NETWORK;
  }
  const selfId = process.env.HOSTNAME;
  if (selfId) {
    try {
      const self = docker.getContainer(selfId);
      const inspect = await self.inspect();
      const current = String(inspect?.HostConfig?.NetworkMode || "").trim();
      if (current) return current;
    } catch {
      // Fallback below.
    }
  }
  return DOCKER_BRIDGE_FALLBACK;
}

async function startServerContainer(server, options = {}) {
  const recreate = Boolean(options.recreate);
  const forcePull = Boolean(options.forcePull);
  const name = containerNameForServer(server.id);
  const { image, cmd, env } = await parseContainerSpec(server);
  const networkMode = await resolveNetworkMode();

  if (DOCKER_IMAGE_PULL || forcePull || !(await imageExists(image))) {
    await pullImage(image);
  }

  if (recreate) {
    await removeContainerIfExists(name);
  }

  const existing = await getContainerByName(name);
  if (existing) {
    const inspect = await existing.inspect();
    if (!inspect.State.Running) {
      await existing.start();
      return { ok: true, message: "container started", containerName: name, containerId: inspect.Id };
    }
    return { ok: true, message: "already running", containerName: name, containerId: inspect.Id };
  }

  const container = await docker.createContainer({
    name,
    Image: image,
    Cmd: cmd,
    Env: env,
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: networkMode,
    },
  });
  await container.start();
  return { ok: true, message: "container created and started", containerName: name, containerId: container.id };
}

async function stopServerContainer(serverId) {
  const name = containerNameForServer(serverId);
  const container = await getContainerByName(name);
  if (!container) return { ok: false, message: "container not found", containerName: name };

  const inspect = await container.inspect();
  if (inspect.State.Running) {
    await container.stop({ t: 10 });
  }
  return { ok: true, message: "container stopped", containerName: name, containerId: inspect.Id };
}

module.exports = {
  startServerContainer,
  stopServerContainer,
  containerNameForServer,
  removeContainerIfExists,
};
