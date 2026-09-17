import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { ActionLoggingFarcasterGateway } from "./actions/actionLoggingFarcasterGateway.js";
import { PostgresActionLog } from "./actions/postgresActionLog.js";
import type { Env } from "./config/env.js";
import { HubFarcasterGateway } from "./farcaster/hubFarcasterGateway.js";
import { NeynarReader } from "./farcaster/neynarReader.js";
import { isSignerRegisteredOnChain } from "./farcaster/signerVerification.js";
import { buildConversationGraph } from "./graphs/conversation/conversationGraph.js";
import { createConversationTools } from "./graphs/conversation/conversationTools.js";
import { buildDigestGraph } from "./graphs/digest/digestGraph.js";
import { DigestCommand } from "./inbound/digestCommand.js";
import { InboundCastRepository } from "./inbound/inboundCastRepository.js";
import { InboundDispatcher } from "./inbound/inboundDispatcher.js";
import { MentionPoller } from "./inbound/mentionPoller.js";
import { InvaderSpotterClient } from "./invaders/invaderSpotterClient.js";
import { InvaderSpotterSession } from "./invaders/invaderSpotterSession.js";
import { FireworksModelFactory } from "./llm/languageModelFactory.js";
import type { Logger } from "./logging/logger.js";
import { AgentMemory } from "./memory/agentMemory.js";
import { createDatabasePool, ensureSchema, type DatabasePool } from "./persistence/database.js";
import { SourceRegistry } from "./sources/sourceRegistry.js";
import { createDefaultCastValidator } from "./validation/defaultCastValidator.js";

export interface Application {
  readonly pool: DatabasePool;
  readonly memory: AgentMemory;
  readonly spotter: InvaderSpotterClient;
  readonly digestCommand: DigestCommand;
  readonly dispatcher: InboundDispatcher;
  readonly poller: MentionPoller;
  readonly hubGateway: HubFarcasterGateway;
  shutdown(): Promise<void>;
}

export async function assembleApplication(env: Env, logger: Logger): Promise<Application> {
  const pool = createDatabasePool(env.DATABASE_URL);
  await ensureSchema(pool);

  const checkpointer = PostgresSaver.fromConnString(env.DATABASE_URL, { schema: "langgraph" });
  await checkpointer.setup();
  const store = PostgresStore.fromConnString(env.DATABASE_URL, { schema: "langgraph_store" });
  await store.setup();

  const actionLog = new PostgresActionLog(pool);
  const memory = new AgentMemory(store);
  const spotter = new InvaderSpotterClient(new InvaderSpotterSession());
  const models = new FireworksModelFactory(env);
  const validator = createDefaultCastValidator();
  const hubGateway = new HubFarcasterGateway({
    hubHttpUrl: env.HUB_HTTP_URL,
    hubApiKey: env.NEYNAR_API_KEY,
    fid: env.FARCASTER_FID,
    signerPrivateKeyHex: env.FARCASTER_SIGNER_PRIVATE_KEY,
    defaultChannelId: env.FARCASTER_CHANNEL_ID,
  });
  const farcaster = new ActionLoggingFarcasterGateway(hubGateway, actionLog, "farcaster");
  const reader = new NeynarReader(env.NEYNAR_API_KEY);

  const digestGraph = buildDigestGraph({
    spotter,
    sources: SourceRegistry.fromEnv(env),
    memory,
    models,
    validator,
    farcaster,
    actionLog,
    channelId: env.FARCASTER_CHANNEL_ID,
    checkpointer,
    store,
  });
  const conversationGraph = buildConversationGraph({
    reader,
    memory,
    models,
    tools: createConversationTools({ spotter, memory }),
    validator,
    farcaster,
    actionLog,
    checkpointer,
    store,
  });

  const inbox = new InboundCastRepository(pool);
  const dispatcher = new InboundDispatcher(conversationGraph, inbox, actionLog, logger, env.FARCASTER_FID);
  const poller = new MentionPoller(reader, dispatcher, env.FARCASTER_FID, env.MENTION_POLL_INTERVAL_MS, logger);
  const digestCommand = new DigestCommand(digestGraph, actionLog, logger);

  return {
    pool,
    memory,
    spotter,
    digestCommand,
    dispatcher,
    poller,
    hubGateway,
    async shutdown() {
      poller.stop();
      await dispatcher.drain();
      await Promise.all([checkpointer.end(), store.stop(), pool.end()]);
    },
  };
}

export async function verifySigner(env: Env, hubGateway: HubFarcasterGateway, logger: Logger): Promise<void> {
  const publicKey = await hubGateway.signerPublicKeyHex();
  const registered = await isSignerRegisteredOnChain(env.HUB_HTTP_URL, env.NEYNAR_API_KEY, env.FARCASTER_FID, publicKey);
  if (registered) {
    logger.info({ fid: env.FARCASTER_FID, publicKey }, "signer registered on-chain");
    return;
  }
  throw new Error(`Signer ${publicKey} is not registered on-chain for fid ${env.FARCASTER_FID}`);
}
