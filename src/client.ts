/**
 * The Live Tennis API client.
 *
 * ```ts
 * import { LiveTennisAPI } from 'livetennisapi';
 *
 * const client = new LiveTennisAPI({ apiKey: 'twjp_…' });
 * const matches = await client.listMatches({ status: 'live' });
 * ```
 *
 * Uses the platform `fetch`, so it runs unchanged on Node 18+, Deno, Bun,
 * Cloudflare Workers and the browser, with no runtime dependencies.
 */

import {
  APIConnectionError,
  APITimeoutError,
  RateLimited,
  Tier,
  UpgradeRequired,
  errorForStatus,
} from './errors.js';
import type {
  Analysis,
  Fixture,
  Market,
  Match,
  MatchEvent,
  MatchStatus,
  Tour,
  Page,
  Player,
  Score,
} from './types.js';

import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.livetennisapi.com/api/public/v1';
const MAX_LIMIT = 200;

/**
 * Endpoints needing more than the FREE floor, so a 403 can name the tier.
 * Order matters: the first marker that matches the path wins, so the more
 * specific `/history` sits above nothing it could shadow.
 */
const TIER_REQUIREMENTS: ReadonlyArray<readonly [string, Tier]> = [
  ['/analysis', 'ULTRA'],
  ['/events', 'PRO'],
  ['/markets', 'PRO'],
  ['/history', 'BASIC'],
];

function requiredTierFor(path: string): Tier | undefined {
  for (const [marker, tier] of TIER_REQUIREMENTS) {
    if (path.includes(marker)) return tier;
  }
  return undefined;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface ClientOptions {
  /** Your `twjp_` key. Falls back to `process.env.LIVETENNISAPI_KEY` on Node. */
  apiKey?: string;
  baseUrl?: string;
  /** Per-request timeout in ms. Default 30000. */
  timeout?: number;
  /** Retries for 429/5xx only. Default 2. */
  maxRetries?: number;
  /** Which header carries the key. Default `bearer`. */
  authHeader?: 'bearer' | 'x-api-key';
  /** Injectable for tests or a custom transport. */
  fetch?: typeof globalThis.fetch;
}

export type ListParams = {
  limit?: number;
  offset?: number;
};

/** Read an env var, guarded: `process` does not exist in a browser or edge runtime. */
export function readEnv(name: string): string {
  try {
    return (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[name] ?? '';
  } catch {
    return '';
  }
}

/** True in a browser, where the platform forbids setting User-Agent. */
function isBrowser(): boolean {
  return typeof (globalThis as { window?: unknown }).window !== 'undefined';
}

export class LiveTennisAPI {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  private readonly authHeader: 'bearer' | 'x-api-key';
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.apiKey = (options.apiKey ?? readEnv('LIVETENNISAPI_KEY')).trim();
    this.baseUrl = (options.baseUrl ?? (readEnv('LIVETENNISAPI_BASE_URL') || DEFAULT_BASE_URL)).replace(/\/+$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.authHeader = options.authHeader ?? 'bearer';

    const impl = options.fetch ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new Error(
        'No global fetch available. Use Node 18+, or pass a fetch implementation via { fetch }.',
      );
    }
    this.fetchImpl = impl;
  }

  // -- transport --------------------------------------------------------------

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // Browsers forbid setting User-Agent; everywhere else it makes this client
    // attributable in API logs, matching the Python client.
    if (!isBrowser()) headers['User-Agent'] = `livetennisapi-js/${VERSION}`;
    if (this.apiKey) {
      if (this.authHeader === 'bearer') headers.Authorization = `Bearer ${this.apiKey}`;
      else headers['X-API-Key'] = this.apiKey;
    }
    return headers;
  }

  private url(path: string, params?: Record<string, unknown>): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Retry only what retrying can fix. 429 and 5xx are transient; every other
   * 4xx is a client-side mistake that cannot start working, and retrying it
   * only burns the caller's rate limit.
   */
  private shouldRetry(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private backoff(attempt: number, retryAfter?: number): number {
    if (retryAfter !== undefined) return Math.min(retryAfter * 1000, 60_000);
    return Math.min(500 * 2 ** attempt + Math.random() * 250, 10_000);
  }

  private async request<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = this.url(path, params);

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.headers(),
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        if (attempt >= this.maxRetries) {
          throw aborted
            ? new APITimeoutError(`request to ${url} timed out after ${this.timeout}ms`)
            : new APIConnectionError(`could not reach ${url}: ${String(err)}`);
        }
        await sleep(this.backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (this.shouldRetry(response.status) && attempt < this.maxRetries) {
        // Drain the discarded body, or undici holds the connection until GC.
        try {
          await response.body?.cancel();
        } catch {
          /* already consumed or unsupported */
        }
        await sleep(this.backoff(attempt, retryAfterSeconds(response.headers)));
        continue;
      }

      if (!response.ok) await this.throwFor(response, path, url);
      return (await this.decode(response)) as T;
    }
  }

  private async decode(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  private async throwFor(response: Response, path: string, url: string): Promise<never> {
    const body = await this.decode(response);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Truthiness, not `??`: an `{"error": null}` body or an empty statusText
    // (HTTP/2 has none) must fall through to the generic message rather than
    // surface as the string "null" or "". Matches the Python client.
    const raw = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    const code = typeof raw === 'string' && raw ? raw : undefined;
    const message = code || response.statusText || 'request failed';
    const options = { status: response.status, body, headers, url };

    if (response.status === 403) {
      throw new UpgradeRequired(message, { ...options, requiredTier: requiredTierFor(path) });
    }
    if (response.status === 429) {
      throw new RateLimited(message, { ...options, retryAfter: retryAfterSeconds(response.headers) });
    }
    const Cls = errorForStatus(response.status);
    throw new Cls(message, options);
  }

  // -- endpoints --------------------------------------------------------------

  /** Liveness probe. Needs no authentication. */
  health(): Promise<{ status: string; version: string }> {
    return this.request('/health');
  }

  /**
   * Matches by lifecycle status, optionally restricted to one tour.
   *
   * The default is applied AFTER the spread. With the spread last, an explicit
   * `status: undefined` — which is what `{ status: someMaybeUndefined }` produces
   * — overwrote the default back to undefined and the request went out with no
   * status at all.
   */
  listMatches(params: { status?: MatchStatus; tour?: Tour } & ListParams = {}): Promise<Page<Match>> {
    return this.request('/matches', { ...params, status: params.status ?? 'live' });
  }

  /** Full match detail. Embeds `market` at PRO and `analysis` at ULTRA. */
  getMatch(matchId: number): Promise<Match> {
    return this.request(`/matches/${matchId}`);
  }

  /** Current score only — the lowest-latency read available. */
  getMatchScore(matchId: number): Promise<Score> {
    return this.request(`/matches/${matchId}/score`);
  }

  /** Match events, newest first. **PRO.** */
  listMatchEvents(matchId: number, params: ListParams = {}): Promise<Page<MatchEvent>> {
    return this.request(`/matches/${matchId}/events`, params);
  }

  /** Model analysis for a match. **ULTRA.** */
  getMatchAnalysis(matchId: number): Promise<Analysis> {
    return this.request(`/matches/${matchId}/analysis`);
  }

  /** Search players by name. Ranked players come first. */
  searchPlayers(search?: string, params: ListParams = {}): Promise<Page<Player>> {
    return this.request('/players', { search, ...params });
  }

  /** One player's bio, ranking and cached stats. */
  getPlayer(playerId: number): Promise<Player> {
    return this.request(`/players/${playerId}`);
  }

  /** Match-winner market(s) for a match. **PRO.** */
  listMarkets(matchId: number): Promise<Page<Market>> {
    return this.request('/markets', { match_id: matchId });
  }

  /** Market with recent price ticks per side, newest first. **PRO.** */
  getMarketPrices(matchId: number, params: { limit?: number } = {}): Promise<Market> {
    return this.request(`/markets/${matchId}/prices`, params);
  }

  /** Completed matches, newest first, with a derived `winner`. */
  listCompletedMatches(params: ListParams = {}): Promise<Page<Match>> {
    return this.request('/history/matches', params);
  }

  /** Upcoming scheduled fixtures, earliest first. */
  listFixtures(params: { tour?: Tour } & ListParams = {}): Promise<Page<Fixture>> {
    return this.request('/fixtures', params);
  }

  // -- pagination -------------------------------------------------------------

  /**
   * Walk every page of a list endpoint.
   *
   * ```ts
   * for await (const player of client.paginate((p) => client.searchPlayers('nadal', p))) {
   *   console.log(player.name);
   * }
   * ```
   *
   * Stops on a short page, which is the only reliable end-of-data signal:
   * `meta.count` describes the page, not the total.
   */
  async *paginate<T>(
    fetchPage: (params: ListParams) => Promise<Page<T>>,
    pageSize = MAX_LIMIT,
  ): AsyncGenerator<T, void, unknown> {
    const limit = Math.max(1, Math.min(pageSize, MAX_LIMIT));
    let offset = 0;

    for (;;) {
      const page = await fetchPage({ limit, offset });
      const items = page?.data ?? [];
      for (const item of items) yield item;
      if (items.length < limit) return;
      offset += limit;
    }
  }
}
