import { Configuration, NeynarAPIClient } from "@neynar/nodejs-sdk";
import { inboundCastFrom, type InboundCast } from "./inboundCast.js";

export interface ThreadLine {
  readonly username: string;
  readonly text: string;
}

export interface FarcasterReader {
  fetchRecentInbound(ownFid: number): Promise<InboundCast[]>;
  fetchThreadContext(threadHash: string): Promise<ThreadLine[]>;
}

interface ConversationCast {
  readonly author: { readonly username?: string | null; readonly fid: number };
  readonly text: string;
  readonly direct_replies?: ConversationCast[];
}

const MAX_DIRECT_REPLIES = 6;
const MAX_NESTED_REPLIES = 3;

function flattenConversation(root: ConversationCast): ThreadLine[] {
  const lines: ThreadLine[] = [{ username: root.author.username ?? `fid:${root.author.fid}`, text: root.text }];
  for (const reply of (root.direct_replies ?? []).slice(-MAX_DIRECT_REPLIES)) {
    lines.push({ username: reply.author.username ?? `fid:${reply.author.fid}`, text: reply.text });
    for (const nested of (reply.direct_replies ?? []).slice(-MAX_NESTED_REPLIES)) {
      lines.push({ username: nested.author.username ?? `fid:${nested.author.fid}`, text: nested.text });
    }
  }
  return lines;
}

export class NeynarReader implements FarcasterReader {
  private readonly client: NeynarAPIClient;

  constructor(apiKey: string, private readonly clock: () => Date = () => new Date()) {
    this.client = new NeynarAPIClient(new Configuration({ apiKey }));
  }

  async fetchRecentInbound(ownFid: number): Promise<InboundCast[]> {
    const response = await this.client.fetchAllNotifications({ fid: ownFid, limit: 25 });
    const receivedAt = this.clock().toISOString();
    const inbound: InboundCast[] = [];
    for (const notification of response.notifications ?? []) {
      const isConversational = notification.type === "mention" || notification.type === "reply";
      if (!isConversational || !notification.cast) continue;
      if (notification.cast.author.fid === ownFid) continue;
      inbound.push(inboundCastFrom(notification.cast, receivedAt));
    }
    return inbound;
  }

  async fetchThreadContext(threadHash: string): Promise<ThreadLine[]> {
    const response = await this.client.lookupCastConversation({ identifier: threadHash, type: "hash", replyDepth: 2 });
    return flattenConversation(response.conversation.cast as unknown as ConversationCast);
  }
}
