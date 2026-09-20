import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import type { Service } from "../../core/storage/service";
import { newHandler } from "./handler";

export interface Env {
  /**
   * Backblaze B2 credentials. Secrets, so they are set with
   * `wrangler secret put` and never appear in wrangler.toml.
   */
  B2_KEY_ID?: string;
  B2_APP_KEY?: string;
  /** Bucket and region are not secret and live in [vars]. */
  B2_BUCKET?: string;
  B2_REGION?: string;
  /** Overrides the derived `https://s3.<region>.backblazeb2.com`. */
  B2_ENDPOINT?: string;
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Comma-separated origin allowlist, set as a Worker var in wrangler.toml. */
  ALLOWED_ORIGINS?: string;
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function newRouter(
  buildService: (env: Env, waitUntil: (p: Promise<unknown>) => void) => Service,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const h = newHandler();

  /**
   * Unlike nikednep, the read path needs CORS too. There, `GET /:code` is a 302
   * the browser navigates to, so there is nothing to preflight and nothing to
   * read. Here an object is fetched with `fetch()` and its body is read as bytes
   * — without Access-Control-Allow-Origin on the read path the only consumer
   * this service has cannot see what it downloaded.
   *
   * Registered on `/*` rather than per route so that error responses carry the
   * headers as well. A 429 or a 413 without them reaches the browser as an
   * opaque network failure, and the client cannot tell "rate limited" from
   * "offline" — which is exactly when it most needs to.
   *
   * An allowlist rather than `*`: the API is public and the id is the
   * capability, so this buys no real protection against anything but a browser.
   * It keeps the in-browser callers a known, short list. Unset allows no browser
   * origin at all — fail closed.
   *
   * The middleware is built per request because `env` — and with it the
   * allowlist — only exists once a request is in flight.
   */
  app.use("/*", (c, next) =>
    cors({
      origin: allowedOrigins(c.env),
      allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
      // An upload carries an arbitrary Content-Type, which is never one of the
      // three CORS-safelisted values, so POST always preflights. maxAge
      // amortises that to one preflight per browser per day.
      allowHeaders: ["Content-Type"],
      // None of these are CORS-safelisted response headers, so a browser cannot
      // read them unless they are named here. Content-Type, Content-Length and
      // Cache-Control are safelisted and deliberately absent.
      exposeHeaders: ["Location", "ETag", "X-Expires-At", "Content-Disposition"],
      maxAge: 86400,
    })(c, next),
  );

  // Before /:id, which would otherwise match it.
  app.get("/health", (c) => h.health(c));

  /**
   * Work that must outlive the response — only the lazy delete of an expired
   * object — is registered with the runtime here. `executionCtx` throws when
   * there is none (some test harnesses), and a dropped cleanup is survivable,
   * so it degrades to a no-op rather than failing the request.
   */
  const serviceFor = (c: Context<{ Bindings: Env }>) =>
    buildService(c.env, (p) => {
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        // No execution context: the delete is best effort and the bucket
        // lifecycle rule is the real guarantee.
      }
    });

  app.post("/api/objects", (c) => h.create(c, serviceFor(c)));

  /**
   * One route serves both GET and HEAD, because Hono gives no choice: its
   * dispatcher special-cases HEAD by re-running the request as a GET and
   * returning `new Response(null, res)`, so an `app.on("HEAD", ...)` route is
   * never reachable no matter what order it is registered in.
   *
   * Left alone that would make every HEAD pull the whole object out of B2 and
   * throw the body away — paying download bandwidth and a Class B transaction
   * for bytes nobody receives, which is the one B2 allowance small enough to
   * care about. The re-dispatch reuses the original Request object, so the true
   * method is still on `c.req.raw`, and that is what picks the path here.
   */
  app.get("/:id", (c) => {
    const svc = serviceFor(c);
    return c.req.raw.method === "HEAD" ? h.head(c, svc) : h.fetch(c, svc);
  });

  return app;
}
