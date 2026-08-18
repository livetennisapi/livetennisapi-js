/**
 * Official JavaScript / TypeScript client for the
 * [Live Tennis API](https://livetennisapi.com).
 *
 * Real-time tennis scores, players, rankings, match-winner market prices and
 * model win-probability for ATP, WTA, Challenger, ITF and juniors — over REST
 * and WebSocket.
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

export { PushStream } from './push.js';
export type { PushStreamOptions } from './push.js';

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
  AbuseThrottled,
  ServerError,
  ServiceUnavailable,
} from './errors.js';
export type { Tier } from './errors.js';

export { gamesForSet, formatScore } from './types.js';
export type {
  Analysis,
  ArchiveCareer,
  ArchiveMatch,
  ArchiveParticipant,
  ArchivePlayerBio,
  ArchiveTour,
  BreakPoint,
  BreakPointResult,
  ChartingMatch,
  ChartingPlayer,
  Coverage,
  CoverageBucket,
  CoveragePage,
  Divergence,
  Draw,
  Extensible,
  Fixture,
  HeadToHead,
  HeadToHeadMeeting,
  HistoryPackage,
  ListMeta,
  LivePoint,
  Market,
  Match,
  MatchEvent,
  MatchStatistics,
  MatchStatisticsFamily,
  MatchStatisticsMeasured,
  MatchStatisticsSide,
  MatchStatus,
  PackageFile,
  PackageKind,
  PointSource,
  PointsPage,
  PointUpdate,
  PushFrame,
  RallyMatch,
  RallyMatchDetail,
  RallyPoint,
  RallyShot,
  RankingListMeta,
  RankingRecord,
  RankingsPage,
  RankingSystem,
  RoundCode,
  StatisticsCoverage,
  Tape,
  TapeRow,
  TiebreakScore,
  Tour,
  Tournament,
  TournamentCategory,
  Page,
  Player,
  Price,
  Score,
  ScoreUpdate,
  StreamFrame,
  WsToken,
} from './types.js';

export { VERSION } from './version.js';
