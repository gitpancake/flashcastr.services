import { connectRabbitMQ, disconnectRabbitMQ, createPublisher, createSubscriber, onReconnect } from '../rabbitmq/index.js';
import { getAgentDb, runAgentMigrations, disconnectAgentDb } from '../db/agent-db.js';
import type { AgentDb } from '../db/agent-db.js';
import { openLocalDb, runLocalMigrations } from '../db/local.js';
import type { LocalDb, LocalDbHandle } from '../db/local.js';
import { DEFAULT_TIMEZONE } from '../config/timezone.js';
import { createMetricsRegistry, startMetricsServer, Counter, Histogram, Gauge } from '../metrics/index.js';
import type { Registry } from '../metrics/index.js';
import { ROUTING_KEYS } from '../events/routing-keys.js';
import { createLifeEvent } from '../events/types.js';
import type { LifeEvent, ContentReadyPayload, AgentHeartbeatPayload, AgentMetaPayload, AgentErrorPayload, ReconcileRequestPayload, ReconcileProgressPayload, ReconcileCompletePayload } from '../events/types.js';
import type { AIClient } from './ai-client.js';

export interface LocalDbConfig {
  /** Path to the SQLite file (e.g. /data/local.db). Created if it doesn't exist. */
  sqlitePath: string;
  /** Path to the Drizzle migrations folder for this service's local schema. */
  migrationsFolder: string;
}

export interface AgentDbConfig {
  /** Path to the Drizzle migrations folder for this agent's PG schema. */
  migrationsFolder: string;
}

export interface ProcessConfig {
  name: string;
  checkIntervalMs?: number;
  metricsPort?: number;
  /** Optional local SQLite database (display-sync only). */
  localDb?: LocalDbConfig;
  /** Per-agent PostgreSQL database. Reads DATABASE_URL for agent DB. */
  agentDb?: AgentDbConfig;
  /** Skip settings loading entirely (OV read + CONFIG_UPDATED subscription). For event-driven services that don't use settings. */
  skipSettings?: boolean;
  /**
   * Agent identity for heartbeat + meta broadcasts. When set, createProcess()
   * auto-emits heartbeat after every tick and meta on startup.
   * Agents can also call ctx.publishAgentMeta() after nightly refinement.
   */
  agentMeta?: {
    kind: 'agent' | 'module' | 'broadcast' | 'service';
    domain: string;
    role: string;
  };
  /**
   * Called once after RabbitMQ connect, before the first tick. Return an array of
   * ContentReadyPayload to rehydrate the gateway's display-sync cache on restart.
   * Rate-limited to 50 events/sec with 0–30s startup jitter.
   */
  onBackfill?: (ctx: ProcessContext) => Promise<ContentReadyPayload[]>;
  subscriptions?: {
    queueName: string;
    patterns: string[];
    handler: (event: LifeEvent, ctx: ProcessContext) => Promise<void>;
  }[];
  onTick: (ctx: ProcessContext) => Promise<void>;
  onStart?: (ctx: ProcessContext) => Promise<void>;
  setupPush?: (triggerTick: () => void, ctx: ProcessContext) => Promise<{ close: () => Promise<void> } | void>;
  /**
   * When provided, createProcess() subscribes to RECONCILE_REQUEST and calls
   * run() to republish all display data for this agent.
   * Rate-limited to 50 emits/sec. RECONCILE_PROGRESS published every 100 emits.
   */
  reconcile?: {
    /** Informational: source table/entity names, used for logging. */
    sources: string[];
    /**
     * Called when a matching RECONCILE_REQUEST arrives. Re-emit display events
     * by calling emit(routingKey, payload[, weight]) for each entity.
     *
     * The optional weight param lets bulk emitters credit the progress counter
     * accurately when one call represents N logical items. Defaults to 1.
     */
    run: (ctx: ProcessContext, emit: (routingKey: string, payload: unknown, weight?: number) => Promise<void>) => Promise<void>;
  };
}

export interface ProcessContext {
  /** Agent's own PG (DATABASE_URL) — owned tables. Only available if agentDb config was provided. */
  agentDb?: AgentDb;
  /** Local SQLite — only used by display-sync. */
  localDb?: LocalDb;
  publisher: ReturnType<typeof createPublisher>;
  channel: Awaited<ReturnType<typeof connectRabbitMQ>>;
  settings: Record<string, string>;
  timezone: string;
  registry: Registry;
  ai?: AIClient;
  /** Broadcast updated agent meta (call after nightly refinement). Only available when agentMeta config is set. */
  publishAgentMeta?: (overrides?: Partial<AgentMetaPayload>) => void;
  /** Broadcast a structured agent error. Only available when agentMeta config is set. */
  publishAgentError?: (code: string, message: string, context?: Record<string, unknown>) => void;
}

/** Load settings from OV directly — no orchestrator middleman. */
async function loadSettingsFromOV(ctx: ProcessContext, name: string): Promise<void> {
  try {
    const { loadUserContext } = await import('./context-store.js');
    const userCtx = await loadUserContext();

    const freshSettings: Record<string, string> = {};
    const parseKV = (text: string) => {
      for (const line of text.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key && value && !key.startsWith('#')) freshSettings[key] = value;
      }
    };

    if (userCtx.profile) parseKV(userCtx.profile);
    for (const content of Object.values(userCtx.preferences)) {
      parseKV(content);
    }

    // Replace all settings (not additive — removed keys must be cleared)
    for (const k of Object.keys(ctx.settings)) delete ctx.settings[k];
    Object.assign(ctx.settings, freshSettings);
    if (freshSettings.timezone) ctx.timezone = freshSettings.timezone;
    console.log(`[${name}] Config loaded from OV: ${Object.keys(freshSettings).length} settings`);

    const missingProfile = userCtx.profile === null;
    const missingConstraints = userCtx.constraints === null;
    if (missingProfile || missingConstraints) {
      console.warn(`[${name}] Startup context partially degraded — profile or constraints failed to load after retries`);
      ctx.publishAgentError?.('context_read_failed', 'Startup context partially degraded — profile or constraints failed to load after retries', { missingProfile, missingConstraints });
    }
  } catch (err) {
    console.warn(`[${name}] Failed to load settings from OV:`, (err as Error).message);
  }
}

/** Wire the RECONCILE_REQUEST subscription for an agent. Extracted to keep createProcess readable. */
async function subscribeReconcile(
  channel: Awaited<ReturnType<typeof connectRabbitMQ>>,
  name: string,
  reconcileConfig: NonNullable<ProcessConfig['reconcile']>,
  ctx: ProcessContext,
): Promise<void> {
  let reconcileRunning = false;

  await createSubscriber(channel, {
    queueName: `${name}.reconcile`,
    patterns: [ROUTING_KEYS.RECONCILE_REQUEST],
    handler: async (event: LifeEvent) => {
      const req = event.payload as ReconcileRequestPayload;
      const isForThisAgent = req.agent === name || req.agent === '*';
      if (!isForThisAgent) return;
      if (reconcileRunning) {
        console.warn(`[${name}] Reconcile already in progress — ignoring duplicate request ${req.requestId}`);
        return;
      }

      reconcileRunning = true;
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      let emitted = 0;
      let lastProgressEmitAt = 0;
      // Track the last threshold crossed so weighted emits don't skip progress ticks.
      let lastProgressThreshold = 0;

      console.log(`[${name}] Reconcile started (requestId=${req.requestId}, reason=${req.reason ?? 'none'})`);

      // Token-bucket rate limiter: max 50 emits/sec
      const RATE_LIMIT_INTERVAL_MS = 1000;
      const RATE_LIMIT_BATCH = 50;
      let batchCount = 0;
      let windowStart = Date.now();

      const emit = async (routingKey: string, payload: unknown, weight = 1): Promise<void> => {
        batchCount++;
        if (batchCount >= RATE_LIMIT_BATCH) {
          const elapsed = Date.now() - windowStart;
          if (elapsed < RATE_LIMIT_INTERVAL_MS) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_INTERVAL_MS - elapsed));
          }
          batchCount = 0;
          windowStart = Date.now();
        }

        await ctx.publisher.publish(createLifeEvent({ routingKey, source: name, payload }));
        emitted += weight;

        // RECONCILE_PROGRESS every 100 emits (floor-based so weighted calls don't skip thresholds)
        const currentThreshold = Math.floor(emitted / 100) * 100;
        const now = Date.now();
        if (currentThreshold > lastProgressThreshold && now - lastProgressEmitAt > 500) {
          lastProgressThreshold = currentThreshold;
          lastProgressEmitAt = now;
          const progressPayload: ReconcileProgressPayload = {
            requestId: req.requestId,
            agent: name,
            emitted,
            startedAt,
          };
          ctx.publisher.publish(
            createLifeEvent({ routingKey: ROUTING_KEYS.RECONCILE_PROGRESS, source: name, payload: progressPayload }),
          ).catch(err => console.warn(`[${name}] Reconcile progress publish failed:`, (err as Error).message));
        }
      };

      let runError: string | undefined;
      try {
        await reconcileConfig.run(ctx, emit);
      } catch (err) {
        runError = (err as Error).message;
        console.error(`[${name}] Reconcile run failed:`, err);
      } finally {
        reconcileRunning = false;
        const completePayload: ReconcileCompletePayload = {
          requestId: req.requestId,
          agent: name,
          emitted,
          durationMs: Date.now() - startMs,
          error: runError,
        };
        ctx.publisher.publish(
          createLifeEvent({ routingKey: ROUTING_KEYS.RECONCILE_COMPLETE, source: name, payload: completePayload }),
        ).catch(err => console.warn(`[${name}] Reconcile complete publish failed:`, (err as Error).message));
        console.log(`[${name}] Reconcile complete: emitted=${emitted} durationMs=${Date.now() - startMs}${runError ? ` error=${runError}` : ''}`);
      }
    },
  });
}

export async function createProcess(config: ProcessConfig): Promise<void> {
  const { name, checkIntervalMs = 15 * 60 * 1000, metricsPort, localDb: localDbConfig, agentDb: agentDbConfig, skipSettings, subscriptions, onTick, onStart, setupPush, reconcile } = config;
  const needsSettings = !skipSettings;

  // Metrics
  const registry = createMetricsRegistry(name);
  const port = metricsPort ?? parseInt(process.env.METRICS_PORT ?? '9090', 10);
  startMetricsServer(registry, port);

  const tickCounter = new Counter({
    name: 'process_ticks_total',
    help: 'Total tick invocations',
    registers: [registry],
  });

  const tickErrorCounter = new Counter({
    name: 'process_tick_errors_total',
    help: 'Total tick errors',
    registers: [registry],
  });

  const tickDuration = new Histogram({
    name: 'process_tick_duration_seconds',
    help: 'Tick execution duration in seconds',
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
    registers: [registry],
  });

  const pushTriggerCounter = new Counter({
    name: 'process_push_triggers_total',
    help: 'Total push-triggered tick invocations',
    registers: [registry],
  });

  const postgresConnected = new Gauge({
    name: 'process_postgres_connected',
    help: 'Whether agent PostgreSQL DB is connected',
    registers: [registry],
  });

  const settingsEnabled = new Gauge({
    name: 'process_settings_enabled',
    help: 'Whether the settings handshake is active',
    registers: [registry],
  });

  // Per-agent PostgreSQL (optional — agent-owned data)
  let agentDb: AgentDb | undefined;
  if (agentDbConfig) {
    await runAgentMigrations(agentDbConfig.migrationsFolder);
    agentDb = getAgentDb();
    postgresConnected.set(1);
    console.log(`${name} agent DB ready`);
  }

  // Local SQLite (optional — display-sync only)
  let localDb: LocalDb | undefined;
  let localDbHandle: LocalDbHandle | undefined;
  if (localDbConfig) {
    localDbHandle = openLocalDb(localDbConfig.sqlitePath);
    localDb = localDbHandle.db;
    runLocalMigrations(localDb, localDbConfig.migrationsFolder);
    console.log(`${name} local DB ready at ${localDbConfig.sqlitePath}`);
  }

  // Core setup
  const channel = await connectRabbitMQ();
  const publisher = createPublisher(channel);
  const timezone = process.env.TIMEZONE ?? DEFAULT_TIMEZONE;

  const ctx: ProcessContext = { agentDb, localDb, publisher, channel, settings: {}, timezone, registry };

  // ── Agent heartbeat / meta / error helpers (Stream C, LOS-258) ──────────
  const { agentMeta: metaConfig, onBackfill } = config;
  let lastTickSuccess = true;
  let lastTickTimestamp = new Date().toISOString();

  if (metaConfig) {
    // Heartbeat helper — called automatically after each tick
    const emitHeartbeat = (status: 'healthy' | 'drift' | 'down') => {
      const payload: AgentHeartbeatPayload = {
        agent: name,
        status,
        lastTick: lastTickTimestamp,
      };
      const routingKey = `life.agent.heartbeat.${name}`;
      ctx.publisher.publish(createLifeEvent({ routingKey, source: name, payload }))
        .catch(err => console.warn(`[${name}] Heartbeat publish failed:`, (err as Error).message));
    };

    // Meta helper — called on startup + exposed to agents for post-refinement
    const emitMeta = (overrides?: Partial<AgentMetaPayload>) => {
      const payload: AgentMetaPayload = {
        agent: name,
        kind: metaConfig.kind,
        domain: metaConfig.domain,
        role: metaConfig.role,
        observationCount: 0,
        ...overrides,
      };
      const routingKey = `life.agent.meta.updated.${name}`;
      ctx.publisher.publish(createLifeEvent({ routingKey, source: name, payload }))
        .catch(err => console.warn(`[${name}] Meta publish failed:`, (err as Error).message));
    };

    // Error helper — exposed to agents for structured error reporting
    const emitError = (code: string, message: string, errContext?: Record<string, unknown>) => {
      const payload: AgentErrorPayload = {
        agent: name,
        code,
        message,
        occurredAt: new Date().toISOString(),
        context: errContext,
      };
      const routingKey = `life.agent.error.${name}`;
      ctx.publisher.publish(createLifeEvent({ routingKey, source: name, payload }))
        .catch(err => console.warn(`[${name}] Error publish failed:`, (err as Error).message));
    };

    ctx.publishAgentMeta = emitMeta;
    ctx.publishAgentError = emitError;

    // Store emitHeartbeat for use in instrumentedTick — exposed via closure
    (ctx as any)._emitHeartbeat = emitHeartbeat;
    (ctx as any)._emitMeta = emitMeta;
  }

  // ── Settings (skipped when skipSettings: true) ──────────────
  settingsEnabled.set(needsSettings ? 1 : 0);
  if (!needsSettings) {
    console.log(`[${name}] Settings skipped (skipSettings: true)`);
  } else {
    // Load settings directly from OV (no orchestrator middleman)
    await loadSettingsFromOV(ctx, name);

    // Subscribe to CONFIG_UPDATED — re-read OV on any settings change
    await createSubscriber(channel, {
      queueName: `${name}.config-updates`,
      patterns: [ROUTING_KEYS.CONFIG_UPDATED],
      handler: async () => {
        console.log(`[${name}] Settings changed — re-reading from OV`);
        const { invalidateContextCache } = await import('./context-store.js');
        invalidateContextCache();
        await loadSettingsFromOV(ctx, name);
      },
    });
  }

  // Run startup hook BEFORE registering subscribers. RabbitMQ starts delivering
  // queued messages the instant channel.consume is called, so any handler that
  // depends on state onStart populates (commonly ctx.ai = createAIClient(...))
  // must have that state ready before the first message arrives. See LOS-506
  // for the race this fixes.
  //
  // Guarded so a transient failure (e.g. DB unreachable) doesn't crash the
  // whole process. Agents whose onStart contains truly fatal setup should
  // rethrow explicitly.
  if (onStart) {
    try {
      await onStart(ctx);
    } catch (err) {
      console.error(`[${name}] onStart failed — process continuing, but startup hooks did not complete:`, (err as Error).message);
    }
  }

  // Set up event subscriptions (after onStart so handlers see fully-populated ctx).
  if (subscriptions) {
    for (const sub of subscriptions) {
      await createSubscriber(channel, {
        queueName: sub.queueName,
        patterns: sub.patterns,
        handler: (event: LifeEvent) => sub.handler(event, ctx),
      });
    }
  }

  // Reconcile subscription — admin can trigger agents to republish display data.
  // Each agent subscribes on its own named queue so '*' broadcasts reach all agents.
  if (reconcile) {
    await subscribeReconcile(channel, name, reconcile, ctx);

    // Auto-reconcile on startup: republish all display state so display-sync is
    // always warm after a deploy or crash-restart without manual intervention.
    // Fire-and-forget with 0–30s jitter to stagger simultaneous multi-agent boots.
    void (async () => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 30_000));

      const RATE_MS = 1000;
      const RATE_BATCH = 50;
      let batch = 0;
      let windowStart = Date.now();

      const emit = async (routingKey: string, payload: unknown, weight = 1): Promise<void> => {
        await ctx.publisher.publish(createLifeEvent({ routingKey, source: name, payload }));
        batch += weight;
        if (batch >= RATE_BATCH) {
          const elapsed = Date.now() - windowStart;
          if (elapsed < RATE_MS) await new Promise(resolve => setTimeout(resolve, RATE_MS - elapsed));
          batch = 0;
          windowStart = Date.now();
        }
      };

      try {
        console.log(`[${name}] Startup reconcile — republishing display state`);
        await reconcile.run(ctx, emit);
        console.log(`[${name}] Startup reconcile complete`);
      } catch (err) {
        console.error(`[${name}] Startup reconcile failed (non-fatal):`, (err as Error).message);
      }
    })();
  }

  // Re-wire publisher + all subscribers on reconnect
  onReconnect(async (newChannel) => {
    console.log(`${name} re-wiring after RabbitMQ reconnect...`);
    ctx.channel = newChannel;
    ctx.publisher = createPublisher(newChannel);

    // Re-subscribe CONFIG_UPDATED (was created before onReconnect, so must be re-created here)
    if (needsSettings) {
      await createSubscriber(newChannel, {
        queueName: `${name}.config-updates`,
        patterns: [ROUTING_KEYS.CONFIG_UPDATED],
        handler: async () => {
          console.log(`[${name}] Settings changed — re-reading from OV`);
          const { invalidateContextCache } = await import('./context-store.js');
          invalidateContextCache();
          await loadSettingsFromOV(ctx, name);
        },
      });
    }

    if (subscriptions) {
      for (const sub of subscriptions) {
        await createSubscriber(newChannel, {
          queueName: sub.queueName,
          patterns: sub.patterns,
          handler: (event: LifeEvent) => sub.handler(event, ctx),
        });
      }
    }

    if (reconcile) {
      await subscribeReconcile(newChannel, name, reconcile, ctx);
    }
  });

  // Emit agent meta on startup (if configured)
  if ((ctx as any)._emitMeta) {
    try {
      (ctx as any)._emitMeta();
      console.log(`[${name}] Agent meta broadcast on startup`);
    } catch (err) {
      console.warn(`[${name}] Failed to broadcast agent meta on startup:`, (err as Error).message);
    }
  }

  // Run onBackfill — rehydrate display-sync cache (rate-limited, jittered, before first tick)
  if (onBackfill) {
    const jitterMs = Math.random() * 30_000; // 0–30s startup jitter
    await new Promise(resolve => setTimeout(resolve, jitterMs));
    try {
      const payloads = await onBackfill(ctx);
      if (payloads.length > 0) {
        console.log(`[${name}] Backfilling ${payloads.length} display records...`);
        // Rate limit: 50 events/sec — pause 1s every 50 events
        for (let i = 0; i < payloads.length; i++) {
          const p = payloads[i];
          const routingKey = `life.content.ready.${p.domain}`;
          await ctx.publisher.publish(createLifeEvent({ routingKey, source: name, payload: p }));
          if (i > 0 && i % 50 === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        console.log(`[${name}] Backfill complete (${payloads.length} records)`);
      }
    } catch (err) {
      console.error(`[${name}] Backfill failed (non-fatal):`, err);
    }
  }

  // Wrapped tick with metrics + heartbeat (NO per-tick settings reload — settings come from bus)
  async function instrumentedTick() {
    const end = tickDuration.startTimer();
    tickCounter.inc();
    try {
      await onTick(ctx);
      lastTickSuccess = true;
      lastTickTimestamp = new Date().toISOString();
    } catch (error) {
      tickErrorCounter.inc();
      lastTickSuccess = false;
      lastTickTimestamp = new Date().toISOString();
      console.error(`${name} tick failed:`, error);
    } finally {
      end();
      // Emit heartbeat after every tick (success or failure)
      if ((ctx as any)._emitHeartbeat) {
        try {
          (ctx as any)._emitHeartbeat(lastTickSuccess ? 'healthy' : 'drift');
        } catch (err) {
          console.warn(`[${name}] Heartbeat emit failed:`, (err as Error).message);
        }
      }
    }
  }

  // Debounced tick — prevents concurrent ticks, queues one pending
  let tickRunning = false;
  let tickPending = false;

  async function triggerTick() {
    if (tickRunning) {
      tickPending = true;
      return;
    }
    tickRunning = true;
    try {
      await instrumentedTick();
    } finally {
      tickRunning = false;
      if (tickPending) {
        tickPending = false;
        triggerTick();
      }
    }
  }

  // Subscribe to manual tick triggers (gateway → agent)
  if (metaConfig) {
    await createSubscriber(channel, {
      queueName: `${name}.tick-trigger`,
      patterns: [`${ROUTING_KEYS.AGENT_TICK_TRIGGER}.${name}`],
      handler: async () => {
        console.log(`[${name}] Manual tick triggered via gateway`);
        triggerTick();
      },
    });
  }

  // Set up push notifications (optional)
  let pushCleanup: { close: () => Promise<void> } | void;
  if (setupPush) {
    try {
      const pushTrigger = () => {
        pushTriggerCounter.inc();
        triggerTick();
      };
      pushCleanup = await setupPush(pushTrigger, ctx);
      console.log(`${name} push notifications enabled`);
    } catch (error) {
      console.error(`${name} push setup failed, falling back to polling only:`, error);
    }
  }

  await triggerTick();
  setInterval(triggerTick, checkIntervalMs);

  console.log(`${name} started (polling every ${Math.round(checkIntervalMs / 60000)}m)`);

  const shutdown = async () => {
    console.log(`Shutting down ${name}...`);
    if (pushCleanup) {
      await pushCleanup.close();
    }
    localDbHandle?.close();
    await disconnectAgentDb();
    await disconnectRabbitMQ();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
