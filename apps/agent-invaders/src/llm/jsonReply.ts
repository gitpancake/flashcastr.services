import type { z } from "zod";
import type { BaseMessage } from "@langchain/core/messages";

function contentText(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (typeof part === "string" ? part : "text" in part ? String(part.text) : ""))
    .join("");
}

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

function firstJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("model reply contains no JSON object");
  return text.slice(start, end + 1);
}

export function parseJsonReply<T>(message: BaseMessage, schema: z.ZodType<T>): T {
  const raw = firstJsonObject(stripFences(contentText(message)));
  return schema.parse(JSON.parse(raw));
}

export { contentText };
