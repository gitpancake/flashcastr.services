import { connect, type ChannelModel, type Channel, type ConsumeMessage } from "amqplib";
import type { MessageEnvelope } from "@flashcastr/shared-types";
import { setupTopology } from "./topology.js";

export abstract class FlashcastrConsumer<T = unknown> {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private reconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private static readonly MAX_RECONNECT_DELAY = 30000;
  private static readonly INITIAL_RECONNECT_DELAY = 1000;
  private static readonly HEARTBEAT_INTERVAL = 30;

  protected readonly rabbitUrl: string;
  protected readonly queue: string;
  protected readonly serviceName: string;

  constructor(serviceName: string, queue: string) {
    this.rabbitUrl = process.env.RABBITMQ_URL!;
    if (!this.rabbitUrl) throw new Error("RABBITMQ_URL is not defined");
    this.queue = queue;
    this.serviceName = serviceName;
  }

  protected abstract handleMessage(
    envelope: MessageEnvelope<T>,
    raw: ConsumeMessage
  ): Promise<void>;

  protected shouldRequeueOnFailure(_error: Error): boolean {
    return false;
  }

  private getReconnectDelay(): number {
    return Math.min(
      FlashcastrConsumer.INITIAL_RECONNECT_DELAY *
        Math.pow(2, this.reconnectAttempts),
      FlashcastrConsumer.MAX_RECONNECT_DELAY
    );
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    while (true) {
      this.reconnectAttempts++;
      const delay = this.getReconnectDelay();
      console.log(
        `[${this.serviceName}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        await this.connect();
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        console.log(`[${this.serviceName}] Reconnected successfully`);
        return;
      } catch (err) {
        console.error(
          `[${this.serviceName}] Reconnect attempt ${this.reconnectAttempts} failed:`,
          (err as Error).message
        );
      }
    }
  }

  private async connect(): Promise<void> {
    const url = new URL(this.rabbitUrl);
    url.searchParams.set(
      "heartbeat",
      String(FlashcastrConsumer.HEARTBEAT_INTERVAL)
    );
    this.connection = await connect(url.toString());

    this.connection.on("error", (err) => {
      console.error(`[${this.serviceName}] Connection error:`, err.message);
    });

    this.connection.on("close", () => {
      console.warn(`[${this.serviceName}] Connection closed — initiating reconnect`);
      this.connection = null;
      this.channel = null;
      this.reconnect();
    });

    this.channel = await this.connection.createChannel();

    // Set up topology on connect
    await setupTopology(this.channel);

    const prefetchCount = parseInt(process.env.CONSUMER_CONCURRENCY || "1");
    await this.channel.prefetch(prefetchCount);

    this.channel.on("error", (err) => {
      console.error(`[${this.serviceName}] Channel error:`, err.message);
    });

    this.channel.on("close", () => {
      console.warn(`[${this.serviceName}] Channel closed`);
    });

    const channel = this.channel;

    channel.consume(
      this.queue,
      async (msg) => {
        if (!msg) return;

        try {
          const content = msg.content.toString();
          const envelope: MessageEnvelope<T> = JSON.parse(content);
          await this.handleMessage(envelope, msg);
          channel.ack(msg);
        } catch (err) {
          console.error(
            `[${this.serviceName}] Error processing message:`,
            err
          );
          const shouldRequeue = this.shouldRequeueOnFailure(err as Error);
          if (shouldRequeue) {
            channel.nack(msg, false, true);
          } else {
            // Send to DLQ
            channel.nack(msg, false, false);
          }
        }
      },
      { noAck: false }
    );
  }

  async startConsuming(): Promise<void> {
    await this.connect();
    const prefetchCount = parseInt(process.env.CONSUMER_CONCURRENCY || "1");
    console.log(
      `[${this.serviceName}] Consuming from ${this.queue} (concurrency=${prefetchCount})`
    );
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
