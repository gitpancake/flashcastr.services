import { describe, expect, it } from "vitest";
import { Registry } from "prom-client";
import { withMetrics } from "./metrics.js";

async function counterValue(registry: Registry, name: string, service: string): Promise<number> {
  const metric = await registry.getSingleMetricAsString(name);
  void metric;
  const json = await registry.getMetricsAsJSON();
  const found = json.find((entry) => entry.name === name);
  const value = (found as { values: { labels: Record<string, string>; value: number }[] } | undefined)?.values.find(
    (v) => v.labels.service === service
  );
  return value?.value ?? 0;
}

describe("withMetrics", () => {
  it("increments the processed counter on an ack outcome", async () => {
    const registry = new Registry();
    const metrics = withMetrics(registry, "test-service");

    metrics.recordOutcome("ack");

    expect(await counterValue(registry, "flashcastr_consumer_messages_processed_total", "test-service")).toBe(1);
  });

  it("increments the requeued counter on a requeue outcome", async () => {
    const registry = new Registry();
    const metrics = withMetrics(registry, "test-service");

    metrics.recordOutcome("requeue");
    metrics.recordOutcome("requeue");

    expect(await counterValue(registry, "flashcastr_consumer_messages_requeued_total", "test-service")).toBe(2);
  });

  it("increments the dead-lettered counter on a dead outcome", async () => {
    const registry = new Registry();
    const metrics = withMetrics(registry, "test-service");

    metrics.recordOutcome("dead");

    expect(await counterValue(registry, "flashcastr_consumer_messages_deadlettered_total", "test-service")).toBe(1);
  });

  it("observes handler duration in the duration histogram", async () => {
    const registry = new Registry();
    const metrics = withMetrics(registry, "test-service");

    metrics.observeDuration(0.25);

    const json = await registry.getMetricsAsJSON();
    const histogram = json.find((entry) => entry.name === "flashcastr_consumer_message_duration_seconds") as
      | { values: { labels: Record<string, string>; metricName: string; value: number }[] }
      | undefined;
    const sum = histogram?.values.find(
      (v) => v.labels.service === "test-service" && v.metricName?.endsWith("_sum")
    );
    expect(sum?.value).toBe(0.25);
  });

  it("registers each metric once when withMetrics is called for multiple consumers sharing a registry", async () => {
    const registry = new Registry();
    withMetrics(registry, "service-a");
    withMetrics(registry, "service-b");

    const json = await registry.getMetricsAsJSON();
    const matches = json.filter((entry) => entry.name === "flashcastr_consumer_messages_processed_total");
    expect(matches).toHaveLength(1);
  });
});
