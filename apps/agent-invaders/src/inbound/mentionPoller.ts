import type { InboundCast } from "../farcaster/inboundCast.js";
import type { FarcasterReader } from "../farcaster/neynarReader.js";
import type { Logger } from "../logging/logger.js";
import type { InboundDispatcher } from "./inboundDispatcher.js";

const BACKLOG_GRACE_MULTIPLIER = 2;

export class MentionPoller {
  private timer: NodeJS.Timeout | null = null;
  private readonly ignoreBefore: number;

  constructor(
    private readonly reader: FarcasterReader,
    private readonly dispatcher: InboundDispatcher,
    private readonly ownFid: number,
    private readonly intervalMs: number,
    private readonly logger: Logger,
    clock: () => Date = () => new Date(),
  ) {
    this.ignoreBefore = clock().getTime() - intervalMs * BACKLOG_GRACE_MULTIPLIER;
  }

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

  isFresh(cast: InboundCast): boolean {
    return new Date(cast.castAt).getTime() >= this.ignoreBefore;
  }

  async pollOnce(): Promise<void> {
    try {
      const inbound = await this.reader.fetchRecentInbound(this.ownFid);
      for (const cast of inbound.filter((candidate) => this.isFresh(candidate))) this.dispatcher.dispatch(cast);
    } catch (error) {
      this.logger.warn({ err: error }, "mention poll failed");
    }
  }
}
