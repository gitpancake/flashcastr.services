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
    const ctx = {} as any;

    await onSubscribe(ctx, "conn-3", { operationName: "MySub" } as any);
    expect(await activeSubscriptionsValue()).toBe(1);

    await onComplete(ctx, "conn-3", {} as any);
    expect(await activeSubscriptionsValue()).toBe(0);
  });

  it("onError decrements the active gauge for a subscribe that failed before ever completing", async () => {
    const { onSubscribe, onError } = createSubscriptionMetricsHooks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = {} as any;

    await onSubscribe(ctx, "conn-4", { operationName: "BadSub" } as any);
    expect(await activeSubscriptionsValue()).toBe(1);

    await onError(ctx, "conn-4", {} as any, []);
    expect(await activeSubscriptionsValue()).toBe(0);
  });

  it("does not double-decrement when a mid-stream error fires both onError and onComplete for the same id", async () => {
    const { onSubscribe, onError, onComplete } = createSubscriptionMetricsHooks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = {} as any;

    await onSubscribe(ctx, "conn-5", { operationName: "MySub" } as any);
    await onError(ctx, "conn-5", {} as any, []);
    await onComplete(ctx, "conn-5", {} as any);

    expect(await activeSubscriptionsValue()).toBe(0);
  });

  it("does not double-decrement when onComplete then onError fire for the same id", async () => {
    const { onSubscribe, onError, onComplete } = createSubscriptionMetricsHooks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = {} as any;

    await onSubscribe(ctx, "conn-6", { operationName: "MySub" } as any);
    await onComplete(ctx, "conn-6", {} as any);
    await onError(ctx, "conn-6", {} as any, []);

    expect(await activeSubscriptionsValue()).toBe(0);
  });

  it("tracks concurrent subscriptions on the same connection independently", async () => {
    const { onSubscribe, onComplete } = createSubscriptionMetricsHooks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = {} as any;

    await onSubscribe(ctx, "sub-a", { operationName: "SubA" } as any);
    await onSubscribe(ctx, "sub-b", { operationName: "SubB" } as any);
    expect(await activeSubscriptionsValue()).toBe(2);

    await onComplete(ctx, "sub-a", {} as any);
    expect(await activeSubscriptionsValue()).toBe(1);

    await onComplete(ctx, "sub-b", {} as any);
    expect(await activeSubscriptionsValue()).toBe(0);
  });
});
