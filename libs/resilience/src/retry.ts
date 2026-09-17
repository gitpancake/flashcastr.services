export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Random extra delay added to each wait, in ms. */
  jitterMs?: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, jitterMs: number): number {
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
  return exponential + Math.random() * jitterMs;
}

/** Runs `fn`, retrying with exponential backoff. Rethrows the last error when attempts are exhausted. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterMs = options.jitterMs ?? 0;
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const hasAttemptsLeft = attempt < maxAttempts;
      if (!hasAttemptsLeft || !isRetryable(error)) throw error;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterMs);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
