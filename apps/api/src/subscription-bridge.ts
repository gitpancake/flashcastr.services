import { Client, type Notification } from "pg";
import { createLogger } from "@flashcastr/logger";
import { NOTIFY_CHANNELS } from "@flashcastr/database";
import type { PubSubEngine } from "./pubsub.js";
import { TOPICS } from "./pubsub.js";

const log = createLogger("api");

const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bridges Postgres LISTEN/NOTIFY (flash_stored/flash_casted) into the
 * in-process pubsub that backs GraphQL subscriptions. Every api replica opens
 * its own LISTEN connection and Postgres delivers every NOTIFY to every
 * listener on that channel, so -- unlike a competing-consumer queue -- no
 * coordination is needed for multiple replicas to each get every event.
 */
export class PostgresSubscriptionBridge {
  private client: Client | null = null;
  private listening = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private closing = false;

  constructor(
    private readonly connectionString: string,
    private readonly pubsub: PubSubEngine
  ) {}

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      log.error("Failed to connect for LISTEN/NOTIFY:", (err as Error).message);
      void this.reconnect();
    }
  }

  isListening(): boolean {
    return this.listening;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.listening = false;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.end();
      } catch {
        /* already gone */
      }
    }
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.connectionString });
    this.client = client;

    client.on("notification", (msg: Notification) => this.handleNotification(msg));
    client.on("error", (err: Error) => {
      log.error("LISTEN connection error:", err.message);
    });
    client.on("end", () => {
      this.listening = false;
      if (this.closing) return;
      log.warn("LISTEN connection ended; reconnecting");
      void this.reconnect();
    });

    await client.connect();
    await client.query(`LISTEN ${NOTIFY_CHANNELS.FLASH_STORED}`);
    await client.query(`LISTEN ${NOTIFY_CHANNELS.FLASH_CASTED}`);

    this.listening = true;
    this.reconnectAttempts = 0;
  }

  private handleNotification(msg: Notification): void {
    let parsed: unknown;
    try {
      parsed = msg.payload === undefined ? undefined : JSON.parse(msg.payload);
    } catch (err) {
      log.error("Failed to parse LISTEN/NOTIFY payload:", (err as Error).message);
      return;
    }

    if (msg.channel === NOTIFY_CHANNELS.FLASH_STORED) {
      this.pubsub.publish(TOPICS.FLASH_STORED, parsed);
      return;
    }

    if (msg.channel === NOTIFY_CHANNELS.FLASH_CASTED) {
      this.pubsub.publish(TOPICS.FLASH_CASTED, parsed);
    }
  }

  private getReconnectDelay(): number {
    return Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY);
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closing) return;
    this.reconnecting = true;

    while (!this.closing) {
      this.reconnectAttempts++;
      const delay = this.getReconnectDelay();
      log.info(`Reconnecting LISTEN connection in ${delay}ms (attempt ${this.reconnectAttempts})...`);
      await sleep(delay);

      if (this.closing) break;

      try {
        await this.connect();
        this.reconnecting = false;
        log.info("LISTEN connection reconnected");
        return;
      } catch (err) {
        log.error(`LISTEN reconnect attempt ${this.reconnectAttempts} failed:`, (err as Error).message);
      }
    }

    this.reconnecting = false;
  }
}
