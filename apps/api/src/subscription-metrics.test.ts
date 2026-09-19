import { beforeEach, describe, expect, it } from "vitest";

import { createSubscriptionMetricsHooks } from "./subscription-metrics.js";
import { graphqlRequestsTotal, activeSubscriptionsTotal } from "./metrics.js";

async function activeSubscriptionsValue(): Promise<number> {
  const metric = await activeSubscriptionsTotal.get();
  return metric.values[0]?.value ?? 0;
}

async function graphqlRequestsValue(labels: Record<string, string>): Promise<number> {
  const metric = await graphqlRequestsTotal.get();
  const match = metric.values.find((entry) =>
    Object.entries(labels).every(([key, value]) => entry.labels[key as keyof typeof entry.labels] === value),
  );
  return match?.value ?? 0;
}

describe("createSubscriptionMetricsHooks", () => {
  beforeEach(() => {
    graphqlRequestsTotal.reset();
    activeSubscriptionsTotal.reset();
  });

  it("onSubscribe counts the operation and bumps the active gauge", async () => {
    const { onSubscribe } = createSubscriptionMetricsHooks();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await onSubscribe({} as any, "conn-1", { operationName: "MySub" } as any);

    expect(await graphqlRequestsValue({ operation_type: "subscription", operation_name: "MySub" })).toBe(1);
    expect(await activeSubscriptionsValue()).toBe(1);
  });

  it("onSubscribe falls back to 'unknown' when payload has no operationName", async () => {
    const { onSubscribe } = createSubscriptionMetricsHooks();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await onSubscribe({} as any, "conn-2", {} as any);

    expect(await graphqlRequestsValue({ operation_type: "subscription", operation_name: "unknown" })).toBe(1);
  });

  it("onComplete decrements the active gauge", async () => {
    const { onSubscribe, onComplete } = createSubscriptionMetricsHooks();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await onSubscribe({} as any, "conn-3", { operationName: "MySub" } as any);
    expect(await activeSubscriptionsValue()).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await onComplete({} as any, "conn-3", {} as any);
    expect(await activeSubscriptionsValue()).toBe(0);
  });
});
