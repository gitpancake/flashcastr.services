import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { randomUUID } from "crypto";
import type { MessageEnvelope } from "@flashcastr/shared-types";
import { createLogger, type Logger } from "@flashcastr/logger";
import { EXCHANGES, setupTopology } from "./topology.js";

export interface PublisherOptions {
  /** Defaults to RABBITMQ_URL. */
  rabbitUrl?: string;
  /** How long to wait for the broker to confirm a publish. */
  confirmTimeoutMs?: number;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL = 30;

export class FlashcastrPublisher {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private connecting: Promise<ConfirmChannel> | null = null;
  private closing = false;

  private readonly log: Logger;
  private readonly rabbitUrl: string;
  private readonly serviceName: string;
  private readonly confirmTimeoutMs: number;

  constructor(serviceName: string, options: PublisherOptions = {}) {
    const rabbitUrl = options.rabbitUrl ?? process.env.RABBITMQ_URL;
    if (!rabbitUrl) throw new Error("RABBITMQ_URL is not defined");
    this.rabbitUrl = rabbitUrl;
    this.serviceName = serviceName;
    this.log = createLogger(serviceName);
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  }

  isConnected(): boolean {
    return this.channel !== null;
  }

  private ensureChannel(): Promise<ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connect(): Promise<ConfirmChannel> {
    const url = new URL(this.rabbitUrl);
    url.searchParams.set("heartbeat", String(HEARTBEAT_INTERVAL));
    const connection = await connect(url.toString());

    connection.on("error", (err) => {
      this.log.error("RabbitMQ connection error:", err.message);
    });
    connection.on("close", () => {
      if (!this.closing) this.log.warn("RabbitMQ publisher connection closed; will reconnect on next publish");
      this.connection = null;
      this.channel = null;
    });

    const channel = await connection.createConfirmChannel();
    await setupTopology(channel);

    channel.on("error", (err) => {
      this.log.error("RabbitMQ channel error:", err.message);
    });
    channel.on("close", () => {
      this.channel = null;
    });

    this.connection = connection;
    this.channel = channel;
    this.log.info("RabbitMQ publisher connected (confirm mode)");
    return channel;
  }

  /** Resolves once the broker has confirmed the message; rejects on nack or timeout. */
  async publish<T>(routingKey: string, payload: T, correlationId?: string): Promise<void> {
    const channel = await this.ensureChannel();

    const envelope: MessageEnvelope<T> = {
      id: randomUUID(),
      timestamp: Date.now(),
      source: this.serviceName,
      type: routingKey,
      version: "1.0",
      correlationId: correlationId || randomUUID(),
      payload,
    };

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Publish to ${routingKey} not confirmed within ${this.confirmTimeoutMs}ms`)),
        this.confirmTimeoutMs
      );

      channel.publish(
        EXCHANGES.EVENTS,
        routingKey,
        Buffer.from(JSON.stringify(envelope)),
        { persistent: true, messageId: envelope.id },
        (err) => {
          clearTimeout(timer);
          if (err) reject(new Error(`Broker rejected publish to ${routingKey}: ${err.message}`));
          else resolve();
        }
      );
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.channel) {
      try { await this.channel.close(); } catch { /* ignore */ }
      this.channel = null;
    }
    if (this.connection) {
      try { await this.connection.close(); } catch { /* ignore */ }
      this.connection = null;
    }
  }
}
