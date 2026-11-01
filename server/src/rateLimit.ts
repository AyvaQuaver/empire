import { AppError, ERR } from "./errors.js";

// Simple fixed-window rate limiter backed by an in-memory map, keyed by caller.
// Deliberately per-process: this protects a small MVP from trivial abuse, not a full WAF.
const buckets = new Map<string, { count: number; windowStart: number }>();

export function rateLimitOr429(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { count: 0, windowStart: now };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    throw new AppError(ERR.RATE_LIMITED, 429, "Too many requests. Please wait a moment and try again.");
  }
}

export function clearRateLimits(): void {
  buckets.clear();
}
