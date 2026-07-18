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
 * `winProbabilityP1` and `danger` are present only on the ULTRA tier.
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

/** A scheduled fixture. Players are names only — not yet resolved to ids. */
export interface Fixture extends Extensible {
  id?: number;
  event_date?: string | null;
  tour?: string | null;
  tournament?: string | null;
  round?: string | null;
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
  surface?: 'hard' | 'clay' | 'grass' | null;
  indoor?: boolean;
  format?: 'BO3' | 'BO5' | null;
  round?: string | null;
  status?: 'upcoming' | 'live' | 'completed' | 'cancelled';
  event_status?: string | null;
  is_doubles?: boolean;
  scheduled_time?: string | null;
  players?: { p1?: Player; p2?: Player };
  score?: Score | null;
  winner?: 1 | 2 | null;
  market?: Market | null;
  analysis?: Analysis | null;
}

/** A `score` frame from the WebSocket feed. */
export interface ScoreUpdate extends Score {
  type?: 'score';
  match_id?: number;
}

export type MatchStatus = 'live' | 'upcoming' | 'completed';

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
