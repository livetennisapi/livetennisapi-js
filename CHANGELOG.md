# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.4.0] — 2026-08-07

### Added
- **The per-match tape.** `getMatchTape(matchId, { sequence })` (BASIC, or any
  History plan) — the point-by-point score sequence with per-point model
  probabilities, working on LIVE matches too. `sequence: 'clean'` collapses
  corrections to one row per distinct score state and is the only sequence
  carrying the new `point_winner` field; the response's `tiebreaks` array
  holds per-set tiebreak final scores from observed states only. Check
  `meta.coverage` / `meta.point_source` before backtesting.
- **In-play statistics.** `getMatchStatistics(matchId)` (ULTRA) — aces, double
  faults, the serve split, hold/break %, break points, service and return
  points, in two deliberately unmerged families: DERIVED (rebuilt from the
  tape) and MEASURED (counted upstream), each with its own freshness and
  coverage. Absent measured fields are omitted, never zero-filled.
- **Point-in-time rankings.** `listRankings()` (both modes of `/rankings`):
  the rank-ordered listing of one system (PRO) and per-player as-of records
  (ULTRA) — the newest record effective on or before `as_of`, never one dated
  after it. Rows carry `previous_rank` (ATP/WTA). A 403 names the tier by
  MODE, which the path alone cannot say.
- **Shot-by-shot rally construction and charting** (ULTRA, Match Charting
  Project corpus, its own id space): `listRallyMatches()`, `getRallyMatch()`,
  `getMatchRally()` (by OUR match id — 404 `not_charted` is distinct from "no
  such match"), `getChartingPlayer(name)` career aggregates and
  `getChartingMatch(id)` per-match stat families.
- **Bulk packages.** `listHistoryPackages({ kind, year })` and
  `getHistoryPackage(period, { kind })` (PRO+, or a package subscription) —
  pre-built month packages of tape as JSONL/CSV with sha256 manifests.
  `kind: 'rally' | 'rankings'` and the `year` archive listing need ULTRA.
- **Push feed.** `getWsToken()` (ULTRA) mints a short-lived token for the
  Centrifugo high-fan-out push endpoint — connect any Centrifugo-protocol
  client to `ws_url` and subscribe to `match:{id}` or `slate:all`. A second
  transport next to `LiveScoreStream`, built for fan-out.
- **429s you can act on.** A daily 429 now surfaces `resetsAt` — the absolute
  ISO instant the allowance returns (derived from the service's local
  midnight; it is NOT midnight UTC). The `abuse_throttled` 429 (a ~24h block
  for chronic over-cap use) gets its own `AbuseThrottled` class carrying
  `retryAtEpoch`; it extends `RateLimited`, so existing catches keep working.
- New exported types: `Tape`, `TapeRow`, `TiebreakScore`, `PointSource`,
  `MatchStatistics` (+`Side`/`Measured`/`Family`, `StatisticsCoverage`),
  `RankingRecord`, `RankingSystem`, `RankingListMeta`, `RankingsPage`,
  `RallyMatch`, `RallyMatchDetail`, `RallyPoint`, `RallyShot`,
  `ChartingPlayer`, `ChartingMatch`, `HistoryPackage`, `PackageFile`,
  `PackageKind`, `WsToken`.

### Changed
- **The client no longer retries a 429 that retrying cannot fix.** A daily
  429 (`scope: "day"`) does not lift until the reset instant, and
  `abuse_throttled` is the block that counting retries earned — both now
  throw immediately instead of burning up to `maxRetries` backoffs.
  Per-minute 429s and 5xx retry exactly as before.
- WebSocket docs state that `score` frames carry `win_probability_p1` and
  `danger` like the REST reads (the feed is ULTRA); a `null` means the model
  had no output for that state.
- README: quota table for the current grid (FREE 100/day, BASIC 1,000, PRO
  10,000, ULTRA 500,000 — the 2026-08-06 quotas), free-key polling guidance
  (≥15 min; always-on dashboards belong on BASIC), tier table rows for the
  whole new surface, and the five-tour phrasing — ATP, WTA, Challenger, ITF
  and juniors.

### Notes
- **Fully backwards compatible** for every non-error path: additions are new
  methods, new optional parameters, and new optional fields on `Extensible`
  types. The only behavioural change is the non-retry of daily/abuse 429s
  described above.

## [1.3.0] — 2026-08-03

### Added
- **The results archive (1968–2022).** Five new methods over the licensed
  historical results corpus — ATP and WTA, main draws, qualifying and the
  ITF/futures tiers, ending 2022-12-31 exactly where the point-by-point tape
  (2023→now) begins:
  - `listArchiveMatches()` / `getArchiveMatch()` — winner/loser-shaped results
    with final score, seeds, ranks at the time, and (on the detail read)
    per-match serve statistics where the era recorded them. `event_date` is
    the tournament START date.
  - `listArchivePlayers()` — archive bios: hand, DOB, country, height,
    career-high rank and the earliest week it was reached.
  - `getArchiveCareer(name)` — career aggregates: W-L by surface/level/year,
    titles, summed serve stats with honest coverage
    (`serve.matches_with_stats`).
  - `getH2H(p1, p2)` — cross-era head-to-head over the archive PLUS our own
    completed matches, name-keyed; `meetings[].winner` is 1|2 of the request.
    Ambiguous name fragments are refused with a `400 ambiguous_name` carrying
    the candidate list in `err.body.candidates` (also true of
    `getArchiveCareer`); all four BASIC-gated reads name `BASIC` on a 403.
- **Tournament catalogue.** `listTournaments()` / `getTournament(id)` (FREE) —
  the stable id space `Match.tournament_id` joins, with `surface`, `indoor`,
  curated `city`/`country`, and `category` (set only where the catalogues
  agree unambiguously, never derived from the name).
- **New list filters.** `listMatches()` takes `player` (repeatable, max 50),
  `from` / `to` (play-date bounds) and `country` (IOC-style lowercase
  3-letter codes, as `player.country` returns them — not ISO-3166);
  `listCompletedMatches()` takes those plus `tour` and `coverage`. Repeatable
  parameters go out as `?player=1&player=2` — the API does not read
  comma-joined lists.
- **New match fields, typed.** `Match` gains `tour` (the same vocabulary the
  filter accepts), `tournament_id`, `round_code` (normalized round — the
  field to branch on), and `withdrew`; `event_status` is now documented on the
  type. `Fixture` gains `start_time`, `player1_id` / `player2_id` and
  `round_code`. `ListMeta` gains `total` and `has_more`.
- New exported types: `Tournament`, `TournamentCategory`, `ArchiveMatch`,
  `ArchiveParticipant`, `ArchivePlayerBio`, `ArchiveTour`, `ArchiveCareer`,
  `HeadToHead`, `HeadToHeadMeeting`, `RoundCode`, `Coverage`.

### Notes
- **Fully backwards compatible.** Every addition is a new method, a new
  optional parameter, or a new optional field on an `Extensible` type.

## [1.2.0] — 2026-07-24

### Added
- **Break-point signals over the WebSocket feed.** `LiveScoreStream` accepts a
  new `signals` option; pass `signals: ['break_point']` and the stream also
  yields a `BreakPoint` the instant a break point arises and a
  `BreakPointResult` when it resolves, alongside the usual `ScoreUpdate`.
  Previously the subscribe frame carried no `signals` key and `listen()`
  swallowed every non-`score` frame, so the headline break-point feed was
  unreachable from this client. Narrow on `frame.type` to tell frames apart.
- `BreakPoint`, `BreakPointResult` and the `StreamFrame` union are exported.

### Fixed
- **`src/version.ts` had drifted to `1.0.2` while `package.json` was `1.1.0`.**
  The CI check that asserts they match would have failed on the next release;
  both are now `1.2.0`.

### Notes
- **Fully backwards compatible.** With no `signals` (the default) the subscribe
  frame and everything the stream yields are identical to 1.1.0 — score frames
  only.
- The break-point feed is **ULTRA-only**, like the rest of the WebSocket surface.

## [1.1.0] — 2026-07-22

### Added
- **`tour` filter on `listMatches()` and `listFixtures()`**, with a `Tour` union
  (`atp` | `wta` | `challenger` | `itf` | `juniors`). The API has accepted this
  since the public surface shipped, but it reached neither the OpenAPI document
  nor any client, so it could only be used by casting around the types. Each
  value covers its singles and doubles draws; an unknown value is a `400`.

### Fixed
- **`listMatches()` sent no status when given an explicit `undefined`.** The
  `'live'` default was applied before the spread, so `{ status: maybeUndefined }`
  — the natural shape when forwarding an optional — overwrote it. Now applied
  after, with a regression test.
- **CommonJS consumers could not resolve types.** The `exports` map pointed
  `types` at the ESM declarations under both conditions while shipping an
  unreferenced `dist/index.d.cts`, so `moduleResolution: Node16` failed with
  TS1479. Each condition now resolves its own declarations.

### Changed
- Package description states that market prices and model win-probability are
  PRO/ULTRA features. The free tier serves scores, players and fixtures, so the
  previous wording described the product line rather than what a new install
  gets.

## [1.0.2] — 2026-07-21

### Fixed
- **A 403 on `listCompletedMatches()` could not be attributed to a tier.**
  `/history/matches` used to be the entitlement floor, so nothing needed to name
  a tier for it. With the new FREE tier below it, a free key calling that method
  got an `UpgradeRequired` with no `requiredTier`, leaving the caller with the
  API's bare `upgrade_required` and no idea which plan to buy. `/history` now
  maps to `BASIC`.

### Added
- `'FREE'` in the `Tier` union.

## [1.0.1] — 2026-07-19

### Fixed
- **WebSocket backoff never grew against a flapping server.** The retry counter
  reset on a successful *subscribe*, so a server that accepted then immediately
  dropped the socket pinned the delay at step one forever and
  `maxReconnectAttempts` was never reached. It now resets only after a
  connection has stayed up for 60s.
- **`--limit` / `--match` with no value sent `NaN`.** `Number(undefined)` is
  `NaN`, which `?? 50` does not catch, so the request went out as `limit=NaN`
  and the API rejected it. Numeric flags are now validated, as is `--status`.
- **The CLI crashed with a raw stack trace on a non-JSON response body.** A body
  that fails to decode yields `undefined`, which was then dereferenced past the
  error handler. Guarded in the CLI and in the MCP server.
- Error messages used `??`, so `{"error": null}` surfaced as the literal string
  `"null"` and an empty HTTP/2 `statusText` produced an empty message. Now uses
  truthiness, matching the Python client.
- Retried responses were never drained, holding the connection open under undici
  until GC.

### Added
- `LIVETENNISAPI_BASE_URL` is now honoured, matching the Python client.
- A `User-Agent` is sent outside the browser, so the client is attributable in
  API logs (browsers forbid setting it).
- `Format` row in `livetennis match`, matching the Python CLI.

### Removed
- The `lint` script, which referenced an eslint that was never a dependency.

## [1.0.0] — 2026-07-19

First release.

### Added
- `LiveTennisAPI` covering all 12 REST endpoints, fully typed.
- `LiveScoreStream` — reconnecting WebSocket live-score feed (ULTRA).
- `livetennis` / `livetennisapi` CLI, runnable via `npx` with no install.
- Typed error hierarchy. `UpgradeRequired` carries `.requiredTier`;
  `RateLimited` carries `.retryAfter`.
- Retries on 429 and 5xx only, honouring `Retry-After` with exponential backoff
  and jitter. Other 4xx are never retried.
- `paginate()` async generator for list endpoints.
- Dual ESM + CJS builds with type declarations for both.

### Notes
- **Zero runtime dependencies.** Platform `fetch` and `WebSocket`; `ws` is an
  optional peer only for Node 18–20.
- **Types never forbid unknown fields.** The API ships additive changes within
  `v1`, so every response type carries an index signature.
- `Score.games` is **player-major** (`[games_p1, games_p2]`, each a per-set
  list). Use `gamesForSet()`.
