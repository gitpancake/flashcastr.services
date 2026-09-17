import { extractInvaderIds, formatInvaderId } from "../invaders/invaderId.js";
import { CastValidator, type CastCandidate } from "./castValidator.js";

export class GroundingValidator extends CastValidator {
  protected check(candidate: CastCandidate): string[] {
    const unknown = extractInvaderIds(candidate.text)
      .map(formatInvaderId)
      .filter((displayId) => !candidate.allowedInvaderIds.has(displayId));
    if (unknown.length === 0) return [];
    return [`mentions invader ids with no source data: ${unknown.join(", ")}`];
  }
}
