export interface ShouldPollInput {
  now: number;
  lastAttemptAt: number | null;
  isPeak: boolean;
  offPeakMinIntervalMs: number;
}

export interface ShouldPollResult {
  poll: boolean;
  reason: string;
  nextEligibleAt?: number;
}

export function shouldPoll({ now, lastAttemptAt, isPeak, offPeakMinIntervalMs }: ShouldPollInput): ShouldPollResult {
  if (isPeak) return { poll: true, reason: "peak" };
  if (lastAttemptAt === null) return { poll: true, reason: "first poll since boot" };

  const nextEligibleAt = lastAttemptAt + offPeakMinIntervalMs;
  if (now >= nextEligibleAt) return { poll: true, reason: "off-peak interval elapsed" };
  return { poll: false, reason: "off-peak interval not elapsed", nextEligibleAt };
}
