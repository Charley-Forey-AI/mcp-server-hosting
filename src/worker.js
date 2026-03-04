const { Worker } = require("bullmq");
const {
  migrate,
  getServerById,
  setProvisioningJobStatus,
  createProvisioningJobRecord,
  insertAuditLog,
} = require("./db");
const { connection, QUEUE_NAME } = require("./queue");
const { startServerContainer, stopServerContainer } = require("./dockerRunner");
const { runImportJob } = require("./importPipeline");
const { initTelemetry } = require("./telemetry");
const logger = require("./logger");

async function processProvisioningJob(job) {
  const { payload = {}, meta = {} } = job.data || {};
  const action = job.name;
  const serverId = payload.serverId;

  await createProvisioningJobRecord(job.id, action, serverId, "running", payload, meta);

  try {
    let result;
    if (action === "import-repo") {
      result = await runImportJob(job);
    } else if (action === "start-server") {
      if (!serverId) throw new Error("serverId missing");
      const server = await getServerById(serverId);
      if (!server) throw new Error(`server '${serverId}' not found`);
      result = await startServerContainer(server, {
        recreate: Boolean(payload.recreate),
        forcePull: Boolean(payload.forcePull),
      });
    } else if (action === "stop-server") {
      if (!serverId) throw new Error("serverId missing");
      result = await stopServerContainer(serverId);
    } else {
      throw new Error(`unknown action '${action}'`);
    }

    await setProvisioningJobStatus(job.id, "completed", result);
    await insertAuditLog({
      actorSub: meta.actorSub || "system-worker",
      actorRoles: meta.actorRoles || [],
      action: `queue.${action}`,
      resourceType: "server",
      resourceId: serverId || result.serverId || null,
      requestPath: "/worker",
      method: "ASYNC",
      metadata: result,
    });
    return result;
  } catch (error) {
    const message = String(error.message || error);
    await setProvisioningJobStatus(job.id, "failed", { error: message });
    throw error;
  }
}

async function bootstrapWorker() {
  initTelemetry();
  await migrate();
  const worker = new Worker(QUEUE_NAME, processProvisioningJob, { connection });
  worker.on("ready", () => logger.info({ queue: QUEUE_NAME }, "Provisioning worker ready"));
  worker.on("completed", (job) => logger.info({ jobId: job.id }, "Job completed"));
  worker.on("failed", (job, error) => logger.error({ jobId: job && job.id, err: error.message }, "Job failed"));
}

bootstrapWorker().catch((error) => {
  logger.error({ err: error.message }, "Worker bootstrap failed");
  process.exit(1);
});
