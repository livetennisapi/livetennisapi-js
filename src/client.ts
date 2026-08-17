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
  AbuseThrottled,
  APIConnectionError,
  APITimeoutError,
  RateLimited,
  Tier,
  UpgradeRequired,
  errorForStatus,
} from './errors.js';
import type {
  Analysis,
  ArchiveCareer,
  ArchiveMatch,
  ArchivePlayerBio,
  ArchiveTour,
  ChartingMatch,
  ChartingPlayer,
  Coverage,
  CoveragePage,
  Draw,
  Fixture,
  HeadToHead,
  HistoryPackage,
  LivePoint,
  Market,
  Match,
  MatchEvent,
  MatchStatistics,
  MatchStatus,
  PackageKind,
  PointsPage,
  RallyMatch,
  RallyMatchDetail,
  RankingsPage,
  RankingSystem,
  RoundCode,
  Tape,
  Tour,
  Tournament,
  Page,
  Player,
  Score,
  WsToken,
} from './types.js';

import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.livetennisapi.com/api/public/v1';
const MAX_LIMIT = 200;

/**
 * Endpoints needing more than the FREE floor, so a 403 can name the tier.
 * Order matters: the first marker that matches the path wins, so every marker
 * that can appear inside a `/history/…` path sits above the BASIC `/history`
 * catch-all.
 */
const TIER_REQUIREMENTS: ReadonlyArray<readonly [string, Tier]> = [
  ['/analysis', 'ULTRA'],
  ['/statistics', 'ULTRA'],
  ['/points', 'ULTRA'],
  // `/rally` also matches `/history/matches/{id}/rally`, so it must sit above
  // the BASIC `/history` marker.
  ['/rally', 'ULTRA'],
  ['/charting', 'ULTRA'],
  ['/ws-token', 'ULTRA'],
  ['/events', 'PRO'],
  ['/markets', 'PRO'],
  // `/packages` matches `/history/packages` — above `/history` for the same
  // reason as `/rally`.
  ['/packages', 'PRO'],
  // The PRO listing mode; the ULTRA per-player mode overrides this with an
  // explicit hint from `listRankings()`.
  ['/rankings', 'PRO'],
  ['/history', 'BASIC'],
  ['/h2h', 'BASIC'],
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
      if (value === undefined || value === null) continue;
      // Repeatable parameters (`player`) go out as `?player=1&player=2` — the
      // API reads repeats, not comma-joined lists.
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
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

  private async request<T>(
    path: string,
    params?: Record<string, unknown>,
    requiredTier?: Tier,
  ): Promise<T> {
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
        if (response.status === 429) {
          // Not every 429 is worth retrying. A daily 429 (`scope: "day"`) does
          // not lift until the daily reset, and `abuse_throttled` is a ~24h
          // block that counts rejected requests — retrying either inside a
          // request is exactly the loop the API is telling you to fix.
          const body = await this.decode(response);
          const shape = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
          if (shape.error === 'abuse_throttled' || shape.scope === 'day') {
            this.throwFor(response, path, url, body, requiredTier);
          }
        } else {
          // Drain the discarded body, or undici holds the connection until GC.
          try {
            await response.body?.cancel();
          } catch {
            /* already consumed or unsupported */
          }
        }
        await sleep(this.backoff(attempt, retryAfterSeconds(response.headers)));
        continue;
      }

      if (!response.ok) this.throwFor(response, path, url, await this.decode(response), requiredTier);
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

  private throwFor(
    response: Response,
    path: string,
    url: string,
    body: unknown,
    requiredTier?: Tier,
  ): never {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Truthiness, not `??`: an `{"error": null}` body or an empty statusText
    // (HTTP/2 has none) must fall through to the generic message rather than
    // surface as the string "null" or "". Matches the Python client.
    const shape = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const raw = shape.error;
    const code = typeof raw === 'string' && raw ? raw : undefined;
    const message = code || response.statusText || 'request failed';
    const options = { status: response.status, body, headers, url };

    if (response.status === 403) {
      throw new UpgradeRequired(message, {
        ...options,
        requiredTier: requiredTier ?? requiredTierFor(path),
      });
    }
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response.headers);
      if (code === 'abuse_throttled') {
        throw new AbuseThrottled(message, {
          ...options,
          retryAfter,
          retryAtEpoch: typeof shape.retry_at_epoch === 'number' ? shape.retry_at_epoch : undefined,
        });
      }
      throw new RateLimited(message, {
        ...options,
        retryAfter,
        // Daily 429s only — the absolute instant the allowance returns.
        resetsAt: typeof shape.resets_at === 'string' ? shape.resets_at : undefined,
      });
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
   * Matches by lifecycle status, filterable by tour, participant, nationality
   * and play date.
   *
   * - `player` — matches where this player is EITHER participant. Repeatable
   *   (pass an array), max 50 ids; multiple values are the deduplicated union.
   * - `from` / `to` — play-date bounds, `YYYY-MM-DD` or ISO-8601 UTC. A bare
   *   date covers the whole UTC day.
   * - `country` — either participant's `player.country` equals this lowercase
   *   3-letter code. The vocabulary is what the Player object returns —
   *   IOC-style codes (`ned`, `sui`, `gre`), NOT ISO-3166. Players with no
   *   recorded country never match.
   * - `draw` — `'singles' | 'doubles'`, matching `Match.draw`. That field is
   *   three-valued, and a null-draw match (team ties, team exhibitions — the
   *   draw is unknown) matches NEITHER value: filtering by `singles` and then
   *   by `doubles` is not everything. Anything else is a 400 `bad_draw` with
   *   the allowed list in the body.
   *
   * The status default is applied AFTER the spread. With the spread last, an
   * explicit `status: undefined` — which is what `{ status: someMaybeUndefined }`
   * produces — overwrote the default back to undefined and the request went out
   * with no status at all.
   */
  listMatches(
    params: {
      status?: MatchStatus;
      tour?: Tour;
      draw?: Draw;
      player?: number | number[];
      country?: string;
      from?: string;
      to?: string;
    } & ListParams = {},
  ): Promise<Page<Match>> {
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

  /**
   * Completed matches, newest first, with a derived `winner`. **BASIC** (or
   * any History plan).
   *
   * Takes the same `tour` / `draw` / `player` / `country` / `from` / `to`
   * filters as `listMatches()` (a null-draw row matches neither `draw`
   * value), plus `coverage` — keep only matches whose tape has that
   * coverage. Note the coverage filter is applied AFTER the page is cut, so a
   * filtered page is routinely shorter than `limit` (and may be empty) while
   * later pages still hold matching matches — a short filtered page is not an
   * end-of-data signal there.
   *
   * Each row carries a `tape` block (coverage and row count, plus — where the
   * server measures them — `points_complete`, `completeness`,
   * `starts_at_love` and `computed_at`), readable through the types' index
   * signature. An absent field there means an older server or "not measured"
   * — never "no".
   */
  listCompletedMatches(
    params: {
      tour?: Tour;
      draw?: Draw;
      player?: number | number[];
      country?: string;
      from?: string;
      to?: string;
      coverage?: Coverage;
    } & ListParams = {},
  ): Promise<Page<Match>> {
    return this.request('/history/matches', params);
  }

  /**
   * Upcoming scheduled fixtures, earliest first. A fixture whose draw is
   * unknown matches neither `draw` value.
   */
  listFixtures(params: { tour?: Tour; draw?: Draw } & ListParams = {}): Promise<Page<Fixture>> {
    return this.request('/fixtures', params);
  }

  /**
   * Tournament catalogue, name order — the stable id space
   * `Match.tournament_id` joins. `search` is a case-insensitive substring
   * match on the tournament name; a tournament whose draw is unknown matches
   * neither `draw` value.
   */
  listTournaments(
    params: { search?: string; tour?: Tour; draw?: Draw } & ListParams = {},
  ): Promise<Page<Tournament>> {
    return this.request('/tournaments', params);
  }

  /** One tournament by its stable id — the `tournament_id` carried on match objects. */
  getTournament(tournamentId: string): Promise<Tournament> {
    return this.request(`/tournaments/${encodeURIComponent(tournamentId)}`);
  }

  /**
   * The results archive (1968–2022): completed-match RESULTS from a licensed
   * historical corpus — ATP and WTA, main draws, qualifying and the
   * ITF/futures tiers — newest tournament first. **BASIC** (or any History
   * plan).
   *
   * Distinct from the point-by-point tape (2023→now) served by
   * `listCompletedMatches()`: the archive ends exactly where the tape begins,
   * so no match is ever served from two datasets. `name` is a
   * case-insensitive substring match on EITHER player's name (min 3 chars);
   * `from` / `to` bound the tournament START date (the only date this era's
   * records carry); `level` is the source tier code (G, M, A, F, D, C, O, or
   * a futures category code such as "15").
   */
  listArchiveMatches(
    params: {
      tour?: ArchiveTour;
      name?: string;
      from?: string;
      to?: string;
      round?: RoundCode;
      level?: string;
    } & ListParams = {},
  ): Promise<Page<ArchiveMatch>> {
    return this.request('/history/archive/matches', params);
  }

  /**
   * One results-archive record, with per-match serve statistics where the era
   * recorded them — `stats` is null for most rows before 1991, and that null
   * is honest, never synthesised. **BASIC** (or any History plan).
   */
  getArchiveMatch(archiveId: number): Promise<ArchiveMatch> {
    return this.request(`/history/archive/matches/${archiveId}`);
  }

  /**
   * The people of the results archive (1968–2022), ordered by name — hand,
   * date of birth, country, height, and career-high rank with the earliest
   * week it was reached. **BASIC** (or any History plan).
   *
   * Their `id` is the corpus person id that archive match rows carry as
   * `winner.player_id` / `loser.player_id`, scoped per tour — never a roster
   * id.
   */
  listArchivePlayers(params: { name?: string; tour?: ArchiveTour } & ListParams = {}): Promise<Page<ArchivePlayerBio>> {
    return this.request('/history/archive/players', params);
  }

  /**
   * Career aggregates over the results archive (1968–2022) for one player —
   * W-L by surface/level/year, titles, and the summed serve-stat block with
   * honest coverage. **BASIC** (or any History plan).
   *
   * `name` must resolve to exactly one person: an ambiguous fragment is
   * refused with a 400 `ambiguous_name` whose body carries the candidate
   * list (`err.body.candidates`), an unknown one is a 404.
   */
  getArchiveCareer(name: string): Promise<ArchiveCareer> {
    return this.request('/history/archive/career', { name });
  }

  /**
   * Head-to-head across both halves of the product: the results archive
   * (1968–2022) plus our own completed matches (2023→now). **BASIC** (or any
   * History plan).
   *
   * Names are the keys (min 3 chars each) — archive people have no roster
   * ids. A fragment matching more than one player is refused with a 400
   * `ambiguous_name` and the candidate list in `err.body.candidates`, because
   * two people summed into one record is a wrong answer, not a convenience.
   * `meetings[].winner` is 1|2 OF THIS REQUEST (your `p1`/`p2`), not of the
   * underlying match row.
   */
  getH2H(p1: string, p2: string): Promise<HeadToHead> {
    return this.request('/h2h', { p1, p2 });
  }

  /**
   * In-play statistics for one match — aces, double faults, serve split,
   * hold/break %, break points, service and return points. **ULTRA.**
   *
   * Two families, deliberately not merged: DERIVED (rebuilt from the
   * point-by-point record) at the top level of `players.pN`, and MEASURED
   * (counted upstream — the only source of aces and double faults) under
   * `players.pN.measured`. Measured coverage is not uniform: an absent field
   * is omitted, never zero-filled. Branch on `freshness.derived` /
   * `freshness.measured`, and never compare their `age_seconds` — they use
   * different clocks. `coverage: 'none'` is a 200 with null `players`, not a
   * 404.
   */
  getMatchStatistics(matchId: number): Promise<MatchStatistics> {
    return this.request(`/matches/${matchId}/statistics`);
  }

  /**
   * One page of the live point feed for a match — committed points in order,
   * at most 500 per page. **ULTRA**, and server-gated: a 400 `points_disabled`
   * means the server's point gate is off or the plan does not include points
   * (not a retry case), a 400 `bad_after_seq` means the cursor was malformed,
   * a 404 means no such match.
   *
   * `after_seq` resumes EXACTLY after a point you already hold: `point.seq`
   * is per-match, monotonic and gapless (`1..N`), so it doubles as the dedup
   * key. Page with the response's own cursor — pass `last_seq` back as
   * `after_seq` while `has_more` is true — or let {@link iterateMatchPoints}
   * do it. Read `pbp_coverage` before treating rows as points (`'game'` rows
   * are game-grain commits) and treat an absent `covers_from_start` as "not
   * stated" (older servers), never as false.
   */
  getMatchPoints(matchId: number, params: { after_seq?: number } = {}): Promise<PointsPage> {
    return this.request(`/matches/${matchId}/points`, params);
  }

  /**
   * Walk the live point feed for a match from `afterSeq` to the current end,
   * following `has_more` / `last_seq` across pages. **ULTRA.**
   *
   * ```ts
   * for await (const point of client.iterateMatchPoints(18953)) {
   *   console.log(point.seq, point.winner);
   * }
   * ```
   *
   * Ends when the server says `has_more: false` — on a live match that is
   * "everything committed so far", not "the match is over"; resume later with
   * the last `seq` you saw.
   */
  async *iterateMatchPoints(matchId: number, afterSeq = 0): AsyncGenerator<LivePoint, void, unknown> {
    let cursor = afterSeq;
    for (;;) {
      const page = await this.getMatchPoints(matchId, { after_seq: cursor });
      for (const point of page.points ?? []) yield point;
      if (!page.has_more) return;
      // The server's own cursor drives the walk. A cursor that fails to
      // advance would refetch the same page forever, so stop instead.
      if (typeof page.last_seq !== 'number' || page.last_seq <= cursor) return;
      cursor = page.last_seq;
    }
  }

  /**
   * The per-match tape: point-by-point score sequence + per-point model
   * probabilities. **BASIC** (or any History plan).
   *
   * Works on a LIVE match, not only a completed one — the tape is assembled
   * from whatever has been committed so far. `sequence: 'raw'` (the default)
   * is every row we committed, deliberately non-monotonic (independent
   * sources race, and a higher-trust one may correct a lower-trust one
   * backwards); `'clean'` returns one row per distinct score state and is the
   * only sequence that carries `point_winner`. Check `meta.coverage` and
   * `meta.point_source` before backtesting.
   */
  getMatchTape(matchId: number, params: { sequence?: 'raw' | 'clean' } = {}): Promise<Tape> {
    return this.request(`/history/matches/${matchId}`, params);
  }

  /**
   * The measured point-completeness table, one object. **BASIC** (or any
   * History plan).
   *
   * Per `tour_draw` bucket (`atp_singles`, `itf_doubles`, …): how many
   * completed matches we hold (`completed`), how many carry any tape
   * (`any_tape`), how many have a complete point-by-point tape AVAILABLE
   * (`point_complete`), how many a default read serves complete
   * (`complete_on_default_read`), and the `share` — with `totals` across
   * every bucket. The numbers are a built artifact: `as_of` stamps the
   * build, `method` how they were measured, and a 503 `coverage_unavailable`
   * means the artifact is not built yet — not that coverage is zero.
   */
  getHistoryCoverage(): Promise<CoveragePage> {
    return this.request('/history/coverage');
  }

  /**
   * Charted matches with shot-by-shot data, newest first. **ULTRA.**
   *
   * Rally construction is the layer BELOW the tape: the tape says what the
   * score became after each point, this says how the point was played. It has
   * its OWN id space — ask this endpoint for the authoritative coverage list
   * rather than assuming a match is charted; charting is human work, so
   * coverage is deep, not universal. `player` is a substring match on either
   * player name.
   */
  listRallyMatches(
    params: {
      player?: string;
      from?: string;
      to?: string;
      surface?: string;
      gender?: 'M' | 'W';
    } & ListParams = {},
  ): Promise<Page<RallyMatch>> {
    return this.request('/rally/matches', params);
  }

  /**
   * Rally construction for one charted match, points in play order. **ULTRA.**
   * Paged with `limit`/`offset`; `meta.total` is the match's full point count.
   */
  getRallyMatch(rallyMatchId: number, params: ListParams = {}): Promise<RallyMatchDetail> {
    return this.request(`/rally/matches/${rallyMatchId}`, params);
  }

  /**
   * Rally construction addressed by OUR match id, resolved through the
   * optional link. **ULTRA.**
   *
   * A 404 `not_charted` means we hold the match but nobody charted it —
   * deliberately distinct from "no such match", because most of our matches
   * are not charted and a consumer walking the archive must tell them apart
   * (read `err.errorCode`).
   */
  getMatchRally(matchId: number, params: ListParams = {}): Promise<RallyMatchDetail> {
    return this.request(`/history/matches/${matchId}/rally`, params);
  }

  /**
   * Career shot-level charting aggregate for one player — serve placement,
   * return depth, net play, clutch serving, winners/errors by wing, rally
   * tendencies — summed over their charted matches. **ULTRA.**
   *
   * `name` (min 3 chars) is the key; a fragment matching more than one
   * charted person is refused with a 400 carrying candidates — pass
   * `gender: 'men' | 'women'` to disambiguate.
   */
  getChartingPlayer(name: string, params: { gender?: 'men' | 'women' } = {}): Promise<ChartingPlayer> {
    return this.request('/charting/players', { name, ...params });
  }

  /**
   * One charted match — every Match Charting Project stat family for both
   * players, with the per-set split exactly as charted. **ULTRA.**
   * `chartingMatchId` is this product's own id space.
   */
  getChartingMatch(chartingMatchId: number): Promise<ChartingMatch> {
    return this.request(`/charting/matches/${chartingMatchId}`);
  }

  /**
   * Point-in-time rankings, per system. TWO modes:
   *
   * - **Listing (PRO)** — omit `player`: the FULL published table in rank
   *   order for exactly one `system`, the newest week at or before `as_of`.
   *   Rows carry `player_name` as published and a null `player_id` for
   *   players outside our roster, so the table has no silent holes. `utr`
   *   has no listing (a rating, not a ranking).
   * - **Per-player as-of (ULTRA)** — pass `player` ids (repeatable, max 50):
   *   the newest record per system effective ON OR BEFORE `as_of`, never one
   *   dated after it. This is the point-in-time answer — every other ranking
   *   field in this API is the player's CURRENT value joined at read time.
   *
   * Read `meta.coverage` before trusting an empty result: ITF and UTR
   * history begins 2026-07-29 and cannot be reconstructed earlier.
   *
   * **Elo** (`system: 'elo'`) follows two rules of its own:
   * - it is NEVER implied — omitting `system` returns the published-ranking
   *   systems only, so Elo records appear exactly when you name it;
   * - the Elo LISTING (leaderboard mode) requires `tour` — ratings are
   *   computed per tour, and the two tables are not one leaderboard.
   *
   * The remaining filters shape the Elo listing: `surface` selects the
   * surface-specific rating; `archive_player: true` widens it to archive-era
   * players; `min_matches` / `activity_weeks` bound who qualifies for the
   * board (a minimum rated-match count, and how recently a player must have
   * played).
   */
  listRankings(
    params: {
      player?: number | number[];
      /** `YYYY-MM-DD`. Omit for the latest known record. */
      as_of?: string;
      system?: RankingSystem | RankingSystem[];
      /** Required by the Elo listing; ignored by systems that carry their own tour. */
      tour?: 'atp' | 'wta';
      /** Elo listing: the surface-specific rating instead of the overall one. */
      surface?: 'hard' | 'clay' | 'grass';
      /** Elo listing: include archive-era players on the board. */
      archive_player?: boolean;
      /** Elo listing: minimum rated matches to qualify for the board. */
      min_matches?: number;
      /** Elo listing: only players active within this many weeks. */
      activity_weeks?: number;
    } & ListParams = {},
  ): Promise<RankingsPage> {
    // The 403 tier depends on the MODE, which the path alone cannot say:
    // per-player is ULTRA, the listing is PRO.
    return this.request('/rankings', params, params.player !== undefined ? 'ULTRA' : 'PRO');
  }

  /**
   * Pre-built bulk packages, newest period first. **PRO** (or a package
   * subscription); `kind: 'rally' | 'rankings'` and `year` need ULTRA (or,
   * for `year`, History Business / a 1-year package).
   *
   * `kind` defaults to `'tape'` server-side, so a tape-only client never
   * sees a new kind of row appear. `year: 'YYYY'` lists every published
   * month of that year in one call. Treat this listing as the authoritative
   * set of periods that exist — coverage is not contiguous and is still
   * being extended backwards.
   */
  listHistoryPackages(params: { kind?: PackageKind; year?: string } = {}): Promise<Page<HistoryPackage>> {
    return this.request('/history/packages', params);
  }

  /**
   * One bulk package's manifest — file set, counts, sha256. **PRO** (or a
   * package subscription); `kind: 'rally' | 'rankings'` needs ULTRA;
   * `kind: 'archive'` rides the tape entitlement and takes a bare-year period.
   *
   * `period` is `YYYY-MM` (rally packages are keyed by year). The manifest
   * names the downloadable files; fetch the file itself with
   * `?format=jsonl|csv` outside this client — it streams as an attachment,
   * not JSON.
   */
  getHistoryPackage(period: string, params: { kind?: PackageKind } = {}): Promise<HistoryPackage> {
    return this.request(`/history/packages/${encodeURIComponent(period)}`, params);
  }

  /**
   * Mint a short-lived connection token for the high-fan-out push feed
   * (Centrifugo). **ULTRA.**
   *
   * You normally never call this yourself: `PushStream` (built into this
   * package) mints, connects, subscribes and re-mints for you. Reach for the
   * raw token only to connect your own Centrifugo-protocol client to
   * `ws_url` with `token`, subscribing to `match:{id}` for one match or
   * `slate:all` for every live score frame — the exact channel names are in
   * `channels`. Frames are the same score objects the polling endpoints
   * return, model fields included. Mint a fresh token on every reconnect,
   * never reuse one across connections.
   *
   * This is a separate transport from `LiveScoreStream` (the native `/ws`
   * feed): same data, built for high fan-out.
   */
  getWsToken(): Promise<WsToken> {
    return this.request('/ws-token');
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
