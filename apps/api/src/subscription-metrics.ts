import type { ExecutionArgs, GraphQLError } from "graphql";
import type { Context, SubscribePayload } from "graphql-ws";

import { graphqlRequestsTotal, activeSubscriptionsTotal } from "./metrics.js";

export interface SubscriptionMetricsHooks {
  onSubscribe: (
    ctx: Context,
    id: string,
    payload: SubscribePayload,
  ) => Promise<ExecutionArgs | readonly GraphQLError[] | void>;
  onComplete: (ctx: Context, id: string, payload: SubscribePayload) => Promise<void>;
}

export function createSubscriptionMetricsHooks(): SubscriptionMetricsHooks {
  return {
    async onSubscribe(_ctx, _id, payload) {
      graphqlRequestsTotal.inc({
        operation_type: "subscription",
        operation_name: payload.operationName ?? "unknown",
      });
      activeSubscriptionsTotal.inc();
    },
    async onComplete() {
      activeSubscriptionsTotal.dec();
    },
  };
}
