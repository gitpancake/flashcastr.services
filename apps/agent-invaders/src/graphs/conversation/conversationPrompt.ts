import type { ThreadLine } from "../../farcaster/neynarReader.js";
import type { InboundCast } from "../../farcaster/inboundCast.js";
import type { KnownUser, LearnedCorrection } from "../../memory/agentMemory.js";
import { MAX_CAST_CHARS } from "../../validation/lengthValidator.js";

export interface ConversationContext {
  readonly inbound: InboundCast;
  readonly corrections: readonly LearnedCorrection[];
  readonly knownUser: KnownUser | null;
  readonly today: string;
}

function correctionsBlock(corrections: readonly LearnedCorrection[]): string {
  if (corrections.length === 0) return "";
  const lines = corrections.map((correction) => `- [${correction.learnedAt.slice(0, 10)}] NOT "${correction.wrongClaim}" — the correct fact: ${correction.correctFact}`);
  return `\nLEARNED CORRECTIONS (the community corrected you on these; never repeat the wrong claim):\n${lines.join("\n")}\n`;
}

function userBlock(user: KnownUser | null): string {
  if (!user || user.notes.length === 0) return "";
  return `\nWHAT YOU REMEMBER ABOUT @${user.username}:\n- ${user.notes.join("\n- ")}\n`;
}

export function conversationTaskPrompt(context: ConversationContext): string {
  return `TASK: Reply to @${context.inbound.authorUsername} (fid ${context.inbound.authorFid}) who ${context.inbound.kind === "reply" ? "replied to you" : "mentioned you"} on Farcaster. Today is ${context.today}.

Ground every fact in tool results. When someone asks how an invader is doing, ALWAYS call lookup_invader_status for that ID before answering, then report its catalogued condition, points, city and the latest spotter report date. If the tool says an ID is not in the catalogue, say so. Use recent_invader_events for "what's new in <city>" questions and search_invader_news for exhibitions, auctions and press.

If the person corrects a fact you stated and their correction is specific and credible, call remember_correction, then acknowledge it in character. If they share something durable about themselves, call note_about_user.
${correctionsBlock(context.corrections)}${userBlock(context.knownUser)}
Your final message is posted verbatim as a reply cast: plain text, under ${MAX_CAST_CHARS - 40} characters, no markdown, no preamble, no JSON. Address them naturally without repeating their whole question.`;
}

export function threadContextMessage(lines: readonly ThreadLine[]): string {
  return `Thread so far (oldest first):\n${lines.map((line) => `@${line.username}: ${line.text}`).join("\n")}`;
}
