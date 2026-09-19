import type { PubSubEngine } from "../pubsub.js";
import { TOPICS } from "../pubsub.js";

export function createSubscriptionResolvers(pubsub: PubSubEngine) {
  return {
    Subscription: {
      flashStored: {
        subscribe: () => pubsub.subscribe(TOPICS.FLASH_STORED),
        resolve: (payload: unknown) => payload,
      },
      flashCasted: {
        subscribe: () => pubsub.subscribe(TOPICS.FLASH_CASTED),
        resolve: (payload: unknown) => payload,
      },
    },
  };
}
