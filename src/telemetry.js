const { NodeSDK } = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

let sdk = null;

function initTelemetry() {
  if ((process.env.OTEL_ENABLED || "false").toLowerCase() !== "true") {
    return;
  }
  if (sdk) return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const traceExporter = endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined;

  sdk = new NodeSDK({
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  process.on("SIGTERM", async () => {
    try {
      await sdk.shutdown();
    } catch (_error) {
      // no-op
    }
  });
}

module.exports = {
  initTelemetry,
};
