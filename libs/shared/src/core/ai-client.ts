import Anthropic from '@anthropic-ai/sdk';
import type { Messages } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { Counter, Histogram } from 'prom-client';
import type { Registry } from 'prom-client';
import { CLAUDE_MODEL_SONNET } from '../config/env.js';
import { getRequiredEnv } from '../config/env.js';
import { parseAIJson, extractResponseText } from './ai-utils.js';
import { createLifeEvent } from '../events/types.js';
import { ROUTING_KEYS } from '../events/routing-keys.js';
import type { AiUsageDisplay, ContentReadyPayload } from '../events/types.js';

function getOrCreateMetric<T>(registry: Registry, name: string, create: () => T): T {
  const existing = registry.getSingleMetric(name) as T | undefined;
  return existing ?? create();
}

/**
 * Thrown when AIClient exhausts its 429 retry budget. Anthropic OAuth window
 * throttles (5h / 24h) outlast any reasonable in-tick backoff, so retrying at
 * the RabbitMQ-subscriber layer just pounds the same bucket. Subscriber checks
 * `name === 'RateLimitExhaustedError'` and DLQs the message without requeue —
 * the next scheduled tick (or operator action) will pick the work back up once
 * the bucket has refilled.
 */
export class RateLimitExhaustedError extends Error {
  override readonly name = 'RateLimitExhaustedError';
  constructor(taskName: string, attempts: number, cause: unknown) {
    super(`AI ${taskName}: rate-limit exhausted after ${attempts} attempts`);
    (this as { cause?: unknown }).cause = cause;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readHeader(headers: Headers | Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()];
}

// Server hint wins. `retry-after-ms` is milliseconds; `retry-after` is seconds
// (RFC 7231 also allows an HTTP-date, which we parse via Date).
function parseRetryAfterMs(headers: Headers | Record<string, string> | undefined): number | null {
  const ms = readHeader(headers, 'retry-after-ms');
  if (ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const ra = readHeader(headers, 'retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n > 0) return n * 1000;
    const dateMs = Date.parse(ra);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta > 0) return delta;
    }
  }
  return null;
}

// 15s, 30s, 60s, 120s, 240s + 0–10s jitter. Capped at 5 min.
function backoffMs(attempt: number): number {
  const base = Math.min(15_000 * 2 ** (attempt - 1), 300_000);
  return base + Math.floor(Math.random() * 10_000);
}

// ── Task types ────────────────────────────────────────────────────────

export type AITaskType = 'classify' | 'extract' | 'generate' | 'summarize' | 'search' | 'research' | 'director';

// All task types route to Sonnet — Claude.ai Pro OAuth bucket is shared
// across all agents; Opus burns it ~5x faster than Sonnet. Keep CLAUDE_MODEL_OPUS
// available for explicit per-call overrides when truly needed.
const TASK_MODEL_MAP: Record<AITaskType, () => string> = {
  classify:  () => CLAUDE_MODEL_SONNET,
  extract:   () => CLAUDE_MODEL_SONNET,
  generate:  () => CLAUDE_MODEL_SONNET,
  summarize: () => CLAUDE_MODEL_SONNET,
  search:    () => CLAUDE_MODEL_SONNET,
  research:  () => CLAUDE_MODEL_SONNET,
  director:  () => CLAUDE_MODEL_SONNET,
};

// ── Cost estimation ──────────────────────────────────────────────────

interface ModelRates { input: number; output: number; cacheRead: number; cacheWrite: number }

const COST_PER_MILLION: Record<string, ModelRates> = {
  'claude-opus-4-7':            { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6':            { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6':          { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-20250514':   { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':  { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

function estimateCostUsd(model: string, usage: AICallResult['usage']): number {
  const rates = COST_PER_MILLION[model];
  if (!rates) return 0;
  return (
    usage.inputTokens * rates.input +
    usage.outputTokens * rates.output +
    usage.cacheCreationTokens * rates.cacheWrite +
    usage.cacheReadTokens * rates.cacheRead
  ) / 1_000_000;
}

// ── Public types ─────────────────────────────────────────────────────

/**
 * Minimal publisher shape accepted by AIClient for CONTENT_READY_AI_USAGE
 * emission. Matches `createPublisher()` from libs/shared/src/rabbitmq — we
 * take the surface area we need so this stays importable from any layer
 * (agent, gateway, or test) without a hard dep on RabbitMQ.
 */
export interface AIUsagePublisher {
  publish: (event: unknown) => unknown;
}

export interface AIClientConfig {
  registry?: Registry;
  /** When set, AIClient emits CONTENT_READY_AI_USAGE after each completion. */
  usagePublisher?: AIUsagePublisher;
  /** Process name (e.g. 'agent-farcaster') — used as agent label on usage events. */
  source?: string;
}

export interface AICallOptions {
  task: AITaskType;
  taskName: string;
  model?: string;
  maxTokens: number;
  messages: Messages.MessageParam[];
  system?: string | Messages.TextBlockParam[];
  tools?: Messages.ToolUnion[];
  cacheSystem?: boolean;
}

export interface AICallResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  model: string;
  durationMs: number;
  estimatedCostUsd: number;
}

// ── AIClient class ───────────────────────────────────────────────────

// Process-wide circuit breaker: when any AIClient instance exhausts its 429
// retry budget, mute API calls process-wide until cooldown elapses. The
// Anthropic OAuth bucket is org-wide, so one task hitting the wall means all
// concurrent tasks would too — fail fast instead of burning fresh 5-attempt
// budgets per tick during a multi-hour throttle window. Module-scoped (shared
// across instances in the same process) since callers may instantiate more
// than one AIClient against the same registry.
let circuitOpenUntil = 0;
const COOLDOWN_AFTER_EXHAUSTION_MS = 15 * 60 * 1000; // 15 minutes

export class AIClient {
  private client: Anthropic;
  private aiDuration: Histogram | null;
  private aiTokens: Counter | null;
  private aiCost: Counter | null;
  private aiCalls: Counter | null;
  private aiFallbacks: Counter | null;
  private usagePublisher: AIUsagePublisher | null;
  private source: string;

  constructor(config?: AIClientConfig) {
    const oauthToken = getRequiredEnv('CLAUDE_CODE_OAUTH_TOKEN');
    // maxRetries: 0 — we own 429 backoff in complete() so retries honor
    // server-side retry-after and don't double-stack with SDK's own loop.
    this.client = new Anthropic({ authToken: oauthToken, maxRetries: 0 });
    console.log(`[ai-client] ${config?.source ?? 'unknown'}: auth=CLAUDE_CODE_OAUTH_TOKEN (Claude.ai subscription)`);
    this.usagePublisher = config?.usagePublisher ?? null;
    this.source = config?.source ?? 'unknown';

    const registry = config?.registry;
    if (registry) {
      // Idempotent: reuse any metric already on the registry so constructing a
      // second AIClient against the same registry doesn't throw with
      // "A metric with the name ... has already been registered". Callers
      // should still prefer a single shared client per process (see ctx.ai).
      this.aiDuration = getOrCreateMetric(registry, 'ai_call_duration_seconds', () => new Histogram({
        name: 'ai_call_duration_seconds',
        help: 'Duration of AI/Claude API calls in seconds',
        labelNames: ['task'],
        buckets: [0.5, 1, 2, 5, 10, 30, 60],
        registers: [registry],
      }));
      this.aiTokens = getOrCreateMetric(registry, 'ai_tokens_total', () => new Counter({
        name: 'ai_tokens_total',
        help: 'Total tokens used in AI calls',
        labelNames: ['task', 'model', 'type'],
        registers: [registry],
      }));
      this.aiCost = getOrCreateMetric(registry, 'ai_estimated_cost_usd', () => new Counter({
        name: 'ai_estimated_cost_usd',
        help: 'Cumulative estimated cost of AI calls in USD',
        labelNames: ['task', 'model'],
        registers: [registry],
      }));
      this.aiCalls = getOrCreateMetric(registry, 'ai_calls_total', () => new Counter({
        name: 'ai_calls_total',
        help: 'Total AI API calls',
        labelNames: ['task', 'task_name', 'model', 'status'],
        registers: [registry],
      }));
      // Pairs with ai_calls_total for fallback-rate per task_name. Incremented
      // when completeJsonSafe swallows a parse/API failure and returns the
      // typed fallback — the only signal that systematic prompt failures are
      // silently degrading agent output (see LOS-524 / LOS-527). Label is
      // task_name (not task) so we can pinpoint failures like
      // `finance-counterparty-extract` rather than the broader `extract` type.
      this.aiFallbacks = getOrCreateMetric(registry, 'ai_calls_fallback_total', () => new Counter({
        name: 'ai_calls_fallback_total',
        help: 'AI calls that returned the typed fallback after a parse/API failure',
        labelNames: ['task_name'],
        registers: [registry],
      }));
    } else {
      this.aiDuration = null;
      this.aiTokens = null;
      this.aiCost = null;
      this.aiCalls = null;
      this.aiFallbacks = null;
    }
  }

  // Anthropic OAuth (Claude.ai subscription) has hard window-based caps. When
  // we hit one, the SDK's default fast retries don't help — the bucket needs
  // wall-clock time to refill. Honor server-side `retry-after`/`retry-after-ms`
  // when present, else exponential backoff w/ jitter. Cap attempts so a stuck
  // throttle still surfaces as a real error instead of hanging the tick.
  private async requestWithRetry(
    options: AICallOptions,
    body: Messages.MessageCreateParamsNonStreaming,
  ) {
    // Circuit breaker: skip the API call entirely if a recent exhaustion
    // opened the breaker. Saves the bucket from same-process callers piling
    // on while a multi-hour throttle window drains.
    const now = Date.now();
    if (now < circuitOpenUntil) {
      const remainingSec = Math.ceil((circuitOpenUntil - now) / 1000);
      console.warn(
        `  AI ${options.taskName}: circuit-breaker open (${remainingSec}s remaining) — failing fast without API call`,
      );
      throw new RateLimitExhaustedError(options.taskName, 0, new Error('circuit-breaker open'));
    }

    const MAX_ATTEMPTS = 5;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        return await this.client.messages.create(body);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 429) throw err;
        if (attempt >= MAX_ATTEMPTS) {
          const headers = (err as { headers?: Headers | Record<string, string> }).headers;
          const retryAfterMs = parseRetryAfterMs(headers);
          const cooldownMs = Math.max(retryAfterMs ?? 0, COOLDOWN_AFTER_EXHAUSTION_MS);
          circuitOpenUntil = Date.now() + cooldownMs;
          console.error(
            `  AI ${options.taskName}: 429 rate-limit exhausted after ${MAX_ATTEMPTS} attempts — opening circuit-breaker for ${Math.round(cooldownMs / 1000)}s`,
          );
          throw new RateLimitExhaustedError(options.taskName, MAX_ATTEMPTS, err);
        }
        const headers = (err as { headers?: Headers | Record<string, string> }).headers;
        const waitMs = parseRetryAfterMs(headers) ?? backoffMs(attempt);
        console.warn(
          `  AI ${options.taskName}: 429 rate-limit (attempt ${attempt}/${MAX_ATTEMPTS}) — waiting ${Math.round(waitMs / 1000)}s`,
        );
        await sleep(waitMs);
      }
    }
  }

  /** Main method — all AI calls funnel through here. */
  async complete(options: AICallOptions): Promise<AICallResult> {
    // Resolve model: explicit override > task-type default
    const model = options.model ?? TASK_MODEL_MAP[options.task]();

    // Build system prompt (with optional cache_control)
    let system: string | Messages.TextBlockParam[] | undefined = options.system;
    if (options.cacheSystem && system) {
      if (typeof system === 'string') {
        system = [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }];
      } else {
        // Add cache_control to the last block
        system = system.map((block, i) =>
          i === system!.length - 1
            ? { ...block, cache_control: { type: 'ephemeral' as const } }
            : block,
        ) as Messages.TextBlockParam[];
      }
    }

    const endTimer = this.aiDuration?.startTimer({ task: options.taskName });
    const startMs = Date.now();

    try {
      const response = await this.requestWithRetry(options, {
        model,
        max_tokens: options.maxTokens,
        messages: options.messages,
        ...(system ? { system } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
      });

      const durationMs = Date.now() - startMs;
      const text = extractResponseText(response.content);
      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      };
      const cost = estimateCostUsd(model, usage);

      // Record metrics
      this.aiCalls?.inc({ task: options.task, task_name: options.taskName, model, status: 'ok' });
      this.aiTokens?.inc({ task: options.taskName, model, type: 'input' }, usage.inputTokens);
      this.aiTokens?.inc({ task: options.taskName, model, type: 'output' }, usage.outputTokens);
      if (usage.cacheCreationTokens > 0) {
        this.aiTokens?.inc({ task: options.taskName, model, type: 'cache_creation' }, usage.cacheCreationTokens);
      }
      if (usage.cacheReadTokens > 0) {
        this.aiTokens?.inc({ task: options.taskName, model, type: 'cache_read' }, usage.cacheReadTokens);
      }
      this.aiCost?.inc({ task: options.taskName, model }, cost);

      // Emit CONTENT_READY_AI_USAGE (fire-and-forget — never blocks a tick)
      this.emitUsage({
        ts: new Date(startMs).toISOString(),
        agent: this.source,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd: cost,
        taskName: options.taskName,
      });

      // Console log for visibility
      const modelShort = model.includes('haiku') ? 'haiku' : model.includes('sonnet') ? 'sonnet' : model.includes('opus') ? 'opus' : model;
      console.log(
        `  AI ${options.taskName} [${modelShort}] ${usage.inputTokens}in/${usage.outputTokens}out ${durationMs}ms ~$${cost.toFixed(4)}`,
      );

      return { text, usage, model, durationMs, estimatedCostUsd: cost };
    } catch (error) {
      this.aiCalls?.inc({ task: options.task, task_name: options.taskName, model, status: 'error' });
      throw error;
    } finally {
      endTimer?.();
    }
  }

  /** Emit a CONTENT_READY_AI_USAGE event. Failure is swallowed — usage
   *  reporting must never take down a Claude call. */
  private emitUsage(display: AiUsageDisplay): void {
    if (!this.usagePublisher) return;
    try {
      const payload: ContentReadyPayload<AiUsageDisplay> = {
        domain: 'ai_usage',
        action: 'create',
        entityId: `${display.ts}:${display.agent}:${display.model}`,
        forDate: display.ts.slice(0, 10),
        display,
        fullDetailAvailable: false,
      };
      const event = createLifeEvent({
        routingKey: ROUTING_KEYS.CONTENT_READY_AI_USAGE,
        source: this.source,
        payload,
      });
      Promise.resolve(this.usagePublisher.publish(event)).catch((err) => {
        console.warn('  AI usage publish failed:', (err as Error).message);
      });
    } catch (err) {
      console.warn('  AI usage emit failed:', (err as Error).message);
    }
  }

  /**
   * Convenience: complete + parse JSON response.
   *
   * When `wrapKey` is provided and the model returns a bare JSON array,
   * auto-wraps it as `{ [wrapKey]: array }` to match the expected type.
   * This prevents the class of bugs where the prompt asks for `{ key: [...] }`
   * but the model returns `[...]` directly.
   */
  async completeJson<T>(options: AICallOptions, parseOptions?: { wrapKey?: string }): Promise<T> {
    const result = await this.complete(options);
    const parsed = parseAIJson<unknown>(result.text);
    if (parseOptions?.wrapKey && Array.isArray(parsed)) {
      console.warn(`  completeJson[${options.taskName}]: model returned bare array, wrapping as { ${parseOptions.wrapKey}: [...] }`);
      return { [parseOptions.wrapKey]: parsed } as T;
    }
    return parsed as T;
  }

  /**
   * Safe JSON completion with typed fallback. Use for AI calls where a
   * parse/API failure should not crash the agent's tick.
   *
   * On success: parses JSON, applies wrapKey normalization, returns result.
   * On failure: logs structured error, returns the provided fallback.
   */
  async completeJsonSafe<T>(
    options: AICallOptions,
    fallback: T,
    parseOptions?: { wrapKey?: string },
  ): Promise<T> {
    try {
      return await this.completeJson<T>(options, parseOptions);
    } catch (err) {
      const errMsg = (err as Error).message;
      const isRateLimit = errMsg.includes('rate') || errMsg.includes('429');
      const level = isRateLimit ? 'warn' : 'error';
      console[level](`  AI ${options.taskName} [${options.task}] failed, using fallback: ${errMsg}`);
      this.aiFallbacks?.inc({ task_name: options.taskName });
      return fallback;
    }
  }
}

/** Factory function for creating an AI client. */
export function createAIClient(config?: AIClientConfig): AIClient {
  return new AIClient(config);
}
