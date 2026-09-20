import type { Pool } from "pg";
import type { ImageUrlConfig } from "@flashcastr/database";
import type { PubSubEngine } from "../pubsub.js";
import { createUserResolvers } from "./users.js";
import { createFlashResolvers } from "./flashes.js";
import { createCityResolvers } from "./cities.js";
import { createLeaderboardResolvers } from "./leaderboard.js";
import { createProgressResolvers } from "./progress.js";
import { createFlashIdentificationResolvers } from "./flash-identifications.js";
import { createUnifiedFlashResolvers } from "./unified-flash.js";
import { createSubscriptionResolvers } from "./subscriptions.js";

export function createResolvers(pool: Pool, pubsub: PubSubEngine, imageUrlConfig: ImageUrlConfig) {
  const modules = [
    createUserResolvers(pool),
    createFlashResolvers(pool, imageUrlConfig),
    createCityResolvers(pool),
    createLeaderboardResolvers(pool),
    createProgressResolvers(pool),
    createFlashIdentificationResolvers(pool),
    createUnifiedFlashResolvers(pool, imageUrlConfig),
    createSubscriptionResolvers(pubsub),
  ];

  const resolvers: Record<string, Record<string, unknown>> = {};

  for (const mod of modules) {
    for (const [type, fields] of Object.entries(mod)) {
      if (!resolvers[type]) resolvers[type] = {};
      Object.assign(resolvers[type], fields);
    }
  }

  return resolvers;
}
