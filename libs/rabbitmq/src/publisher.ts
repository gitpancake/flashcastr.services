import { connect, type Channel, type ChannelModel } from "amqplib";
import { randomUUID } from "crypto";
import type { MessageEnvelope } from "@flashcastr/shared-types";
import { EXCHANGES, setupTopology } from "./topology.js";

export class FlashcastrPublisher {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connecting: boolean = false;
  private readonly rabbitUrl: string;
  private readonly serviceName: string;

  constructor(serviceName: string) {
    this.rabbitUrl = process.env.RABBITMQ_URL!;
    if (!this.rabbitUrl) {
      throw new Error("RABBITMQ_URL is not defined");
    }
    this.serviceName = serviceName;
  }

  private async ensureConnection(): Promise<Channel> {
    if (this.channel) return this.channel;
    if (this.connecting) {
      // Wait for existing connection attempt
      while (this.connecting) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.channel) return this.channel;
    }

    this.connecting = true;
    try {
      const url = new URL(this.rabbitUrl);
      url.searchParams.set("heartbeat", "30");
      this.connection = await connect(url.toString());

      this.connection.on("error", (err) => {
        console.error(`[${this.serviceName}] RabbitMQ connection error:`, err.message);
      });

      this.connection.on("close", () => {
        console.warn(`[${this.serviceName}] RabbitMQ connection closed`);
        this.connection = null;
        this.channel = null;
      });

      this.channel = await this.connection.createChannel();
      await setupTopology(this.channel);

      this.channel.on("error", (err) => {
        console.error(`[${this.serviceName}] RabbitMQ channel error:`, err.message);
      });

      this.channel.on("close", () => {
        this.channel = null;
      });

      console.log(`[${this.serviceName}] RabbitMQ publisher connected`);
      return this.channel;
    } finally {
      this.connecting = false;
    }
  }

  async publish<T>(
    routingKey: string,
    payload: T,
    correlationId?: string
  ): Promise<void> {
    const channel = await this.ensureConnection();

    const envelope: MessageEnvelope<T> = {
      id: randomUUID(),
      timestamp: Date.now(),
      source: this.serviceName,
      type: routingKey,
      version: "1.0",
      correlationId: correlationId || randomUUID(),
      payload,
    };

    const sent = channel.publish(
      EXCHANGES.EVENTS,
      routingKey,
      Buffer.from(JSON.stringify(envelope)),
      { persistent: true, messageId: envelope.id }
    );

    if (!sent) {
      throw new Error(`Failed to publish message to ${routingKey}`);
    }
  }

  async close(): Promise<void> {
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
