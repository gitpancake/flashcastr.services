import { Gauge, type Registry } from "prom-client";
import type { FlashcastrConsumer } from "./consumer.js";
import { QUEUES } from "./topology.js";

const GAUGE_NAME = "rabbitmq_queue_messages";
const DEFAULT_INTERVAL_MS = 30000;

function queueGauge(registry: Registry): Gauge<"queue"> {
  const existing = registry.getSingleMetric(GAUGE_NAME) as Gauge<"queue"> | undefined;
  if (existing) return existing;
  return new Gauge({
    name: GAUGE_NAME,
    help: "Messages waiting in a RabbitMQ queue as seen by this service",
    labelNames: ["queue"] as const,
    registers: [registry],
  });
}

/**
 * Periodically samples each consumer's queue and the dead-letter queue into
 * a gauge so a growing backlog or DLQ is visible in Prometheus. Returns a stop function.
 */
export function observeQueueDepths(
  registry: Registry,
  consumers: FlashcastrConsumer[],
  intervalMs = DEFAULT_INTERVAL_MS
): () => void {
  const gauge = queueGauge(registry);

  const sample = async () => {
    for (const consumer of consumers) {
      const depths = await consumer.queueDepths().catch(() => null);
      if (!depths) continue;
      gauge.set({ queue: consumer.queueName }, depths.queue);
      gauge.set({ queue: QUEUES.DEAD_LETTERS }, depths.deadLetters);
    }
  };

  const timer = setInterval(() => void sample(), intervalMs);
  timer.unref();
  void sample();
  return () => clearInterval(timer);
}
