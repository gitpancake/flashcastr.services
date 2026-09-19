import { Registry, Counter, Histogram } from "prom-client";

export type ConsumerOutcome = "ack" | "requeue" | "dead";

export interface ConsumerMetrics {
  recordOutcome(outcome: ConsumerOutcome): void;
  observeDuration(seconds: number): void;
}

function counterFor(registry: Registry, name: string, help: string): Counter<"service"> {
  const existing = registry.getSingleMetric(name) as Counter<"service"> | undefined;
  if (existing) return existing;
  return new Counter({ name, help, labelNames: ["service"] as const, registers: [registry] });
}

function durationHistogramFor(registry: Registry, name: string, help: string): Histogram<"service"> {
  const existing = registry.getSingleMetric(name) as Histogram<"service"> | undefined;
  if (existing) return existing;
  return new Histogram({ name, help, labelNames: ["service"] as const, registers: [registry] });
}

export function withMetrics(registry: Registry, serviceName: string): ConsumerMetrics {
  const processed = counterFor(
    registry,
    "flashcastr_consumer_messages_processed_total",
    "Messages successfully processed and acked by a FlashcastrConsumer"
  );
  const requeued = counterFor(
    registry,
    "flashcastr_consumer_messages_requeued_total",
    "Messages requeued by a FlashcastrConsumer after a transient or retryable failure"
  );
  const deadLettered = counterFor(
    registry,
    "flashcastr_consumer_messages_deadlettered_total",
    "Messages dead-lettered by a FlashcastrConsumer after exhausting retries or a fatal error"
  );
  const duration = durationHistogramFor(
    registry,
    "flashcastr_consumer_message_duration_seconds",
    "Wall time spent in a FlashcastrConsumer's handleMessage"
  );

  const labels = { service: serviceName };

  return {
    recordOutcome(outcome) {
      if (outcome === "ack") processed.inc(labels);
      else if (outcome === "requeue") requeued.inc(labels);
      else deadLettered.inc(labels);
    },
    observeDuration(seconds) {
      duration.observe(labels, seconds);
    },
  };
}
