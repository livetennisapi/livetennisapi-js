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
  /**
   * `'singles'` | `'doubles'` | null — three-valued on purpose. Null means
   * the draw is UNKNOWN (team ties and team exhibitions never state which
   * discipline a rubber was), never a guess — and a null-draw match matches
   * NEITHER value of the `draw` filter. `is_doubles` stays but is lossy (it
   * cannot say "unknown"); branch on this field.
   */
  draw?: Draw | null;
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

/**
 * A `score` frame from the WebSocket feed.
 *
 * The wire NESTS the payload: `{"type": "score", "match_id": N, "score":
 * {...}}` — `score` is the same allowlist {@link Score} object the polling
 * endpoints return, model fields (`win_probability_p1`, `danger`) included
 * (the whole feed is ULTRA). Read `frame.score.sets`, never `frame.sets`:
 * the score fields do not exist at the top level of the frame.
 */
export interface ScoreUpdate extends Extensible {
  type?: 'score';
  match_id?: number;
  score?: Score;
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
  /** The set score when the break point arose, as a string — e.g. `'1-1'`. */
  set?: string;
  /** Games in the current set, as a string — e.g. `'3-4'`. */
  game?: string;
  /** The point score, e.g. `'30-40'` or `'40-AD'`. */
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
 * A `divergence` frame — the model and the match-winner market disagree
 * beyond the server's threshold, and have for its dwell window.
 *
 * `direction` is the side the MODEL rates above the market; `gap` is the
 * absolute model-minus-market probability difference (`model_prob` and
 * `market_prob` are p1's win probability from each source). `price_source`
 * names the public market kind the price came from. Emitted on the push
 * feed's `signal:*` channels (`PushStream` with `signals: true`) where the
 * server's divergence flag is on — an event with no replay, like the
 * break-point signals. ULTRA-only.
 */
export interface Divergence extends Extensible {
  type?: 'divergence';
  match_id?: number;
  model_prob?: number;
  market_prob?: number;
  gap?: number;
  /** The side the model rates ABOVE the market. */
  direction?: 'p1' | 'p2';
  price_source?: string | null;
  ts?: string | null;
}

/**
 * Any frame the live stream may yield. `score` frames arrive always; the
 * break, point and divergence frames only when their signal was requested
 * (`signals: ['break_point']` / `['points']` / `['divergence']`). Narrow on
 * the `type` field.
 */
export type StreamFrame = ScoreUpdate | BreakPoint | BreakPointResult | PointUpdate | Divergence;

/**
 * A publication from the push feed (`PushStream`).
 *
 * The subscribed score channels carry `score` frames — the exact
 * {@link ScoreUpdate} shape the native feed sends, payload nested under
 * `.score` with the model fields inside it. Frames are dispatched by their
 * `type`, so a new frame kind published on a SUBSCRIBED channel arrives with
 * its own `type` value: narrow on `type` and ignore kinds you do not handle.
 * New channel families are not automatic — the point feed lives on its own
 * `point:*` channels ({@link PointUpdate} frames, `points: true`) and the
 * signal families on their `signal:*` channels ({@link BreakPoint} /
 * {@link BreakPointResult} / {@link Divergence} frames, `signals: true`);
 * the `channels` option subscribes families newer than this SDK by name.
 */
export interface PushFrame extends Extensible {
  type?: string;
  match_id?: number;
  score?: Score;
}

/**
 * One committed point of the live point feed. **ULTRA**, and server-gated:
 * served only where the point gate is on and the plan includes points.
 *
 * `seq` is the spine of the whole feed: per-match, monotonic and GAPLESS,
 * `1..N` in point order. It is the dedup key and the resume cursor — a point
 * you have seen has a `seq` you have seen, and `getMatchPoints({ after_seq })`
 * resumes exactly after it. `winner` is who won the point, null when the feed
 * committed the state without an attributable winner. `score` is the point
 * score AFTER the point ({p1, p2}); `sets` / `games` are the running match
 * score in the same layout as {@link Score} — `games` is player-major. `ts`
 * is the CAPTURE time (ISO-8601, UTC), when we committed the point — not when
 * it was played.
 */
export interface LivePoint extends Extensible {
  seq?: number;
  set?: number;
  game?: number;
  /** Point number within the game. */
  number?: number;
  tiebreak?: boolean;
  server?: 1 | 2 | null;
  winner?: 1 | 2 | null;
  /** The point score after this point, e.g. `{p1: '40', p2: '30'}` (numerals in a tiebreak). */
  score?: { p1?: string | number; p2?: string | number } & Extensible;
  /** `[sets_p1, sets_p2]`. */
  sets?: number[];
  /** Player-major, like {@link Score.games}. */
  games?: number[][];
  /** Capture time, ISO-8601 UTC. */
  ts?: string | null;
}

/**
 * A page of `/matches/{id}/points` — at most 500 points, oldest first.
 *
 * `last_seq` is the resume cursor: pass it back as `after_seq` while
 * `has_more` is true (or let `iterateMatchPoints()` do it). `pbp_coverage`
 * says what one row IS — `'point'` rows are individual points, `'game'` rows
 * are game-grain commits (the feed's honest floor where per-point data never
 * existed upstream). `quality: 'revised'` means at least one committed row was
 * later corrected. `covers_from_start` states whether the tape begins at 0-0
 * — it may be ABSENT (not false) on servers that predate the field, so treat
 * `undefined`/`null` as "not stated", never as "no".
 */
export interface PointsPage extends Extensible {
  match_id?: number;
  pbp_coverage?: 'point' | 'game';
  quality?: 'clean' | 'revised';
  /** Absent or null = not stated (older server), NOT false. */
  covers_from_start?: boolean | null;
  points?: LivePoint[];
  last_seq?: number;
  has_more?: boolean;
}

/**
 * A `point` frame from the live feeds — one committed {@link LivePoint},
 * nested under `.point` exactly as `score` frames nest theirs under `.score`.
 *
 * Arrives on the native `/ws` feed when the subscription named
 * `signals: ['points']`, and on the push feed's `point:*` channels
 * (`PushStream` with `points: true`). Unlike score frames, point frames are
 * NOT complete-state: each one is a distinct event, so a missed frame is a
 * missed point — which is what `point.seq` (gapless) lets you detect, and
 * what `PushStream`'s resume machinery repairs over REST.
 */
export interface PointUpdate extends Extensible {
  type?: 'point';
  match_id?: number;
  point?: LivePoint;
  pbp_coverage?: 'point' | 'game';
  quality?: 'clean' | 'revised';
}

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
 * Draw filter accepted by `/matches`, `/history/matches`, `/tournaments` and
 * `/fixtures`. The FIELD (`Match.draw`) is three-valued (`Draw | null`) — a
 * null-draw row (the draw is unknown: team ties, team exhibitions) matches
 * NEITHER filter value, so `singles` plus `doubles` is not everything. An
 * unrecognised value is a 400 `bad_draw` with the allowed list in the body.
 */
export type Draw = 'singles' | 'doubles';

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
 * Ranking system vocabulary of `/rankings`. Systems are never collapsed into a
 * single "rank" — they are not comparable. ATP/WTA and the ITF circuits carry
 * rank+points; `utr` carries a rating with null rank and points, because UTR
 * is a rating, not a ranking (and has no listing mode); `elo` is our own
 * surface-aware Elo rating. `elo` is NEVER implied: omitting `system` returns
 * the published-ranking systems only, so Elo records appear exactly when you
 * name `system: 'elo'`. The Elo LISTING (the leaderboard mode) additionally
 * requires `tour` — Elo ratings are computed per tour and the two tables are
 * not one leaderboard.
 */
export type RankingSystem = 'atp' | 'wta' | 'itf_jt' | 'itf_mt' | 'itf_wt' | 'utr' | 'elo';

/**
 * One ranking record in force at the requested instant — the newest record
 * effective ON OR BEFORE `as_of`, never one dated after it. Every other
 * ranking field in this API is the player's CURRENT value joined at read
 * time; this endpoint is the point-in-time answer.
 */
export interface RankingRecord extends Extensible {
  /** Null on listing rows for players outside our roster — the table has no silent holes. */
  player_id?: number | null;
  /** The name as the ranking publisher printed it. Listing rows only; absent on per-player records. */
  player_name?: string | null;
  system?: RankingSystem;
  tour?: string | null;
  /** Null for UTR. */
  rank?: number | null;
  /** Null for UTR. */
  points?: number | null;
  /**
   * The rank at the immediately preceding snapshot week — ATP/WTA only; null
   * when no prior week is held, and always null for ITF/UTR.
   */
  previous_rank?: number | null;
  /** The circuit's own signed weekly movement — ITF systems only; null elsewhere. */
  rank_movement?: number | null;
  /** UTR only; null elsewhere. */
  rating?: number | null;
  /** The publication week this record took effect. */
  effective_date?: string | null;
  observed_at?: string | null;
}

/**
 * `meta` of a `/rankings` response. Read `coverage` before trusting an empty
 * result: ITF and UTR history begins 2026-07-29 and cannot be reconstructed
 * earlier, so a request before that date correctly returns nothing for those
 * systems.
 */
export interface RankingListMeta extends ListMeta {
  coverage?: {
    as_of?: string | null;
    players_requested?: number;
    players_resolved?: number;
    systems_requested?: string[];
    systems_resolved?: string[];
    /** Earliest effective date held, per requested system. */
    oldest_available?: Record<string, string | null>;
  };
}

/** A `/rankings` page — `Page<RankingRecord>` with the richer coverage meta. */
export interface RankingsPage {
  data: RankingRecord[];
  meta?: RankingListMeta;
}

/**
 * Where tape rows came from — reported once in `Tape.meta`, never per row, so
 * the row shape cannot carry data-source provenance. `observed` = every row
 * watched live; `reconstructed` = every row expanded after the fact;
 * `mixed` = a reconstructed opening followed by what we watched. Null on an
 * empty tape.
 */
export type PointSource = 'observed' | 'reconstructed' | 'mixed';

/**
 * One row of a match tape — the score after a committed state change.
 *
 * Rows we watched live carry a real `timestamp`. Rows expanded after the fact
 * from a finished-match point-by-point record carry a null `timestamp` AND
 * null model fields, because neither a wall clock nor a model output ever
 * existed for them — nothing is synthesised. A null `timestamp` is the
 * reliable row-level marker of a reconstructed row; the model fields alone
 * are not, since they are stamped best-effort and an observed row may lack
 * them.
 */
export interface TapeRow extends Extensible {
  sets?: number[];
  /** Player-major, like {@link Score.games}. */
  games?: number[][];
  points?: string[];
  server?: 1 | 2 | null;
  is_tiebreak?: boolean;
  win_probability_p1?: number | null;
  danger?: number | null;
  timestamp?: string | null;
  /**
   * Who won the point this row records — present ONLY on `sequence: 'clean'`
   * rows, and only where the transition from the previous row is a single
   * attributable point; null on gaps, torn rows and the first row. Never on
   * the raw sequence (raw is deliberately non-monotonic: consecutive raw rows
   * are corrections, not points). Derived at read time, never guessed.
   */
  point_winner?: 1 | 2 | null;
}

/** A tiebreak final score, `{p1, p2}`. */
export interface TiebreakScore extends Extensible {
  p1?: number;
  p2?: number;
}

/**
 * The per-match tape: match header + chronological score sequence + model
 * profiles + coverage meta. **BASIC** (or any History plan). Works on a LIVE
 * match too — the tape is assembled from whatever has been committed so far.
 *
 * The tape is NOT guaranteed to cover the whole match: check `meta.coverage`
 * and `meta.point_source` before backtesting.
 */
export interface Tape extends Extensible {
  match?: Match;
  tape?: TapeRow[];
  /**
   * Per-set tiebreak final scores from OBSERVED states only, aligned to the
   * sets of the final scoreline: an entry for a 7-6 set whose observed
   * maximum tiebreak state is a valid terminal shape (max ≥ 7, margin ≥ 2),
   * null per set otherwise — a breaker whose closing point the feed skipped
   * reads null rather than an under-report. Null when the match has no 7-6
   * set.
   */
  tiebreaks?: (TiebreakScore | null)[] | null;
  /** Model profiles, oldest first (the `Analysis` `profile` shape). */
  profiles?: unknown[];
  meta?: {
    match_id?: number;
    /** Rows RETURNED — after any `sequence: 'clean'` collapse. */
    rows?: number;
    coverage?: Coverage;
    point_source?: PointSource | null;
    /** Rows BEFORE any collapse — equals `rows` when `sequence` is `raw`. */
    raw_rows?: number;
    /** Distinct score states in the raw tape. `raw_rows` minus this is pure repetition. */
    unique_states?: number;
    sequence?: 'raw' | 'clean';
    /** Served from the immutable archive rather than the live table. Informational. */
    from_archive?: boolean;
    generated_at?: string;
  } & Extensible;
}

/**
 * Coverage state of a statistics family: `final` is the closing figures of a
 * completed match; `none` returns 200 with null `players`, not a 404 — the
 * match exists and holding nothing for it is the honest answer; on
 * `diverged` the measured VALUES are withheld.
 */
export type StatisticsCoverage = 'live' | 'final' | 'stale' | 'none' | 'diverged';

/**
 * Measured counting statistics for one player. These are COUNTED upstream,
 * not derived from the point record — which is why they can include aces and
 * double faults, and the derived fields cannot.
 *
 * EVERY field is optional and an absent field is OMITTED, never zero-filled —
 * read the keys you are given. Aces and double faults are present across
 * every tour; the serve split and break points saved are present on the main
 * tours and absent on ITF singles; winners and unforced errors appear on a
 * minority of main-tour matches. A `_of` suffix is the denominator of its
 * base field and a `_pct` suffix is the percentage recomputed from the two
 * counts.
 */
export interface MatchStatisticsMeasured extends Extensible {
  aces?: number | null;
  double_faults?: number | null;
  points_won?: number | null;
  service_points_won?: number | null;
  return_points_won?: number | null;
  break_points_won?: number | null;
  service_games_won?: number | null;
  games_won?: number | null;
  max_points_in_row?: number | null;
  max_games_in_row?: number | null;
  first_serves_in?: number | null;
  first_serves_in_of?: number | null;
  first_serves_in_pct?: number | null;
  second_serves_in?: number | null;
  second_serves_in_of?: number | null;
  second_serves_in_pct?: number | null;
  first_serve_points_won?: number | null;
  first_serve_points_won_of?: number | null;
  first_serve_points_won_pct?: number | null;
  second_serve_points_won?: number | null;
  second_serve_points_won_of?: number | null;
  second_serve_points_won_pct?: number | null;
  first_return_points_won?: number | null;
  first_return_points_won_of?: number | null;
  first_return_points_won_pct?: number | null;
  second_return_points_won?: number | null;
  second_return_points_won_of?: number | null;
  second_return_points_won_pct?: number | null;
  break_points_saved?: number | null;
  break_points_saved_of?: number | null;
  break_points_saved_pct?: number | null;
  service_games_played?: number | null;
  tiebreaks_won?: number | null;
  winners_total?: number | null;
  forehand_winners?: number | null;
  backhand_winners?: number | null;
  groundstroke_winners?: number | null;
  volley_winners?: number | null;
  overhead_winners?: number | null;
  drop_shot_winners?: number | null;
  lob_winners?: number | null;
  return_winners?: number | null;
  errors_total?: number | null;
  unforced_errors_total?: number | null;
  forehand_errors?: number | null;
  forehand_unforced_errors?: number | null;
  backhand_errors?: number | null;
  backhand_unforced_errors?: number | null;
  groundstroke_errors?: number | null;
  groundstroke_unforced_errors?: number | null;
  volley_unforced_errors?: number | null;
  overhead_errors?: number | null;
  drop_shot_unforced_errors?: number | null;
  lob_unforced_errors?: number | null;
  return_errors?: number | null;
}

/**
 * One player's in-play statistics, in TWO families that are deliberately not
 * merged. The fields at this level are DERIVED from the point-by-point
 * record; `measured` holds counts taken upstream. Both families name some of
 * the same quantities, computed two entirely different ways — that is a
 * cross-check, not a duplication to collapse.
 */
export interface MatchStatisticsSide extends Extensible {
  measured?: MatchStatisticsMeasured;
  service_games_played?: number;
  service_games_won?: number;
  /** Null when no service game was played — never 0, so a present 0 is a real zero. */
  hold_pct?: number | null;
  return_games_played?: number;
  return_games_won?: number;
  break_pct?: number | null;
  break_points_faced?: number;
  break_points_saved?: number;
  break_points_saved_pct?: number | null;
  break_points_played?: number;
  break_points_converted?: number;
  break_points_converted_pct?: number | null;
  service_points_played?: number;
  service_points_won?: number;
  service_points_won_pct?: number | null;
  return_points_played?: number;
  return_points_won?: number;
  return_points_won_pct?: number | null;
  points_played?: number;
  points_won?: number;
}

/** Per-family coverage and age for `/matches/{id}/statistics`. */
export interface MatchStatisticsFamily extends Extensible {
  coverage?: StatisticsCoverage;
  as_of?: string | null;
  /**
   * The derived age is measured against the newest SCORE row; the measured
   * age is wall clock. THE TWO CLOCKS MUST NOT BE COMPARED.
   */
  age_seconds?: number | null;
  /** The match state these statistics describe, per upstream. Null when unavailable. */
  describes?: {
    games_p1?: number[];
    games_p2?: number[];
    total_games?: number;
  } | null;
}

/**
 * In-play statistics for one match. **ULTRA.**
 *
 * Branch on `freshness.derived` / `freshness.measured` rather than the
 * top-level `coverage`, which only summarises the response. On `diverged`
 * the measured values are withheld and `freshness.measured_divergence` says
 * why. Tiebreak games are excluded from the DERIVED family and counted in
 * `tiebreak_games_excluded` — the live record collapses a whole tiebreak
 * onto one entry.
 */
export interface MatchStatistics extends Extensible {
  match_id?: number;
  coverage?: StatisticsCoverage;
  as_of?: string | null;
  /** Behind the newest SCORE row, not the wall clock. */
  age_seconds?: number | null;
  games_counted?: number;
  tiebreak_games_excluded?: number;
  /** Games whose recorded outcome is neither a legal hold nor a legal break. */
  inconsistent_games_excluded?: number;
  sets_covered?: number[];
  freshness?: {
    /** Null when the families agree; otherwise why the measured values were withheld. */
    measured_divergence?: {
      reason?: string;
      games_in_statistics?: number;
      games_in_score?: number;
      /** Positive = statistics ahead of the score, which staleness cannot cause. */
      delta_games?: number;
      detail?: string;
    } | null;
    derived?: MatchStatisticsFamily;
    measured?: MatchStatisticsFamily;
  };
  /** Present only when coverage is `none`. */
  detail?: string;
  players?: { p1?: MatchStatisticsSide; p2?: MatchStatisticsSide } | null;
}

/** One stroke of a charted rally. Shots are numbered from the serve: serve 1, return 2. */
export interface RallyShot extends Extensible {
  number?: number;
  /** The charter's raw code, e.g. `'f'`. */
  code?: string;
  stroke?:
    | 'serve' | 'groundstroke' | 'slice' | 'volley' | 'half_volley'
    | 'swinging_volley' | 'overhead' | 'drop_shot' | 'lob' | 'trick'
    | 'unknown' | null;
  /** The side it was struck FROM. */
  wing?: 'forehand' | 'backhand' | null;
  /** Where the ball was sent. */
  direction?: 'forehand_side' | 'middle' | 'backhand_side' | null;
  depth?: 'shallow' | 'mid' | 'deep' | null;
  position?: 'approaching' | 'at_net' | 'baseline' | null;
}

/**
 * One charted point. `raw` is the charter's own string, verbatim, and is
 * ALWAYS present; the parsed fields are our reading of it. `parsed` is false
 * when the notation contained something we could not read cleanly — the
 * recognised part is still returned. A consumer who wants only unambiguous
 * rows filters on `parsed`.
 */
export interface RallyPoint extends Extensible {
  point?: number;
  set?: (number | null)[];
  games?: (number | null)[];
  /** e.g. `'30-40'`. */
  score?: string | null;
  game?: number | null;
  is_tiebreak?: boolean;
  server?: 1 | 2 | null;
  point_winner?: 1 | 2 | null;
  /** The charter's shot string; both serves joined by `';'` when the first was a fault. */
  raw?: string | null;
  parsed?: boolean;
  serve_number?: 1 | 2 | null;
  serve_direction?: 'wide' | 'body' | 'down_the_t' | null;
  /** Strokes including the serve. An ace is 1, a double fault 0. */
  rally_length?: number | null;
  /** `error` = the charter recorded a miss without saying whether it was forced. Never guessed. */
  outcome?: 'winner' | 'forced_error' | 'unforced_error' | 'error' | 'other' | null;
  error_location?: 'net' | 'wide' | 'wide_and_deep' | 'deep' | null;
  ending_stroke?: string | null;
  ending_wing?: string | null;
  is_ace?: boolean;
  is_double_fault?: boolean;
  is_serve_and_volley?: boolean;
  shots?: RallyShot[];
}

/**
 * A charted match — shot-by-shot data from the Match Charting Project.
 * **ULTRA.** Rally construction is the layer BELOW the tape: the tape says
 * what the score became after each point, this says how the point was played.
 *
 * It has its OWN id space (`rally_match_id`): the charted corpus reaches back
 * decades and concentrates on the biggest events, so most charted matches
 * have no counterpart in our own match table (`match_id` is null there).
 */
export interface RallyMatch extends Extensible {
  /** The id this product is keyed on. */
  rally_match_id?: number;
  source_id?: string;
  /** OUR match id, when the charted match is also one we hold. Null otherwise. */
  match_id?: number | null;
  date?: string | null;
  tournament?: string | null;
  round?: string | null;
  surface?: string | null;
  gender?: 'M' | 'W' | null;
  best_of?: number | null;
  players?: { name?: string | null; hand?: 'R' | 'L' | 'U' | 'A' | null }[];
  /** Charted points in this match. */
  points?: number;
  /** How many of them our parser read cleanly — the per-match quality number. */
  points_parsed?: number;
}

/**
 * One charted match with its points in play order. Paged with
 * `limit`/`offset`; `meta.total` is the match's full point count.
 */
export interface RallyMatchDetail extends RallyMatch {
  rally?: RallyPoint[];
  meta?: ListMeta;
}

/**
 * Career shot-level charting aggregate for one player, summed over their
 * charted matches. **ULTRA.** Every field is a raw SUM over the player's
 * Total rows; `matches_charted` states the sample. Coverage is CURATED —
 * 11,646 charted matches across both tours back to the 1960s, concentrated
 * on the majors, NOT full-slate coverage.
 */
export interface ChartingPlayer extends Extensible {
  player?: { name?: string } & Extensible;
  matches_charted?: number;
  coverage?: string;
  /** Per-family summed numeric columns. */
  families?: Record<string, Record<string, number | null>>;
}

/**
 * Every Match Charting Project stat family for one charted match, both
 * players, with the per-set split (row/set 1, 2, Total) exactly as charted.
 * **ULTRA.** `charting_match_id` is this product's own id space.
 */
export interface ChartingMatch extends Extensible {
  charting_match_id?: number;
  mcp_id?: string;
  gender?: string;
  players?: Record<string, unknown>;
  families?: Record<string, unknown>;
}

/**
 * Package family of `/history/packages`. `tape` (the default) = point-by-point
 * match tapes (PRO+ or a package subscription); `rally` = the charted rally
 * corpus, keyed by YEAR not month (ULTRA); `rankings` = as-of ranking records
 * (ULTRA); `archive` = the 1968-2022 results archive, keyed by YEAR, same
 * entitlement as the tape packages (not ULTRA).
 */
export type PackageKind = 'tape' | 'rally' | 'rankings' | 'archive';

/** One downloadable file of a bulk package. */
export interface PackageFile extends Extensible {
  format?: 'jsonl' | 'csv';
  filename?: string;
  bytes?: number;
  sha256?: string;
}

/**
 * A published bulk package. Coverage is not a contiguous run of months and is
 * still being extended backwards — treat the packages listing as the
 * authoritative set of periods that exist. The JSONL file holds ONE LINE PER
 * MATCH (a whole {@link Tape} object per line, coverage meta included); the
 * CSV is flattened to one row per point and carries no coverage columns.
 */
export interface HistoryPackage extends Extensible {
  /** `YYYY-MM` for tape/rankings packages. */
  period?: string;
  /** Only built packages are listed or served. */
  status?: 'ready';
  /** On a rankings package this is the number of players covered. */
  match_count?: number | null;
  /** On a rankings package this is the number of ranking records. */
  row_count?: number | null;
  files?: PackageFile[];
  built_at?: string | null;
  /** Present only on non-tape packages, so the shape a tape client already parses is unchanged. */
  kind?: PackageKind;
}

/**
 * One bucket of the `/history/coverage` table — the completed archive sliced
 * by `tour_draw` (`atp_singles`, `itf_doubles`, …).
 *
 * The two completeness counts differ ON PURPOSE: `point_complete` says a
 * complete point-by-point tape is AVAILABLE for that many matches;
 * `complete_on_default_read` (at most `point_complete`) says how many of them
 * a default read serves complete.
 */
export interface CoverageBucket extends Extensible {
  /** Completed matches in this bucket. */
  completed?: number;
  /** How many carry any tape at all. */
  any_tape?: number;
  /** How many have a COMPLETE point-by-point tape available. */
  point_complete?: number;
  /** How many a default read serves complete — at most `point_complete`. */
  complete_on_default_read?: number;
  /** `point_complete / completed` — null on an empty bucket (`completed` 0). */
  share?: number | null;
}

/**
 * The measured point-completeness table for the whole completed archive —
 * one object, from `getHistoryCoverage()`. **BASIC** (or any History plan).
 *
 * The numbers are a BUILT ARTIFACT, not a live count: `as_of` stamps the
 * build (ISO-8601) and `method` says how they were measured. While the
 * artifact is not built the endpoint answers 503 `coverage_unavailable` —
 * surfaced as `ServiceUnavailable` with the code on `err.errorCode`, never
 * as an empty object.
 */
export interface CoveragePage extends Extensible {
  as_of?: string | null;
  method?: string | null;
  /** Keyed by `tour_draw` strings (`atp_singles`, `itf_doubles`, …). */
  buckets?: Record<string, CoverageBucket>;
  /** The same counts summed over every bucket. */
  totals?: CoverageBucket;
}

/**
 * A minted connection token for the high-fan-out push feed (Centrifugo).
 * **ULTRA.**
 *
 * You normally never touch this directly: `PushStream` (built into this
 * package — no extra dependency) mints, connects, subscribes and re-mints for
 * you. Reach for the raw token only to connect a Centrifugo-protocol client
 * of your own: connect to `ws_url` with `token`, then subscribe to a channel
 * from `channels` — `match:{match_id}` for one match's score frames,
 * `slate:all` for every live score frame. Frames are the same score objects
 * the polling endpoints return — including `win_probability_p1` and `danger`.
 * The token is short-lived: mint a fresh one on every reconnect, never reuse
 * one across connections.
 */
export interface WsToken extends Extensible {
  token?: string;
  /** Seconds until the token expires. */
  expires_in?: number;
  /** `wss://api.livetennisapi.com/connection/websocket` */
  ws_url?: string;
  /**
   * Channel vocabulary, e.g. `{ match: 'match:{id}', slate: 'slate:all' }`.
   * `points`-entitled keys may additionally be granted the point-feed
   * channels (`point_match` / `point_slate`) when the server has the point
   * feed enabled, and every key the signal channels (`signal_match` /
   * `signal_slate`) when the server has the signal feed enabled. A channel
   * name in this response is a promise that subscribing to it is useful — an
   * absent family is the server's honest refusal, which is why `PushStream`
   * (`points: true` / `signals: true`) resolves the names from here and
   * never guesses them.
   */
  channels?: {
    match?: string;
    slate?: string;
    point_match?: string;
    point_slate?: string;
    signal_match?: string;
    signal_slate?: string;
  } & Extensible;
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
