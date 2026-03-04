const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { randomUUID } = require("crypto");

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const QUEUE_NAME = process.env.PROVISIONING_QUEUE_NAME || "provisioning";
const IMPORT_JOB_TIMEOUT_MS = Number(process.env.IMPORT_JOB_TIMEOUT_MS || 600000);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

const provisioningQueue = new Queue(QUEUE_NAME, { connection });

async function enqueueProvisionJob(type, payload = {}, meta = {}) {
  const options = {
    removeOnComplete: 200,
    removeOnFail: 500,
    // Avoid Redis counter reuse collisions after restarts/wipes.
    jobId: `job-${Date.now()}-${randomUUID()}`,
  };
  if (type === "import-repo" && Number.isFinite(IMPORT_JOB_TIMEOUT_MS) && IMPORT_JOB_TIMEOUT_MS > 0) {
    options.timeout = IMPORT_JOB_TIMEOUT_MS;
  }
  return provisioningQueue.add(type, { payload, meta }, options);
}

module.exports = {
  connection,
  QUEUE_NAME,
  provisioningQueue,
  enqueueProvisionJob,
};
