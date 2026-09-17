import { CastValidator, type CastCandidate } from "./castValidator.js";

const FORBIDDEN_PHRASES: readonly RegExp[] = [
  /as an ai/i,
  /language model/i,
  /i(?:'m| am) (?:just )?(?:an? )?(?:automated|bot)/i,
  /i can(?:'t|not) comment/i,
  /no data so/i,
  /\bllm\b/i,
];

export class ForbiddenPhraseValidator extends CastValidator {
  protected check(candidate: CastCandidate): string[] {
    const hits = FORBIDDEN_PHRASES.filter((pattern) => pattern.test(candidate.text));
    return hits.map((pattern) => `contains out-of-character phrase matching ${pattern}`);
  }
}
