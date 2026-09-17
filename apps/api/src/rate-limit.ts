import { GraphQLError } from "graphql";
import type { RequestContext, Resolver } from "./auth.js";

export const RATE_LIMITED_ERROR_CODE = "RATE_LIMITED";

const SWEEP_EVERY_CALLS = 1000;

export class SlidingWindowLimiter {
  private readonly hitsByKey = new Map<string, number[]>();
  private callsSinceSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number
  ) {}

  allow(key: string, now = Date.now()): boolean {
    this.maybeSweep(now);

    const windowStart = now - this.windowMs;
    const recentHits = (this.hitsByKey.get(key) ?? []).filter((t) => t > windowStart);
    if (recentHits.length >= this.limit) {
      this.hitsByKey.set(key, recentHits);
      return false;
    }

    recentHits.push(now);
    this.hitsByKey.set(key, recentHits);
    return true;
  }

  private maybeSweep(now: number): void {
    this.callsSinceSweep++;
    if (this.callsSinceSweep < SWEEP_EVERY_CALLS) return;
    this.callsSinceSweep = 0;

    const windowStart = now - this.windowMs;
    for (const [key, hits] of this.hitsByKey) {
      if (hits.every((t) => t <= windowStart)) this.hitsByKey.delete(key);
    }
  }
}

function clientKey(context: RequestContext): string {
  return context.req?.ip ?? "unknown";
}

export function withRateLimit<Args, Result>(
  name: string,
  limiter: SlidingWindowLimiter,
  resolver: Resolver<Args, Result>
): Resolver<Args, Result> {
  return (parent, args, context) => {
    if (!limiter.allow(clientKey(context))) {
      throw new GraphQLError(`Rate limit exceeded for ${name}. Try again later.`, {
        extensions: { code: RATE_LIMITED_ERROR_CODE },
      });
    }
    return resolver(parent, args, context);
  };
}
