import { Cron } from "croner";
import type { Command } from "../inbound/replyCommand.js";
import type { Logger } from "../logging/logger.js";

export class DailyScheduler {
  private job: Cron | null = null;

  constructor(private readonly pattern: string, private readonly command: Command, private readonly logger: Logger) {}

  start(): void {
    if (this.job) return;
    this.job = new Cron(this.pattern, { timezone: "UTC", protect: true }, () => void this.command.execute());
    this.logger.info({ pattern: this.pattern, next: this.job.nextRun()?.toISOString() ?? null }, "daily digest scheduled");
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }
}
