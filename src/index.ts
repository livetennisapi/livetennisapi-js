/**
 * Official JavaScript / TypeScript client for the
 * [Live Tennis API](https://livetennisapi.com).
 *
 * Real-time tennis scores, players, rankings, match-winner market prices and
 * model win-probability for ATP, WTA, Challenger and ITF — over REST and
 * WebSocket.
 *
 * ```ts
 * import { LiveTennisAPI } from 'livetennisapi';
 *
 * const client = new LiveTennisAPI();          // reads LIVETENNISAPI_KEY
 * const { data } = await client.listMatches({ status: 'live' });
 * ```
 *
 * Documentation: https://docs.livetennisapi.com
 */

export { LiveTennisAPI, DEFAULT_BASE_URL } from './client.js';
export type { ClientOptions, ListParams } from './client.js';

export { LiveScoreStream } from './ws.js';
export type { StreamOptions } from './ws.js';

export {
  LiveTennisAPIError,
  APIStatusError,
  APIConnectionError,
  APITimeoutError,
  BadRequest,
  Unauthorized,
  UpgradeRequired,
  NotFound,
  RateLimited,
  ServerError,
  ServiceUnavailable,
} from './errors.js';
export type { Tier } from './errors.js';

export { gamesForSet, formatScore } from './types.js';
export type {
  Analysis,
  Extensible,
  Fixture,
  ListMeta,
  Market,
  Match,
  MatchEvent,
  MatchStatus,
  Tour,
  Page,
  Player,
  Price,
  Score,
  ScoreUpdate,
} from './types.js';

export { VERSION } from './version.js';
