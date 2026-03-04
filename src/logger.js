const pino = require("pino");

const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const logger = pino({
  level: LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.x-api-key",
      "headers.authorization",
      "headers.x-api-key",
      "metadata.token",
    ],
    censor: "[REDACTED]",
  },
});

module.exports = logger;
