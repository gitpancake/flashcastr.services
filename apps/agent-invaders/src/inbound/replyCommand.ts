import { errorMessage, type ActionLog } from "../actions/actionLog.js";
import type { InboundCast } from "../farcaster/inboundCast.js";
import type { ConversationGraph } from "../graphs/conversation/conversationGraph.js";
import type { Logger } from "../logging/logger.js";
import type { InboundCastRepository } from "./inboundCastRepository.js";

export interface Command {
  execute(): Promise<void>;
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_INBOUND = 15;

export class ReplyCommand implements Command {
  constructor(
    private readonly cast: InboundCast,
    private readonly graph: ConversationGraph,
    private readonly inbox: InboundCastRepository,
    private readonly actionLog: ActionLog,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<void> {
    const claimed = await this.inbox.claim(this.cast);
    if (!claimed) return;
    if (await this.isAuthorOverLimit()) {
      await this.inbox.markStatus(this.cast.hash, "skipped");
      await this.actionLog.record({ actor: "inbound", action: "rate_limited", outcome: "skipped", subject: this.cast.hash, detail: { authorFid: this.cast.authorFid } });
      return;
    }
    try {
      const final = await this.graph.invoke({ inbound: this.cast }, { configurable: { thread_id: `thread:${this.cast.threadHash}` } });
      await this.inbox.markStatus(this.cast.hash, final.published ? "replied" : "skipped");
      this.logger.info({ cast: this.cast.hash, published: final.published?.hash ?? null }, "inbound cast handled");
    } catch (error) {
      await this.inbox.markStatus(this.cast.hash, "failed");
      await this.actionLog.record({ actor: "inbound", action: "reply_failed", outcome: "failed", subject: this.cast.hash, detail: { error: errorMessage(error) } });
      this.logger.error({ err: error, cast: this.cast.hash }, "inbound cast failed");
    }
  }

  private async isAuthorOverLimit(): Promise<boolean> {
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
    const recent = await this.inbox.countFromAuthorSince(this.cast.authorFid, since);
    return recent > RATE_LIMIT_MAX_INBOUND;
  }
}
