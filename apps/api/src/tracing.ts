import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

let activeSdk: NodeSDK | null = null;

export function initTracing(): NodeSDK | null {
  if (activeSdk) return activeSdk;

  const endpoint = process.env.TEMPO_HTTP_ENDPOINT;
  if (!endpoint) {
    console.log("[Tracing] TEMPO_HTTP_ENDPOINT not set, tracing disabled");
    return null;
  }

  console.log(`[Tracing] Initializing OpenTelemetry, sending traces to ${endpoint}`);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "flashcastr-api",
      [ATTR_SERVICE_VERSION]: "1.0.0",
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-http": { enabled: true },
        "@opentelemetry/instrumentation-graphql": { enabled: true },
        "@opentelemetry/instrumentation-pg": { enabled: true },
      }),
    ],
  });

  sdk.start();
  activeSdk = sdk;
  console.log("[Tracing] OpenTelemetry initialized successfully");
  return sdk;
}

export async function shutdownTracing(): Promise<void> {
  if (!activeSdk) return;
  const sdk = activeSdk;
  activeSdk = null;
  try {
    await sdk.shutdown();
    console.log("[Tracing] OpenTelemetry shut down");
  } catch (err) {
    console.error("[Tracing] Error shutting down", err);
  }
}
