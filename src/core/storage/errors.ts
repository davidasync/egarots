import {
  MAX_FILENAME_LENGTH,
  MAX_OBJECT_BYTES,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_CONTENT_TYPE_LENGTH,
} from "./entity";

export class StorageError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export type ErrorKind =
  | "length_required"
  | "empty_body"
  | "too_large"
  | "invalid_content_type"
  | "invalid_filename"
  | "invalid_ttl"
  | "not_found"
  | "rate_limited"
  | "unidentified_client"
  | "id_unavailable"
  | "storage_unavailable";

export const ErrLengthRequired = () =>
  new StorageError("length_required", "content-length header is required");
export const ErrEmptyBody = () => new StorageError("empty_body", "body must not be empty");
export const ErrTooLarge = () =>
  new StorageError("too_large", `object must be at most ${MAX_OBJECT_BYTES} bytes`);
export const ErrInvalidContentType = () =>
  new StorageError(
    "invalid_content_type",
    `content-type must be a valid media type of at most ${MAX_CONTENT_TYPE_LENGTH} characters`,
  );
export const ErrInvalidFilename = () =>
  new StorageError(
    "invalid_filename",
    `filename must be at most ${MAX_FILENAME_LENGTH} printable characters and contain no path separators`,
  );
export const ErrInvalidTTL = () =>
  new StorageError(
    "invalid_ttl",
    `ttl must be an integer between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} seconds`,
  );

/**
 * One message for "never existed", "expired" and "that is not even an id shape".
 * A distinct status or wording for the expired case would confirm that an id was
 * once real, and with no auth and no listing the id is the only thing protecting
 * the bytes. Do not add a 410.
 */
export const ErrNotFound = () => new StorageError("not_found", "not found");

export const ErrRateLimited = () => new StorageError("rate_limited", "rate limited");

/**
 * No `cf-connecting-ip`, so the write cannot be charged to anyone. Cloudflare
 * always sets it in production; its absence means the Worker is behind something
 * unexpected, and an unattributable write is exactly what the rate limit exists
 * to prevent. Refusing is the conservative read of an impossible situation.
 */
export const ErrUnidentifiedClient = () =>
  new StorageError("unidentified_client", "could not identify the client");

/** Only reachable if the id generator is producing collisions, which at 62^12
 * means it is broken rather than unlucky. Retryable, hence 503 and not 500. */
export const ErrIdUnavailable = () =>
  new StorageError("id_unavailable", "could not allocate an id, try again");

/** The store refused the write, so the object does not exist. */
export const ErrStorageUnavailable = () =>
  new StorageError("storage_unavailable", "could not store object, try again later");

export function isKind(err: unknown, kind: ErrorKind): boolean {
  return err instanceof StorageError && err.kind === kind;
}
