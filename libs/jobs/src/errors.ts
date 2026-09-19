/**
 * Thrown by a handler when the message itself is fine but a dependency is
 * temporarily unavailable (open circuit, rate limit). The consumer waits
 * `retryAfterMs` and requeues without counting an attempt.
 */
export class TransientError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number
  ) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Thrown by a handler when a message can never succeed. The consumer sends it
 * to the dead-letter queue immediately, regardless of retry policy.
 */
export class FatalMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalMessageError";
  }
}
