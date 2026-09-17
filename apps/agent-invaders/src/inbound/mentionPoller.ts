import type { FarcasterReader } from "../farcaster/neynarReader.js";
import type { Logger } from "../logging/logger.js";
import type { InboundDispatcher } from "./inboundDispatcher.js";

export class MentionPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly reader: FarcasterReader,
    private readonly dispatcher: InboundDispatcher,
    private readonly ownFid: number,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    void this.pollOnce();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    try {
      const inbound = await this.reader.fetchRecentInbound(this.ownFid);
      for (const cast of inbound) this.dispatcher.dispatch(cast);
    } catch (error) {
      this.logger.warn({ err: error }, "mention poll failed");
    }
  }
}
