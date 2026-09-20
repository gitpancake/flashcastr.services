import { config } from "dotenv";
config();

import http from "http";
import express from "express";
import cors from "cors";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { useServer } from "graphql-ws/use/ws";
import { WebSocketServer } from "ws";

import { getPool, closePool, type ImageUrlConfig } from "@flashcastr/database";
import { intEnv, optionalEnv, requireEnv } from "@flashcastr/config";
import { createLogger } from "@flashcastr/logger";

import { typeDefs } from "./schema.js";
import { createResolvers } from "./resolvers/index.js";
import type { PubSubEngine } from "./pubsub.js";
import { InMemoryPubSub } from "./pubsub.js";
import { PostgresSubscriptionBridge } from "./subscription-bridge.js";
import { createSubscriptionMetricsHooks } from "./subscription-metrics.js";
import { scheduleGaugeUpdates } from "./gauges.js";
import { createB2TokenProvider } from "./b2/tokenProvider.js";
import { createImageRedirectHandler } from "./imageRedirect.js";
import {
  registry,
  startMetricsServer,
  graphqlRequestsTotal,
  graphqlErrorsTotal,
  graphqlDurationSeconds,
} from "./metrics.js";

const log = createLogger("api");

const PORT = intEnv("PORT", 4000);
const METRICS_PORT = intEnv("METRICS_PORT", 9094);
const TRUST_PROXY_HOPS = intEnv("TRUST_PROXY_HOPS", 1);
const CORS_ORIGINS = optionalEnv("CORS_ORIGINS", "");
const INTROSPECTION_ENABLED = optionalEnv("GRAPHQL_INTROSPECTION", "true") === "true";
const API_PUBLIC_BASE = optionalEnv("API_PUBLIC_BASE", "http://localhost:4000");
const ORIGIN = optionalEnv("ORIGIN", "https://api.space-invaders.com");
const B2_DOWNLOAD_BASE = optionalEnv("B2_DOWNLOAD_BASE", "https://f004.backblazeb2.com");
const B2_BUCKET = optionalEnv("B2_BUCKET", "flashcastr-images");

function corsOptions() {
  if (!CORS_ORIGINS) return undefined;
  return { origin: CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean) };
}

function rootFieldName(requestContext: { operation?: { selectionSet: { selections: readonly { kind: string; name?: { value: string } }[] } } }): string {
  const first = requestContext.operation?.selectionSet.selections.find((s) => s.kind === "Field");
  return first?.name?.value ?? "unknown";
}

const pool = getPool();
const pubsub = new InMemoryPubSub();

const imageUrlConfig: ImageUrlConfig = {
  apiPublicBase: API_PUBLIC_BASE,
  origin: ORIGIN,
};

const b2TokenProvider = createB2TokenProvider({
  keyId: requireEnv("B2_API_KEY_ID"),
  applicationKey: requireEnv("B2_API_KEY"),
  bucketId: requireEnv("B2_BUCKET_ID"),
});

// Build executable schema for WebSocket subscriptions
const resolvers = createResolvers(pool, pubsub, imageUrlConfig);
const schema = makeExecutableSchema({ typeDefs, resolvers });

// Express + HTTP server
const app = express();
app.set("trust proxy", TRUST_PROXY_HOPS);
const httpServer = http.createServer(app);

// WebSocket server for GraphQL subscriptions
const wsServer = new WebSocketServer({
  server: httpServer,
  path: "/graphql",
});

const wsServerCleanup = useServer({ schema, ...createSubscriptionMetricsHooks() }, wsServer);

// Apollo Server v4
const metricsPlugin: ApolloServerPlugin<BaseContext> = {
  async requestDidStart() {
    const startTime = Date.now();
    let operationType = "unknown";
    let operationName = "unknown";

    return {
      async didResolveOperation(requestContext) {
        operationType = requestContext.operation?.operation || "unknown";
        operationName = rootFieldName(requestContext);
        graphqlRequestsTotal.inc({ operation_type: operationType, operation_name: operationName });
      },
      async willSendResponse() {
        const duration = (Date.now() - startTime) / 1000;
        graphqlDurationSeconds.observe({ operation_type: operationType, operation_name: operationName }, duration);
      },
      async didEncounterErrors() {
        graphqlErrorsTotal.inc({ operation_type: operationType, operation_name: operationName });
      },
    };
  },
};

const server = new ApolloServer({
  schema,
  introspection: INTROSPECTION_ENABLED,
  plugins: [
    ApolloServerPluginDrainHttpServer({ httpServer }),
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await wsServerCleanup.dispose();
          },
        };
      },
    },
    metricsPlugin,
  ],
});

async function startSubscriptionBridge(pubsub: PubSubEngine): Promise<PostgresSubscriptionBridge> {
  const bridge = new PostgresSubscriptionBridge(requireEnv("DATABASE_URL"), pubsub);
  await bridge.start();
  log.info("Postgres subscription bridge listening");
  return bridge;
}

async function databaseHealth(): Promise<"ok" | "error"> {
  try {
    await pool.query("SELECT 1");
    return "ok";
  } catch {
    return "error";
  }
}

// Start
async function main() {
  await server.start();

  app.use(cors(corsOptions()));

  app.use(
    "/graphql",
    express.json(),
    expressMiddleware(server, {
      context: async ({ req }: { req: express.Request }) => ({ req }),
    })
  );

  startMetricsServer(registry, METRICS_PORT);

  scheduleGaugeUpdates(pool, log);

  const subscriptionBridge = await startSubscriptionBridge(pubsub);

  app.get(
    "/i/:flash_id",
    createImageRedirectHandler(pool, b2TokenProvider, {
      b2DownloadBase: B2_DOWNLOAD_BASE,
      b2Bucket: B2_BUCKET,
    })
  );

  app.get("/health", async (_req, res) => {
    const database = await databaseHealth();
    const subscriptions = subscriptionBridge.isListening() ? "ok" : "degraded";
    const status = database === "error" ? "error" : subscriptions === "degraded" ? "degraded" : "ok";
    res.status(database === "error" ? 503 : 200).json({ status, checks: { database, subscriptions }, timestamp: Date.now() });
  });

  httpServer.listen(PORT, () => {
    log.info(`GraphQL server ready at http://localhost:${PORT}/graphql`);
    log.info(`Subscriptions ready at ws://localhost:${PORT}/graphql`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    await server.stop();
    await subscriptionBridge.close();
    await closePool();
    await log.flush();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export { main as startApi };
