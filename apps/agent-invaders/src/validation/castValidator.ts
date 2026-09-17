export interface CastCandidate {
  readonly text: string;
  readonly allowedInvaderIds: ReadonlySet<string>;
}

export interface ValidationVerdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export abstract class CastValidator {
  private next: CastValidator | null = null;

  setNext(validator: CastValidator): CastValidator {
    this.next = validator;
    return validator;
  }

  validate(candidate: CastCandidate): ValidationVerdict {
    const reasons = this.check(candidate);
    const downstream = this.next ? this.next.validate(candidate) : { ok: true, reasons: [] };
    const combined = [...reasons, ...downstream.reasons];
    return { ok: combined.length === 0, reasons: combined };
  }

  protected abstract check(candidate: CastCandidate): string[];
}

export function chainValidators(first: CastValidator, ...rest: CastValidator[]): CastValidator {
  let tail = first;
  for (const validator of rest) tail = tail.setNext(validator);
  return first;
}
