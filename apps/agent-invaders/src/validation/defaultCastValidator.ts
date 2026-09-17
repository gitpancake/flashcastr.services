import { chainValidators, type CastValidator } from "./castValidator.js";
import { ForbiddenPhraseValidator } from "./forbiddenPhraseValidator.js";
import { GroundingValidator } from "./groundingValidator.js";
import { LengthValidator } from "./lengthValidator.js";

export function createDefaultCastValidator(): CastValidator {
  return chainValidators(new LengthValidator(), new GroundingValidator(), new ForbiddenPhraseValidator());
}
