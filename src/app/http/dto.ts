/**
 * Transport inputs arrive as `unknown` and are narrowed in the handler; the core
 * decides whether they are valid. Query and header values are always strings, so
 * the raw string is what travels — including `ttl`, which the core parses, so
 * that "abc" produces the core's own ErrInvalidTTL instead of a silent NaN.
 */
export interface CreateObjectRequest {
  ttl?: unknown;
  filename?: unknown;
  contentType?: unknown;
}

export interface CreateObjectResponse {
  id: string;
  url: string;
  size: number;
  contentType: string;
  filename?: string;
  createdAt: string;
  expireAt: string;
}

export interface ErrorResponse {
  error: string;
}

export interface HealthResponse {
  ok: boolean;
}
