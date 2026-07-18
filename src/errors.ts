/**
 * Error hierarchy for the Live Tennis API.
 *
 * Every error carries the HTTP status and parsed body, but the common cases are
 * distinguishable by class alone:
 *
 * ```ts
 * try {
 *   await client.getMatchAnalysis(id);
 * } catch (err) {
 *   if (err instanceof UpgradeRequired) console.log(err.requiredTier); // 'ULTRA'
 * }
 * ```
 */

export type Tier = 'BASIC' | 'PRO' | 'ULTRA';

export interface APIErrorOptions {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  url?: string;
}

/** Base class for every error thrown by this library. */
export class LiveTennisAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Required for `instanceof` to survive the ES5 downlevel target.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The request never produced a response (DNS, TLS, refused, aborted). */
export class APIConnectionError extends LiveTennisAPIError {}

/** The request exceeded the configured timeout. */
export class APITimeoutError extends APIConnectionError {}

/** The API returned a non-2xx response. */
export class APIStatusError extends LiveTennisAPIError {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly url?: string;

  constructor(message: string, options: APIErrorOptions) {
    super(message);
    this.status = options.status;
    this.body = options.body;
    this.headers = options.headers ?? {};
    this.url = options.url;
  }

  /** The API's machine-readable code, e.g. `upgrade_required`. */
  get errorCode(): string | undefined {
    if (this.body && typeof this.body === 'object' && 'error' in this.body) {
      const code = (this.body as { error?: unknown }).error;
      if (typeof code === 'string') return code;
    }
    return undefined;
  }
}

/** 400 — a query parameter was malformed. */
export class BadRequest extends APIStatusError {}

/** 401 — the key is missing, unknown, or disabled. */
export class Unauthorized extends APIStatusError {}

/**
 * 403 — the endpoint exists but your tier does not unlock it.
 *
 * Not an authentication failure: the key is valid, the plan is too low.
 * `requiredTier` is inferred from the endpoint, because the API returns only
 * `{"error": "upgrade_required"}`.
 */
export class UpgradeRequired extends APIStatusError {
  readonly requiredTier?: Tier;

  constructor(message: string, options: APIErrorOptions & { requiredTier?: Tier }) {
    super(
      options.requiredTier
        ? `${message} — this endpoint requires the ${options.requiredTier} tier. See https://livetennisapi.com/#pricing`
        : message,
      options,
    );
    this.requiredTier = options.requiredTier;
  }
}

/** 404 — no such resource, or no data for it yet. */
export class NotFound extends APIStatusError {}

/** 429 — the tier's rate-limit window was exceeded. */
export class RateLimited extends APIStatusError {
  /** Seconds the API asked you to wait, from `Retry-After`. */
  readonly retryAfter?: number;

  constructor(message: string, options: APIErrorOptions & { retryAfter?: number }) {
    super(
      options.retryAfter !== undefined ? `${message} — retry after ${options.retryAfter}s` : message,
      options,
    );
    this.retryAfter = options.retryAfter;
  }
}

/** 5xx — the API failed to serve the request. */
export class ServerError extends APIStatusError {}

/** 503 — the public surface is disabled or the service is down. */
export class ServiceUnavailable extends ServerError {}

/** Pick the exception class for a status code. */
export function errorForStatus(status: number): typeof APIStatusError {
  switch (status) {
    case 400:
      return BadRequest;
    case 401:
      return Unauthorized;
    case 403:
      return UpgradeRequired;
    case 404:
      return NotFound;
    case 429:
      return RateLimited;
    case 503:
      return ServiceUnavailable;
    default:
      return status >= 500 ? ServerError : APIStatusError;
  }
}
