/**
 * Response types.
 *
 * Every interface carries an index signature. That is deliberate: the API ships
 * additive changes within `v1`, so a type that forbids unknown keys would make
 * a new server-side field a compile error for consumers. Instead, new fields
 * are simply readable — untyped, but present.
 */

/** Anything the server may add later stays reachable. */
export interface Extensible {
  [key: string]: unknown;
}

export interface ListMeta extends Extensible {
  limit?: number;
  offset?: number;
  count?: number;
  /** Size of the whole filtered set. Null when it cannot be counted cheaply. */
  total?: number | null;
  /** More results exist beyond this page. Read this, not `count` vs `limit`. */
  has_more?: boolean;
}

/** A paged list response: `{data, meta}`. */
export interface Page<T> {
  data: T[];
  meta?: ListMeta;
}

/**
 * A match score at a point in time.
 *
 * `sets` is `[sets_p1, sets_p2]`.
 *
 * `games` is `[games_p1, games_p2]` where **each side is a per-set list** — so
 * `[[6,3,2],[4,6,1]]` reads 6-4, 3-6, 2-1. It is player-major, not set-major;
 * indexing it the other way is the most common mistake against this API. Use
 * {@link gamesForSet} rather than indexing by hand.
 *
 * `win_probability_p1` and `danger` are present only on the ULTRA tier.
 */
export interface Score extends Extensible {
  sets?: number[];
  games?: number[][];
  points?: string[];
  server?: 1 | 2 | null;
  is_tiebreak?: boolean;
  win_probability_p1?: number | null;
  danger?: number | null;
  timestamp?: string | null;
}

export interface Player extends Extensible {
  id?: number;
  name?: string;
  tour?: string | null;
  country?: string | null;
  ranking?: number | null;
  ranking_points?: number | null;
  ranking_movement?: 'up' | 'down' | 'same' | null;
  hand?: 'R' | 'L' | null;
  backhand?: 1 | 2 | null;
  birthday?: string | null;
  is_doubles_team?: boolean;
  /** Populated by the single-player endpoint only. */
  stats?: { ratings?: unknown; season?: unknown } | null;
}

/** One price tick. `side` is 1 for p1's outcome, 2 for p2's. */
export interface Price extends Extensible {
  side?: 1 | 2 | null;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  spread?: number | null;
  timestamp?: string | null;
}

/** A match-winner market. PRO and above. */
export interface Market extends Extensible {
  id?: number;
  question?: string | null;
  status?: 'active' | 'resolved' | 'closed' | null;
  volume?: number | null;
  liquidity?: number | null;
  end_date?: string | null;
  prices?: Price[];
}

/** Model analysis. ULTRA only; either half may be null. */
export interface Analysis extends Extensible {
  thesis?: {
    pick_side?: 1 | 2;
    confidence?: number | null;
    win_probability_pick?: number | null;
    state?: 'valid' | 'confirmed' | 'weakened' | 'broken' | null;
    reasoning?: string | null;
    notes?: { matchup?: string | null; environment?: string | null; fatigue?: string | null };
    scenario_playbook?: unknown[] | null;
    created_at?: string | null;
  } | null;
  profile?: {
    win_probability_p1?: number | null;
    expected_closeness?: number | null;
    volatility_rating?: 'low' | 'med' | 'high' | null;
    key_factors?: string[] | null;
    created_at?: string | null;
  } | null;
}

/** A match event. PRO and above. */
export interface MatchEvent extends Extensible {
  type?: 'break' | 'set_won' | 'game_won' | 'momentum_run';
  player?: 1 | 2 | null;
  timestamp?: string | null;
}

/**
 * A scheduled fixture. Names are always present; `player1_id` / `player2_id`
 * are our roster ids where the participant resolves by exact key — null
 * otherwise, which is a real state, not an omission.
 */
export interface Fixture extends Extensible {
  id?: number;
  event_date?: string | null;
  /** Scheduled start (UTC). Null until the order of play assigns a time — a date-only fixture is a real state. */
  start_time?: string | null;
  player1_id?: number | null;
  player2_id?: number | null;
  tour?: string | null;
  tournament?: string | null;
  round?: string | null;
  /** Normalized round — same vocabulary as {@link Match.round_code}. */
  round_code?: RoundCode | null;
  surface?: string | null;
  player1_name?: string | null;
  player2_name?: string | null;
  status?: string | null;
}

/**
 * A match.
 *
 * `market` appears from PRO, `analysis` from ULTRA. Both are *absent* below
 * those tiers rather than null, so treat `undefined` as "not entitled or not
 * available", never as "no market exists".
 */
export interface Match extends Extensible {
  id?: number;
  tournament?: string;
  /**
   * The tour, in the SAME vocabulary the `tour` query filter accepts — a match
   * selected by `tour: 'itf'` always carries `'itf'` here. Null when the feed
   * never stated a tour (exhibitions, team and mixed events). Group and filter
   * on this; never parse the tournament name for it.
   */
  tour?: Tour | null;
  /**
   * Stable tournament identity — one id per tournament × event type, stable
   * across seasons. Joins `getTournament()`. Null on matches ingested before
   * the catalogue covered their tournament.
   */
  tournament_id?: string | null;
  surface?: 'hard' | 'clay' | 'grass' | null;
  indoor?: boolean;
  format?: 'BO3' | 'BO5' | null;
  round?: string | null;
  /**
   * The round in the archive's controlled vocabulary, normalized from the
   * free-text `round` label (`Q` = qualifying round the feed does not number).
   * This is the field to branch on — it matches `listArchiveMatches({ round })`
   * exactly. Null when the label is unrecognised, never guessed.
   */
  round_code?: RoundCode | null;
  status?: 'upcoming' | 'live' | 'completed' | 'cancelled';
  /**
   * How the match ended (or paused) when it did not run its course:
   * `Retired` | `Cancelled` | `Walk Over` | `Postponed` | `Interrupted`
   * (suspended in play — paused, not over). Null means completed normally OR
   * never resolved — the feed does not distinguish those. Branch settlement
   * logic on this, never on string-matching the tournament or round.
   */
  event_status?: string | null;
  is_doubles?: boolean;
  scheduled_time?: string | null;
  players?: { p1?: Player; p2?: Player };
  score?: Score | null;
  winner?: 1 | 2 | null;
  /**
   * Completed matches only — which player retired or conceded the walkover
   * (the withdrawer is the loser by the rules of the sport). Present only when
   * `event_status` is `Retired`/`Walk Over` and the winner is derivable;
   * absent means "not a withdrawal, or no evidence", never a guess.
   */
  withdrew?: 1 | 2;
  market?: Market | null;
  analysis?: Analysis | null;
}

/** A `score` frame from the WebSocket feed. */
export interface ScoreUpdate extends Score {
  type?: 'score';
  match_id?: number;
}

/**
 * A `break_point` frame — a break point is on the board.
 *
 * Delivered only when the stream subscribed with `signals: ['break_point']`
 * (ULTRA). `server` is the player serving, `returner` the one holding the break
 * point(s); `break_points` is how many are live at once (1-3). `prob_swing` is
 * the same quantity the REST score exposes as `danger`. Every field is ULTRA-only.
 */
export interface BreakPoint extends Extensible {
  type?: 'break_point';
  match_id?: number;
  server?: 1 | 2 | null;
  returner?: 1 | 2 | null;
  break_points?: number;
  set?: number;
  game?: number;
  point?: string;
  win_probability_p1?: number | null;
  prob_swing?: number | null;
  server_side_favoured?: boolean | null;
  ts?: string | null;
}

/**
 * A `break_point_result` frame — a break point just resolved.
 *
 * `outcome` is `held` (server saved it) or `broken` (returner converted).
 * `win_probability_p1_after` is p1's win probability once the game closed.
 * Opt-in signal; ULTRA-only.
 */
export interface BreakPointResult extends Extensible {
  type?: 'break_point_result';
  match_id?: number;
  server?: 1 | 2 | null;
  outcome?: 'held' | 'broken';
  win_probability_p1_after?: number | null;
  ts?: string | null;
}

/**
 * Any frame the live stream may yield. `score` frames arrive always; the break
 * frames only when their signal was requested. Narrow on the `type` field.
 */
export type StreamFrame = ScoreUpdate | BreakPoint | BreakPointResult;

export type MatchStatus = 'live' | 'upcoming' | 'completed';

/**
 * Tour filter accepted by `/matches` and `/fixtures`.
 *
 * Each value covers its singles and doubles draws — `atp` includes ATP doubles,
 * `juniors` covers the boys' and girls' Grand Slam draws. An unrecognised value
 * is a 400, never a silent pass-through.
 */
export type Tour = 'atp' | 'wta' | 'challenger' | 'itf' | 'juniors';

/**
 * Normalized round vocabulary, shared by `Match.round_code`,
 * `Fixture.round_code` and the results-archive `round` filter.
 * `Q` is a qualifying round the live feed does not number; the archive's
 * qualifying rounds are always numbered (`Q1`-`Q4`).
 */
export type RoundCode =
  | 'F' | 'SF' | 'QF'
  | 'R16' | 'R32' | 'R64' | 'R128'
  | 'RR' | 'BR'
  | 'Q' | 'Q1' | 'Q2' | 'Q3' | 'Q4'
  | 'ER';

/**
 * How a tape came to exist — the `coverage` vocabulary of `/history/matches`.
 * `from_start` means we watched the match live from 0-0 (a statement about how
 * the rows were obtained, NOT a synonym for "complete").
 */
export type Coverage = 'from_start' | 'partial' | 'reconstructed' | 'reconstructed_partial' | 'none';

/**
 * Tournament category, set only where our catalogues agree unambiguously on an
 * exact-name join — null otherwise, never derived from the name.
 */
export type TournamentCategory =
  | 'grand_slam' | 'masters_1000' | 'tour_finals'
  | 'atp_500' | 'atp_250'
  | 'wta_1000' | 'wta_500' | 'wta_250' | 'wta_125'
  | 'challenger' | 'itf' | 'juniors';

/**
 * A tournament-catalogue row — the stable id space `Match.tournament_id`
 * joins, one id per tournament × event type, stable across seasons.
 */
export interface Tournament extends Extensible {
  id?: string;
  name?: string | null;
  tour?: Tour | null;
  surface?: 'hard' | 'clay' | 'grass' | null;
  indoor?: boolean;
  /** Host city, from a curated table — null where not curated. */
  city?: string | null;
  /** Host country, ISO-3166 alpha-2 — null where not curated. */
  country?: string | null;
  category?: TournamentCategory | null;
}

/** The results archive covers the ATP and WTA tours only. */
export type ArchiveTour = 'atp' | 'wta';

/**
 * One side of a results-archive record — winner or loser.
 *
 * `player_id` is the corpus person id (joins `listArchivePlayers()` within the
 * same tour), NOT a roster player id: the archive is its own id space. `rank`
 * is the player's rank AT THE TIME of the match, as published.
 */
export interface ArchiveParticipant extends Extensible {
  name?: string | null;
  hand?: string | null;
  /** 3-letter code, same vocabulary as `Player.country`. */
  country?: string | null;
  rank?: number | null;
  seed?: number | null;
  player_id?: number | null;
  height_cm?: number | null;
  /** Age at the time of the match, as the corpus records it. */
  age?: number | null;
  /** Draw entry where recorded (WC, Q, LL, PR, SE, …) — null for direct acceptances. */
  entry?: string | null;
}

/**
 * One result from the results archive (1968–2022) — ATP and WTA main draws,
 * qualifying and the ITF/futures tiers. Winner/loser-shaped: results data is
 * recorded that way at the source, so the winner is a field, never an
 * inference. The archive ends 2022-12-31 by design — from 2023 the history
 * product serves our own matches with the point-by-point tape, so no match is
 * ever served from two datasets.
 *
 * `event_date` is the TOURNAMENT START date — per-match dates do not exist in
 * this era's records, and none are invented.
 */
export interface ArchiveMatch extends Extensible {
  id?: number;
  /** The stable corpus key. */
  source_id?: string;
  tour?: ArchiveTour;
  /** Source tier code: G, M, A, F, D, C, O, or a futures category code (e.g. "15"). */
  level?: string | null;
  tournament?: string | null;
  surface?: string | null;
  draw_size?: number | null;
  event_date?: string | null;
  round?: string | null;
  best_of?: number | null;
  minutes?: number | null;
  winner?: ArchiveParticipant;
  loser?: ArchiveParticipant;
  /** The final score as published, e.g. `"6-4 7-6(5)"`, `"6-3 RET"`, `"W/O"`. */
  score?: string | null;
  /** Parsed from the score's own vocabulary; null when unparseable — never guessed. */
  outcome?: 'completed' | 'retired' | 'walkover' | 'default' | 'abandoned' | null;
  /**
   * Detail endpoint only — per-match serve statistics where the era recorded
   * them ({winner: {...}, loser: {...}}). Null for most rows before 1991;
   * that null is honest, never filled in.
   */
  stats?: { winner?: Record<string, unknown> | null; loser?: Record<string, unknown> | null } | null;
}

/**
 * One person of the results archive. `id` is the corpus person id that archive
 * match rows carry as `winner.player_id` / `loser.player_id`, scoped per tour —
 * never a roster id. Career-high rank and the earliest week it was reached are
 * computed offline from the corpus's own weekly ranking tables (ATP from 1973,
 * WTA from 1984), never modelled. Null fields are the era's silence.
 */
export interface ArchivePlayerBio extends Extensible {
  id?: number;
  tour?: ArchiveTour;
  name?: string | null;
  hand?: string | null;
  dob?: string | null;
  country?: string | null;
  height_cm?: number | null;
  career_high_rank?: number | null;
  /** The earliest week the career-high rank was reached. */
  career_high_date?: string | null;
}

/**
 * One meeting inside a head-to-head. `era` says which half of the product
 * served the row: `archive` rows carry `archive_match_id`/`level`/`score`;
 * `current` rows carry `match_id`/`round_code` and read their score from the
 * match endpoints. `winner` is 1|2 OF THE H2H REQUEST (your p1/p2), not of the
 * underlying match row.
 */
export interface HeadToHeadMeeting extends Extensible {
  era?: 'archive' | 'current';
  date?: string | null;
  tournament?: string | null;
  level?: string | null;
  round?: string | null;
  round_code?: RoundCode | null;
  surface?: string | null;
  score?: string | null;
  outcome?: string | null;
  winner?: 1 | 2 | null;
  match_id?: number | null;
  archive_match_id?: number | null;
}

/**
 * The record between two players across both halves of the product: the
 * results archive (1968–2022) and our own completed matches (2023→now).
 * `totals` counts only meetings with a KNOWN winner; `undecided` counts the
 * rest. Walkovers and retirements are part of the record — every meeting
 * carries `outcome` so you can exclude them yourself.
 */
export interface HeadToHead extends Extensible {
  /** The resolved names; null when no player matches the fragments. */
  players?: { p1?: { name?: string }; p2?: { name?: string } } | null;
  totals?: { p1_wins?: number; p2_wins?: number; meetings?: number; undecided?: number };
  /** Per-surface win split; keys are surface names plus `unknown`. */
  by_surface?: Record<string, { p1?: number; p2?: number }>;
  /** Newest first, capped at 200. */
  meetings?: HeadToHeadMeeting[];
}

/**
 * Career aggregates over the results archive (1968–2022). Everything is a sum
 * or a ratio of sums over rows `listArchiveMatches()` can fetch individually —
 * nothing is modelled. `serve.matches_with_stats` states the coverage
 * honestly: the corpus records per-match serve statistics from 1991 only, so a
 * 1970s career has a full W-L record and an empty serve block.
 */
export interface ArchiveCareer extends Extensible {
  player?: { name?: string };
  span?: { first?: string | null; last?: string | null };
  record?: {
    wins?: number;
    losses?: number;
    /** Finals won (excluding abandoned finals). */
    titles?: number;
    by_surface?: Record<string, { wins?: number; losses?: number }>;
    by_level?: Record<string, { wins?: number; losses?: number }>;
  };
  by_year?: { year?: number; wins?: number; losses?: number }[];
  /** Summed serve statistics + derived ratios; null ratios where the denominator is zero. */
  serve?: {
    matches_with_stats?: number;
    aces?: number;
    double_faults?: number;
    serve_points?: number;
    first_in?: number;
    first_won?: number;
    second_won?: number;
    serve_games?: number;
    bp_saved?: number;
    bp_faced?: number;
    first_in_pct?: number | null;
    first_won_pct?: number | null;
    second_won_pct?: number | null;
    bp_saved_pct?: number | null;
    aces_per_match?: number | null;
  };
}

/**
 * Games for one set as `[p1, p2]`, guarding the player-major layout.
 *
 * ```ts
 * gamesForSet(score, 0);  // [6, 4]
 * ```
 */
export function gamesForSet(
  score: Score | null | undefined,
  setIndex: number,
): [number | undefined, number | undefined] {
  const games = score?.games;
  if (!Array.isArray(games) || games.length < 2) return [undefined, undefined];
  const [p1, p2] = games;
  return [
    Array.isArray(p1) ? p1[setIndex] : undefined,
    Array.isArray(p2) ? p2[setIndex] : undefined,
  ];
}

/** Render a score as `6-4 3-6 2-1 (40-30)`. */
export function formatScore(score: Score | null | undefined): string {
  if (!score) return '-';
  const parts: string[] = [];
  const games = score.games;
  if (Array.isArray(games) && games.length >= 2 && Array.isArray(games[0]) && Array.isArray(games[1])) {
    const sets = Math.max(games[0].length, games[1].length);
    for (let i = 0; i < sets; i += 1) parts.push(`${games[0][i] ?? '-'}-${games[1][i] ?? '-'}`);
  } else if (Array.isArray(score.sets) && score.sets.length >= 2) {
    parts.push(`${score.sets[0]}-${score.sets[1]}`);
  }
  if (Array.isArray(score.points) && score.points.length >= 2) {
    parts.push(`(${score.points[0]}-${score.points[1]})`);
  }
  return parts.join(' ') || '-';
}
