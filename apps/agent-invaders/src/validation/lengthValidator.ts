import { CastValidator, type CastCandidate } from "./castValidator.js";

export const MAX_CAST_CHARS = 320;

export class LengthValidator extends CastValidator {
  constructor(private readonly maxChars: number = MAX_CAST_CHARS) {
    super();
  }

  protected check(candidate: CastCandidate): string[] {
    const trimmed = candidate.text.trim();
    if (trimmed.length === 0) return ["cast text is empty"];
    if (trimmed.length > this.maxChars) return [`cast is ${trimmed.length} chars, max ${this.maxChars}`];
    return [];
  }
}
