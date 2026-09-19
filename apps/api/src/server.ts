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

import { getPool, closePool } from "@flashcastr/database";
import { intEnv, optionalEnv } from "@flashcastr/config";
import { createLogger, flushLogs } from "@flashcastr/logger";

import { typeDefs } from "./schema.js";
import { createResolvers } from "./resolvers/index.js";
import type { PubSubEngine } from "./pubsub.js";
import { InMemoryPubSub } from "./pubsub.js";
import { SubscriptionConsumer } from "./subscription-consumer.js";
import { createSubscriptionMetricsHooks } from "./subscription-metrics.js";
import { shutdownTracing } from "./tracing.js";
import { scheduleGaugeUpdates } from "./gauges.js";
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
const RABBITMQ_URL = optionalEnv("RABBITMQ_URL", "");
const TRUST_PROXY_HOPS = intEnv("TRUST_PROXY_HOPS", 1);
const CORS_ORIGINS = optionalEnv("CORS_ORIGINS", "");
const INTROSPECTION_ENABLED = optionalEnv("GRAPHQL_INTROSPECTION", "true") === "true";

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

// Build executable schema for WebSocket subscriptions
const resolvers = createResolvers(pool, pubsub);
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

async function startSubscriptionConsumer(pubsub: PubSubEngine): Promise<SubscriptionConsumer | null> {
  if (!RABBITMQ_URL) {
    log.warn("RABBITMQ_URL not set, subscriptions will not receive live events");
    return null;
  }

  const consumer = new SubscriptionConsumer(RABBITMQ_URL, pubsub);
  try {
    await consumer.startConsuming();
    log.info("RabbitMQ subscription consumer started");
    return consumer;
  } catch (err) {
    log.error("Failed to connect to RabbitMQ for subscriptions:", err);
    return null;
  }
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

  const subscriptionConsumer = await startSubscriptionConsumer(pubsub);

  app.get("/health", async (_req, res) => {
    const database = await databaseHealth();
    const subscriptions = !RABBITMQ_URL ? "disabled" : subscriptionConsumer?.isConsuming() ? "ok" : "degraded";
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
    if (subscriptionConsumer) await subscriptionConsumer.close();
    await closePool();
    await shutdownTracing();
    await flushLogs();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export { main as startApi };
