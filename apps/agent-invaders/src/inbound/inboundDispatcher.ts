import type { ActionLog } from "../actions/actionLog.js";
import type { InboundCast } from "../farcaster/inboundCast.js";
import type { ConversationGraph } from "../graphs/conversation/conversationGraph.js";
import type { Logger } from "../logging/logger.js";
import type { InboundCastRepository } from "./inboundCastRepository.js";
import { ReplyCommand } from "./replyCommand.js";

export class InboundDispatcher {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly graph: ConversationGraph,
    private readonly inbox: InboundCastRepository,
    private readonly actionLog: ActionLog,
    private readonly logger: Logger,
    private readonly ownFid: number,
  ) {}

  dispatch(cast: InboundCast): void {
    if (cast.authorFid === this.ownFid) return;
    const command = new ReplyCommand(cast, this.graph, this.inbox, this.actionLog, this.logger);
    this.queue = this.queue.then(() => command.execute()).catch((error) => this.logger.error({ err: error }, "dispatcher error"));
  }

  async drain(): Promise<void> {
    await this.queue;
  }
}
