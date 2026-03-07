// Initialize tracing before all other imports
import { initTracing } from "./tracing.js";
initTracing();

import { config } from "dotenv";
config();

import http from "http";
import express from "express";
import cors from "cors";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { useServer } from "graphql-ws/lib/use/ws";
import { WebSocketServer } from "ws";
import amqplib from "amqplib";

import { getPool, closePool } from "@flashcastr/database";
import { intEnv, optionalEnv } from "@flashcastr/config";
import { createLogger } from "@flashcastr/logger";
import { EXCHANGES, ROUTING_KEYS, QUEUES } from "@flashcastr/rabbitmq";

import { typeDefs } from "./schema.js";
import { createResolvers } from "./resolvers/index.js";
import { publish, TOPICS } from "./pubsub.js";
import {
  registry,
  startMetricsServer,
  graphqlRequestsTotal,
  graphqlErrorsTotal,
  graphqlDurationSeconds,
  activeUsersTotal,
  totalFlashesCount,
} from "./metrics.js";

import type { FlashStoredPayload, FlashCastedPayload, MessageEnvelope } from "@flashcastr/shared-types";

const log = createLogger("api");

const PORT = intEnv("PORT", 4000);
const METRICS_PORT = intEnv("METRICS_PORT", 9094);
const RABBITMQ_URL = optionalEnv("RABBITMQ_URL", "");

const pool = getPool();

// Build executable schema for WebSocket subscriptions
const resolvers = createResolvers(pool);
const schema = makeExecutableSchema({ typeDefs, resolvers });

// Express + HTTP server
const app = express();
const httpServer = http.createServer(app);

// WebSocket server for GraphQL subscriptions
const wsServer = new WebSocketServer({
  server: httpServer,
  path: "/graphql",
});

const wsServerCleanup = useServer({ schema }, wsServer as unknown as Parameters<typeof useServer>[1]);

// Apollo Server v4
const metricsPlugin: ApolloServerPlugin<BaseContext> = {
  async requestDidStart() {
    const startTime = Date.now();
    let operationType = "unknown";
    let operationName = "unknown";

    return {
      async didResolveOperation(requestContext) {
        operationType = requestContext.operation?.operation || "unknown";
        operationName = requestContext.operationName || "anonymous";
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
  introspection: true,
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

// Update user and flash counts periodically
async function updateGauges() {
  try {
    const userResult = await pool.query("SELECT COUNT(*)::int as count FROM flashcastr_users WHERE deleted = false");
    activeUsersTotal.set(userResult.rows[0]?.count ?? 0);

    const flashResult = await pool.query("SELECT COUNT(*)::int as count FROM flashcastr_flashes WHERE deleted = false");
    totalFlashesCount.set(flashResult.rows[0]?.count ?? 0);
  } catch (error) {
    log.error("Error updating gauges:", error);
  }
}

// RabbitMQ subscription consumer
async function startSubscriptionConsumer(): Promise<amqplib.ChannelModel | null> {
  if (!RABBITMQ_URL) {
    log.warn("RABBITMQ_URL not set, subscriptions will not receive live events");
    return null;
  }

  try {
    const conn = await amqplib.connect(RABBITMQ_URL);
    const channel = await conn.createChannel();

    // Ensure queue exists
    await channel.assertQueue(QUEUES.API_SUBSCRIPTIONS, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": EXCHANGES.DLX,
        "x-dead-letter-routing-key": "api.subscriptions.dead",
        "x-max-length": 10000,
      },
    });
    await channel.bindQueue(QUEUES.API_SUBSCRIPTIONS, EXCHANGES.EVENTS, ROUTING_KEYS.FLASH_STORED);
    await channel.bindQueue(QUEUES.API_SUBSCRIPTIONS, EXCHANGES.EVENTS, ROUTING_KEYS.FLASH_CASTED);

    await channel.prefetch(10);

    channel.consume(QUEUES.API_SUBSCRIPTIONS, (msg) => {
      if (!msg) return;

      try {
        const envelope = JSON.parse(msg.content.toString()) as MessageEnvelope<unknown>;

        if (envelope.type === ROUTING_KEYS.FLASH_STORED) {
          const payload = envelope.payload as FlashStoredPayload;
          publish(TOPICS.FLASH_STORED, {
            flash_id: String(payload.flash_id),
            city: payload.city,
            player: payload.player,
            img: payload.img,
            ipfs_cid: payload.ipfs_cid,
            timestamp: String(payload.timestamp),
          });
        } else if (envelope.type === ROUTING_KEYS.FLASH_CASTED) {
          const payload = envelope.payload as FlashCastedPayload;
          publish(TOPICS.FLASH_CASTED, {
            flash_id: String(payload.flash_id),
            city: payload.city,
            player: payload.player,
            cast_hash: payload.cast_hash,
            user_fid: payload.user_fid,
            user_username: payload.user_username,
          });
        }

        channel.ack(msg);
      } catch (err) {
        log.error("Error processing subscription message:", err);
        channel.nack(msg, false, false);
      }
    });

    log.info("RabbitMQ subscription consumer started");
    return conn;
  } catch (err) {
    log.error("Failed to connect to RabbitMQ for subscriptions:", err);
    return null;
  }
}

// Start
async function main() {
  await server.start();

  app.use(cors());

  app.use(
    "/graphql",
    express.json(),
    expressMiddleware(server, {
      context: async ({ req }) => ({ req }),
    }) as unknown as express.RequestHandler
  );

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });

  // Start metrics server
  startMetricsServer(registry, METRICS_PORT);

  // Update gauges
  setInterval(updateGauges, 60000);
  updateGauges();

  // Start subscription consumer
  const rabbitConn = await startSubscriptionConsumer();

  httpServer.listen(PORT, () => {
    log.info(`GraphQL server ready at http://localhost:${PORT}/graphql`);
    log.info(`Subscriptions ready at ws://localhost:${PORT}/graphql`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    await server.stop();
    if (rabbitConn) await rabbitConn.close();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("Failed to start API:", err);
  process.exit(1);
});
