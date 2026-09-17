import type { CastDraft, CastReference, FarcasterGateway, PublishedCast } from "../farcaster/farcasterGateway.js";
import { recordOutcome, type ActionLog } from "./actionLog.js";

export class ActionLoggingFarcasterGateway implements FarcasterGateway {
  constructor(private readonly inner: FarcasterGateway, private readonly log: ActionLog, private readonly actor: string) {}

  publishCast(draft: CastDraft): Promise<PublishedCast> {
    const subject = draft.replyTo ? `reply:${draft.replyTo.hash}` : `channel:${draft.channelId ?? "default"}`;
    return recordOutcome(this.log, { actor: this.actor, action: "publish_cast", subject, detail: { text: draft.text, embeds: draft.embedUrls ?? [] } }, () =>
      this.inner.publishCast(draft),
    );
  }

  likeCast(target: CastReference): Promise<void> {
    return recordOutcome(this.log, { actor: this.actor, action: "like_cast", subject: target.hash }, () => this.inner.likeCast(target));
  }
}
