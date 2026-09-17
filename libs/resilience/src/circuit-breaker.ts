export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing one trial call. */
  openDurationMs: number;
  onStateChange?: (state: CircuitState) => void;
  now?: () => number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Circuit breaker open; retry in ${retryAfterMs}ms`);
    this.name = "CircuitBreakerOpenError";
  }
}

/**
 * closed: calls pass through, consecutive failures are counted.
 * open: calls fail fast until openDurationMs elapses.
 * half-open: one trial call is allowed; success closes, failure reopens.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private currentState: CircuitState = "closed";

  constructor(private readonly options: CircuitBreakerOptions) {}

  get state(): CircuitState {
    if (this.currentState === "open" && this.retryAfterMs() === 0) this.transition("half-open");
    return this.currentState;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  retryAfterMs(): number {
    if (this.openedAt === null) return 0;
    return Math.max(0, this.openedAt + this.options.openDurationMs - this.now());
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === "open") throw new CircuitBreakerOpenError(this.retryAfterMs());
    if (state === "half-open") {
      if (this.trialInFlight) throw new CircuitBreakerOpenError(this.retryAfterMs());
      this.trialInFlight = true;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    } finally {
      this.trialInFlight = false;
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    if (this.currentState !== "closed") this.transition("closed");
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    const shouldOpen = this.currentState === "half-open" || this.consecutiveFailures >= this.options.failureThreshold;
    if (!shouldOpen) return;
    this.openedAt = this.now();
    if (this.currentState !== "open") this.transition("open");
  }

  private transition(state: CircuitState): void {
    this.currentState = state;
    this.options.onStateChange?.(state);
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
