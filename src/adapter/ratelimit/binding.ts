import type { RateLimiter } from "../../core/storage/ports";

/**
 * Cloudflare's built-in rate limiting binding: free on every plan, enforced per
 * colo with no storage writes, so it costs nothing against the B2 quota.
 *
 * Per colo is the caveat that matters here. The counter is local to the
 * datacentre the request landed in, and Cloudflare documents the API as
 * permissive and eventually consistent rather than an accounting system, so a
 * distributed client multiplies its budget by the number of colos it can reach.
 * It is a speed bump, not a wall — see README "Free tier".
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export function newBindingLimiter(binding: RateLimitBinding): RateLimiter {
  return {
    async allow(ip: string): Promise<boolean> {
      const { success } = await binding.limit({ key: ip });
      return success;
    },
  };
}
