import { connect, type ChannelModel, type Channel, type ConsumeMessage } from "amqplib";
import type { MessageEnvelope } from "@flashcastr/shared-types";
import { setupTopology } from "./topology.js";

export abstract class FlashcastrConsumer<T = unknown> {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private reconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private closing: boolean = false;
  private static readonly MAX_RECONNECT_DELAY = 30000;
  private static readonly INITIAL_RECONNECT_DELAY = 1000;
  private static readonly HEARTBEAT_INTERVAL = 30;
  private static readonly CONNECT_TIMEOUT = 20000;

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

  /** Override to run logic after a successful reconnect (e.g. re-fetch cached state) */
  protected onReconnect(): void {}


  private getReconnectDelay(): number {
    return Math.min(
      FlashcastrConsumer.INITIAL_RECONNECT_DELAY *
        Math.pow(2, this.reconnectAttempts),
      FlashcastrConsumer.MAX_RECONNECT_DELAY
    );
  }

  /**
   * Drop the current connection/channel without triggering recovery. Listeners
   * are detached first so the resulting `close` events don't re-enter reconnect().
   */
  private async teardown(): Promise<void> {
    const { connection, channel } = this;
    this.connection = null;
    this.channel = null;

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
   * amqplib's own `timeout` only covers the TCP connect — a broker that accepts
   * the socket but never completes the AMQP handshake leaves the promise pending
   * forever, which parks the reconnect loop with `reconnecting` stuck true and no
   * consumer registered. Race an explicit deadline so a hung handshake is retried.
   */
  private async connectWithTimeout(url: string): Promise<ChannelModel> {
    const attempt = connect(url, { timeout: FlashcastrConsumer.CONNECT_TIMEOUT });
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`AMQP handshake timed out after ${FlashcastrConsumer.CONNECT_TIMEOUT}ms`)),
        FlashcastrConsumer.CONNECT_TIMEOUT
      );
    });

    try {
      return await Promise.race([attempt, deadline]);
    } catch (err) {
      // If the handshake completes after we gave up, close it rather than leak the socket.
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
      console.log(
        `[${this.serviceName}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        await this.teardown();
        await this.connect();
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        console.log(`[${this.serviceName}] Reconnected successfully`);
        this.onReconnect();
        return;
      } catch (err) {
        console.error(
          `[${this.serviceName}] Reconnect attempt ${this.reconnectAttempts} failed:`,
          (err as Error).message
        );
      }
    }

    // Only reached when close() flipped `closing` mid-loop — clear the guard so a
    // future startConsuming() on this instance isn't permanently locked out.
    this.reconnecting = false;
  }

  private async connect(): Promise<void> {
    const url = new URL(this.rabbitUrl);
    url.searchParams.set(
      "heartbeat",
      String(FlashcastrConsumer.HEARTBEAT_INTERVAL)
    );
    this.connection = await this.connectWithTimeout(url.toString());

    this.connection.on("error", (err) => {
      console.error(`[${this.serviceName}] Connection error:`, err.message);
    });

    this.connection.on("close", () => {
      if (this.closing) return;
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
      if (this.closing) return;
      // A channel can die while the TCP connection stays open (broker-side channel
      // error, consumer cancelled, queue deleted). Nothing else fires in that case,
      // so without this the process stays "up" with zero consumers registered and
      // the queue silently backs up until someone restarts it.
      console.warn(`[${this.serviceName}] Channel closed — initiating reconnect`);
      this.channel = null;
      this.reconnect();
    });

    const channel = this.channel;

    await channel.consume(
      this.queue,
      async (msg) => {
        // amqplib delivers null when the broker cancels the consumer (queue deleted,
        // node failover). Swallowing it leaves us subscribed to nothing.
        if (!msg) {
          if (this.closing) return;
          console.warn(`[${this.serviceName}] Consumer cancelled by broker — initiating reconnect`);
          this.reconnect();
          return;
        }

        try {
          const content = msg.content.toString();
          const envelope: MessageEnvelope<T> = JSON.parse(content);
          await this.handleMessage(envelope, msg);
          channel.ack(msg);
        } catch (err) {
          const errMsg = (err as Error).message || String(err);
          console.error(
            `[${this.serviceName}] Error processing message: ${errMsg}`
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
    this.closing = true;
    await this.teardown();
  }
}
