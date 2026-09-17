import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import type { Env } from "../config/env.js";

export type LanguageModel = BaseChatModel;

export interface LanguageModelFactory {
  create(purpose: "compose" | "converse"): LanguageModel;
}

export class FireworksModelFactory implements LanguageModelFactory {
  constructor(private readonly env: Pick<Env, "FIREWORKS_API_KEY" | "FIREWORKS_MODEL" | "FIREWORKS_BASE_URL">) {}

  create(purpose: "compose" | "converse"): LanguageModel {
    return new ChatOpenAI({
      model: this.env.FIREWORKS_MODEL,
      apiKey: this.env.FIREWORKS_API_KEY,
      temperature: purpose === "compose" ? 0.7 : 0.5,
      maxTokens: 4096,
      maxRetries: 3,
      configuration: { baseURL: this.env.FIREWORKS_BASE_URL },
    });
  }
}
