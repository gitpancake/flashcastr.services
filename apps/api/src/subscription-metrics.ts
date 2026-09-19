import type { ExecutionArgs, GraphQLError } from "graphql";
import type { Context, SubscribePayload } from "graphql-ws";

import { graphqlRequestsTotal, activeSubscriptionsTotal } from "./metrics.js";

export interface SubscriptionMetricsHooks {
  onSubscribe: (
    ctx: Context,
    id: string,
    payload: SubscribePayload,
  ) => Promise<ExecutionArgs | readonly GraphQLError[] | void>;
  onError: (
    ctx: Context,
    id: string,
    payload: SubscribePayload,
    errors: readonly GraphQLError[],
  ) => Promise<void>;
  onComplete: (ctx: Context, id: string, payload: SubscribePayload) => Promise<void>;
}

export function createSubscriptionMetricsHooks(): SubscriptionMetricsHooks {
  // graphql-ws reuses the same ctx object across onSubscribe/onError/onComplete calls for one
  // connection, and treats onError/onComplete as mutually exclusive terminal outcomes per id
  // EXCEPT for a mid-stream subscription error, which fires both. Tracking ids per-ctx here
  // makes the gauge decrement idempotent regardless of which terminal hook fires, or how many times.
  const activeIds = new WeakMap<Context, Set<string>>();

  function clearIfActive(ctx: Context, id: string): boolean {
    return activeIds.get(ctx)?.delete(id) ?? false;
  }

  return {
    async onSubscribe(ctx, id, payload) {
      graphqlRequestsTotal.inc({
        operation_type: "subscription",
        operation_name: payload.operationName ?? "unknown",
      });
      activeSubscriptionsTotal.inc();

      let ids = activeIds.get(ctx);
      if (!ids) {
        ids = new Set();
        activeIds.set(ctx, ids);
      }
      ids.add(id);
    },
    async onError(ctx, id) {
      if (clearIfActive(ctx, id)) activeSubscriptionsTotal.dec();
    },
    async onComplete(ctx, id) {
      if (clearIfActive(ctx, id)) activeSubscriptionsTotal.dec();
    },
  };
}
