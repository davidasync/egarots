import type { RateLimiter } from "../../core/storage/ports";

const MAX_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

/**
 * Per-isolate fallback for when the rate limiting binding is not configured, e.g.
 * `wrangler dev` without it. Workers spin up many isolates, so this counts only
 * what one of them saw and is an approximation, not an enforcement point.
 */
export function newMemoryLimiter(now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    async allow(ip: string): Promise<boolean> {
      const cutoff = now() - WINDOW_MS;
      const kept = (hits.get(ip) ?? []).filter((t) => t > cutoff);

      if (kept.length >= MAX_PER_WINDOW) {
        hits.set(ip, kept);
        return false;
      }
      kept.push(now());
      hits.set(ip, kept);
      return true;
    },
  };
}
