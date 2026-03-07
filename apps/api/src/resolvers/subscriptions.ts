import { subscribe, TOPICS } from "../pubsub.js";

export function createSubscriptionResolvers() {
  return {
    Subscription: {
      flashStored: {
        subscribe: () => subscribe(TOPICS.FLASH_STORED),
        resolve: (payload: unknown) => payload,
      },
      flashCasted: {
        subscribe: () => subscribe(TOPICS.FLASH_CASTED),
        resolve: (payload: unknown) => payload,
      },
    },
  };
}
