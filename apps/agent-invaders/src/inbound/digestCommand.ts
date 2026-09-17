import { errorMessage, type ActionLog } from "../actions/actionLog.js";
import type { DigestGraph } from "../graphs/digest/digestGraph.js";
import type { Logger } from "../logging/logger.js";
import type { Command } from "./replyCommand.js";

export class DigestCommand implements Command {
  constructor(
    private readonly graph: DigestGraph,
    private readonly actionLog: ActionLog,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<void> {
    const date = this.clock().toISOString().slice(0, 10);
    try {
      const final = await this.graph.invoke({ date }, { configurable: { thread_id: `digest:${date}` } });
      this.logger.info({ date, published: final.published?.hash ?? null, skipped: final.skippedReason }, "daily digest run finished");
    } catch (error) {
      await this.actionLog.record({ actor: "digest", action: "digest_failed", outcome: "failed", threadId: date, detail: { error: errorMessage(error) } });
      this.logger.error({ err: error, date }, "daily digest failed");
    }
  }
}
