import { connect, type ChannelModel, type Channel, type ConsumeMessage } from "amqplib";
import type { MessageEnvelope } from "@flashcastr/shared-types";
import { createLogger, type Logger } from "@flashcastr/logger";
import { setupTopology, QUEUES, EXCHANGES } from "./topology.js";
import { FatalMessageError, TransientError } from "./errors.js";

export interface ConsumerOptions {
  /** Defaults to RABBITMQ_URL. */
  rabbitUrl?: string;
  /** Defaults to CONSUMER_CONCURRENCY or 1. */
  prefetch?: number;
  /** Attempts before a retryable failure is dead-lettered. Defaults to CONSUMER_MAX_ATTEMPTS or 5. */
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** When true the handler must call ack()/requeue()/deadLetter() itself. */
  manualAck?: boolean;
  /** Declares a server-named exclusive, auto-delete queue bound to these routing keys instead of the fixed durable queue. */
  exclusive?: { bindings: string[] };
}

export interface QueueDepths {
  queue: number;
  deadLetters: number;
}

type Settlement = "ack" | "requeue" | "dead";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;
const MAX_TRACKED_MESSAGES = 10000;

const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;
const HEARTBEAT_INTERVAL = 30;
const CONNECT_TIMEOUT = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intFromEnv(key: string, fallback: number): number {
  const parsed = parseInt(process.env[key] ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function isMessageEnvelope(value: unknown): value is MessageEnvelope<unknown> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.type === "string" && "payload" in candidate;
}

export abstract class FlashcastrConsumer<T = unknown> {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private closing = false;

  private readonly attemptsByMessage = new Map<string, number>();
  private readonly deliveryChannel = new WeakMap<ConsumeMessage, Channel>();
  private readonly messageKeys = new WeakMap<ConsumeMessage, string>();

  protected readonly log: Logger;
  protected readonly rabbitUrl: string;
  protected readonly queue: string;
  protected readonly serviceName: string;
  protected readonly prefetch: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly manualAck: boolean;
  private readonly exclusive: { bindings: string[] } | undefined;
  private consumingQueue: string;

  constructor(serviceName: string, queue: string, options: ConsumerOptions = {}) {
    const rabbitUrl = options.rabbitUrl ?? process.env.RABBITMQ_URL;
    if (!rabbitUrl) throw new Error("RABBITMQ_URL is not defined");
    this.rabbitUrl = rabbitUrl;
    this.queue = queue;
    this.consumingQueue = queue;
    this.serviceName = serviceName;
    this.log = createLogger(serviceName);
    this.prefetch = options.prefetch ?? intFromEnv("CONSUMER_CONCURRENCY", 1);
    this.maxAttempts = options.maxAttempts ?? intFromEnv("CONSUMER_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.manualAck = options.manualAck ?? false;
    this.exclusive = options.exclusive;
  }

  protected abstract handleMessage(envelope: MessageEnvelope<T>, raw: ConsumeMessage): Promise<void>;

  /** Whether a thrown error should be retried (bounded by maxAttempts) rather than dead-lettered. */
  protected shouldRequeueOnFailure(_error: Error): boolean {
    return false;
  }

  /** Override to run logic after a successful reconnect (e.g. re-fetch cached state). */
  protected onReconnect(): void {}

  get queueName(): string {
    return this.consumingQueue;
  }

  isConsuming(): boolean {
    return this.channel !== null && this.consumerTag !== null;
  }

  async queueDepths(): Promise<QueueDepths | null> {
    const channel = this.channel;
    if (!channel) return null;
    const [queue, deadLetters] = await Promise.all([
      channel.checkQueue(this.consumingQueue),
      channel.checkQueue(QUEUES.DEAD_LETTERS),
    ]);
    return { queue: queue.messageCount, deadLetters: deadLetters.messageCount };
  }

  protected ack(raw: ConsumeMessage): void {
    this.settle(raw, "ack");
  }

  protected async requeue(raw: ConsumeMessage, delayMs = 0): Promise<void> {
    if (delayMs > 0) await sleep(delayMs);
    this.settle(raw, "requeue");
  }

  protected deadLetter(raw: ConsumeMessage): void {
    this.settle(raw, "dead");
  }

  protected retryDelay(attempt: number): number {
    const exponential = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
    return Math.min(exponential, this.retryMaxDelayMs);
  }

  private settle(raw: ConsumeMessage, outcome: Settlement): void {
    const channel = this.deliveryChannel.get(raw);
    if (!channel || channel !== this.channel) {
      this.log.warn("Delivery channel is gone; broker will redeliver the unacked message");
      return;
    }

    const key = this.messageKeys.get(raw);
    if (key && outcome !== "requeue") this.attemptsByMessage.delete(key);

    try {
      if (outcome === "ack") channel.ack(raw);
      else channel.nack(raw, false, outcome === "requeue");
    } catch (err) {
      this.log.error("Failed to settle message:", err);
    }
  }

  private recordAttempt(key: string): number {
    const attempt = (this.attemptsByMessage.get(key) ?? 0) + 1;
    this.attemptsByMessage.set(key, attempt);
    if (this.attemptsByMessage.size > MAX_TRACKED_MESSAGES) {
      const oldest = this.attemptsByMessage.keys().next().value;
      if (oldest !== undefined) this.attemptsByMessage.delete(oldest);
    }
    return attempt;
  }

  private async handleDelivery(channel: Channel, raw: ConsumeMessage): Promise<void> {
    this.deliveryChannel.set(raw, channel);

    let envelope: MessageEnvelope<T>;
    try {
      const parsed: unknown = JSON.parse(raw.content.toString());
      if (!isMessageEnvelope(parsed)) throw new FatalMessageError("Message is not a MessageEnvelope");
      envelope = parsed as MessageEnvelope<T>;
    } catch (err) {
      this.log.error(`Dead-lettering malformed message: ${(err as Error).message}`);
      this.settle(raw, "dead");
      return;
    }

    const key = raw.properties.messageId ?? envelope.id;
    this.messageKeys.set(raw, key);

    try {
      await this.handleMessage(envelope, raw);
      if (!this.manualAck) this.settle(raw, "ack");
    } catch (err) {
      await this.settleFailure(raw, key, err as Error);
    }
  }

  private async settleFailure(raw: ConsumeMessage, key: string, error: Error): Promise<void> {
    if (error instanceof TransientError) {
      this.log.warn(`${error.message}; requeue in ${error.retryAfterMs}ms`);
      await sleep(error.retryAfterMs);
      this.settle(raw, "requeue");
      return;
    }

    const attempt = this.recordAttempt(key);
    const isRetryable = !(error instanceof FatalMessageError) && this.shouldRequeueOnFailure(error);
    const hasAttemptsLeft = attempt < this.maxAttempts;

    if (isRetryable && hasAttemptsLeft) {
      const delay = this.retryDelay(attempt);
      this.log.warn(
        `Error processing message (attempt ${attempt}/${this.maxAttempts}): ${error.message}; requeue in ${delay}ms`
      );
      await sleep(delay);
      this.settle(raw, "requeue");
      return;
    }

    const reason = isRetryable ? `after ${attempt} attempt(s)` : "not retryable";
    this.log.error(`Dead-lettering message (${reason}): ${error.message}`);
    this.settle(raw, "dead");
  }

  private getReconnectDelay(): number {
    return Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY);
  }

  /**
   * Drop the current connection/channel without triggering recovery. Listeners
   * are detached first so the resulting `close` events don't re-enter reconnect().
   */
  private async teardown(): Promise<void> {
    const { connection, channel } = this;
    this.connection = null;
    this.channel = null;
    this.consumerTag = null;

    if (channel) {
      channel.removeAllListeners();
      try { await channel.close(); } catch { /* already gone */ }
    }
    if (connection) {
      connection.removeAllListeners();
      try { await connection.close(); } catch { /* already gone */ }
    }
  }

  /**
   * amqplib's own `timeout` only covers the TCP connect. A broker that accepts
   * the socket but never completes the AMQP handshake leaves the promise pending
   * forever, so race an explicit deadline.
   */
  private async connectWithTimeout(url: string): Promise<ChannelModel> {
    const attempt = connect(url, { timeout: CONNECT_TIMEOUT });
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`AMQP handshake timed out after ${CONNECT_TIMEOUT}ms`)),
        CONNECT_TIMEOUT
      );
    });

    try {
      return await Promise.race([attempt, deadline]);
    } catch (err) {
      attempt.then((c) => c.close().catch(() => {})).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closing) return;
    this.reconnecting = true;

    while (!this.closing) {
      this.reconnectAttempts++;
      const delay = this.getReconnectDelay();
      this.log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
      await sleep(delay);

      try {
        await this.teardown();
        await this.connect();
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        this.log.info("Reconnected successfully");
        this.onReconnect();
        return;
      } catch (err) {
        this.log.error(`Reconnect attempt ${this.reconnectAttempts} failed:`, (err as Error).message);
      }
    }

    this.reconnecting = false;
  }

  private async connect(): Promise<void> {
    const url = new URL(this.rabbitUrl);
    url.searchParams.set("heartbeat", String(HEARTBEAT_INTERVAL));
    const connection = await this.connectWithTimeout(url.toString());
    this.connection = connection;

    connection.on("error", (err) => {
      this.log.error("Connection error:", err.message);
    });

    connection.on("close", () => {
      if (this.closing) return;
      this.log.warn("Connection closed; initiating reconnect");
      this.connection = null;
      this.channel = null;
      this.consumerTag = null;
      this.reconnect();
    });

    const channel = await connection.createChannel();
    this.channel = channel;

    await setupTopology(channel);
    await channel.prefetch(this.prefetch);

    if (this.exclusive) {
      const { queue } = await channel.assertQueue("", { exclusive: true, autoDelete: true });
      for (const bindingKey of this.exclusive.bindings) {
        await channel.bindQueue(queue, EXCHANGES.EVENTS, bindingKey);
      }
      this.consumingQueue = queue;
    }

    channel.on("error", (err) => {
      this.log.error("Channel error:", err.message);
    });

    channel.on("close", () => {
      if (this.closing) return;
      // A channel can die while the TCP connection stays open (broker-side channel
      // error, consumer cancelled, queue deleted). Nothing else fires in that case.
      this.log.warn("Channel closed; initiating reconnect");
      this.channel = null;
      this.consumerTag = null;
      this.reconnect();
    });

    const consumer = await channel.consume(
      this.consumingQueue,
      (msg) => {
        // amqplib delivers null when the broker cancels the consumer (queue deleted,
        // node failover). Swallowing it leaves us subscribed to nothing.
        if (!msg) {
          if (this.closing) return;
          this.log.warn("Consumer cancelled by broker; initiating reconnect");
          this.consumerTag = null;
          this.reconnect();
          return;
        }
        this.handleDelivery(channel, msg).catch((err) => this.log.error("Unhandled delivery error:", err));
      },
      { noAck: false }
    );
    this.consumerTag = consumer.consumerTag;
  }

  async startConsuming(): Promise<void> {
    await this.connect();
    this.log.info(`Consuming from ${this.consumingQueue} (concurrency=${this.prefetch}, maxAttempts=${this.maxAttempts})`);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.teardown();
  }
}
