import { newRepository } from "./adapter/b2/repository";
import { newClock } from "./adapter/clock/system";
import { newGenerator } from "./adapter/nanoid/generator";
import { newBindingLimiter } from "./adapter/ratelimit/binding";
import { newMemoryLimiter } from "./adapter/ratelimit/memory";
import type { RateLimiter } from "./core/storage/ports";
import { newService, type Service } from "./core/storage/service";
import type { Env } from "./app/http/router";

/**
 * Composition root: the only place that knows which adapter backs which port.
 * Replaces the Go build's dig container — plain wiring is enough at this size.
 */
export function buildService(env: Env, waitUntil: (p: Promise<unknown>) => void): Service {
  // Nothing checks this configuration — not tsc, not deploy. B2 is a plain HTTP
  // API rather than a binding, so a missing secret would otherwise surface as a
  // signature error from inside the signer on every single request.
  const cfg = {
    keyId: required(env.B2_KEY_ID, "B2_KEY_ID", "wrangler secret put B2_KEY_ID"),
    appKey: required(env.B2_APP_KEY, "B2_APP_KEY", "wrangler secret put B2_APP_KEY"),
    bucket: required(env.B2_BUCKET, "B2_BUCKET", "set it under [vars] in wrangler.toml"),
    region: required(env.B2_REGION, "B2_REGION", "set it under [vars] in wrangler.toml"),
    ...(env.B2_ENDPOINT === undefined ? {} : { endpoint: env.B2_ENDPOINT }),
  };

  const clock = newClock();
  const objects = newRepository(cfg, () => clock.now(), waitUntil);
  return newService(objects, buildRateLimiter(env), clock, newGenerator());
}

let fallbackLimiter: RateLimiter | undefined;

function buildRateLimiter(env: Env): RateLimiter {
  if (env.RATE_LIMITER) {
    return newBindingLimiter(env.RATE_LIMITER);
  }
  // Kept across requests so the per-isolate window actually accumulates.
  fallbackLimiter ??= newMemoryLimiter();
  return fallbackLimiter;
}

function required(value: string | undefined, name: string, how: string): string {
  if (value === undefined || value === "") {
    throw new Error(`missing ${name} — ${how}`);
  }
  return value;
}
