import type { NewObject, ObjectMeta, StoredObject } from "./entity";

/**
 * A byte bag keyed by id, and nothing more.
 *
 * This is the one port that inverts nikednep's. There, expiry was the store's
 * alone — KV was asked to keep a link until `expireAt` and the core never
 * re-checked. Backblaze B2 has no per-object TTL, so `expireAt` travels as data and
 * the service is what enforces it. An object existing in the bucket says nothing
 * about whether it should still be served.
 */
export interface ObjectRepository {
  /** Metadata only, no body transfer. Backs `HEAD`. */
  head(id: string): Promise<ObjectMeta | null>;
  /** Null when the id is unknown. The body is not transferred until `readBytes`. */
  get(id: string): Promise<StoredObject | null>;
  /**
   * Writes the object, overwriting anything already under that id.
   *
   * There is no create-if-absent here, because the backing store cannot offer
   * one: Backblaze's S3-compatible API does not implement conditional writes.
   * Uniqueness therefore rests entirely on id entropy — 62^12 is about 3.2e21,
   * so at a million live objects the chance of ever colliding is ~1.6e-10. That
   * is the trade, and it is why GENERATED_ID_LEN is not smaller.
   */
  put(obj: NewObject): Promise<void>;
  /**
   * Fire and forget, deliberately not a Promise. Reclaiming an expired object is
   * an optimisation; the bucket lifecycle rule is the guarantee. Returning void
   * keeps the read path from paying for a delete, and keeps the core honest
   * about the fact that it never learns whether it worked.
   */
  deleteExpired(id: string): void;
}

export interface RateLimiter {
  allow(ip: string): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
