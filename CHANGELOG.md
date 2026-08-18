# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.8.0] — 2026-08-18

### Added
- **`signals: true` on `PushStream` — the signal events, on the push feed.**
  The push feed's signal channels (`signal:match:{id}` per requested match,
  or `signal:slate`) carry the same derived events the native
  `LiveScoreStream` delivers through its `signals` option: `break_point`
  (`BreakPoint`) the moment a break point arises, `break_point_result`
  (`BreakPointResult`) when it resolves, and — where the server's divergence
  flag is on — `divergence` (the new `Divergence` type: model vs match-winner
  market disagreeing beyond the server's threshold, `direction` naming the
  side the model rates above the market). Channel names are resolved from the
  `/ws-token` mint's **own advertised vocabulary** (`signal_match` /
  `signal_slate`), exactly like `points: true` — an unadvertised vocabulary
  is the server's honest refusal (the signal feed is off) and throws
  `ServiceUnavailable` instead of subscribing a guessed name into a silent
  empty feed. Signals are events with no replay and no `seq`: a subscriber
  that joins mid-break-point does not receive the onset, and there is no
  resume machinery for them (nothing like `pointsResume`) — unlike points, a
  missed signal is not recoverable over REST. Frames arrive through the same
  iterator, dispatched by `frame.type` as always.
- **`Divergence`** — the new exported frame type; `WsToken.channels` gains
  the optional `signal_match` / `signal_slate` vocabulary fields.

### Changed
- **README: `PushStream` is now the first streaming example.** The push feed
  is the recommended transport for continuous / production streaming; the
  native `/ws` feed is documented second, with its shared-capacity ceiling
  stated. Documentation only — no behavioural change to either streamer.

### Notes
- **Fully backwards compatible.** `signals` defaults to `false`; with it
  omitted `PushStream` subscribes exactly the channels it did before. Every
  addition is a new optional option, a new optional field, or a new exported
  type.

## [1.7.0] — 2026-08-18

### Added
- **`draw` — singles vs doubles, three-valued and filterable.** `Match` gains
  `draw?: 'singles' | 'doubles' | null` (the new `Draw` type) — and the null
  is an answer, not a gap. Team ties and team exhibitions never state which
  discipline a rubber was, so those matches carry a null draw rather than a
  guess; the existing `is_doubles` stays untouched but is lossy (it cannot
  say "unknown"), so branch on `draw`. The same word filters:
  `listMatches()`, `listCompletedMatches()`, `listTournaments()` and
  `listFixtures()` take `draw: 'singles' | 'doubles'`, passed through to the
  server as given (the server owns validation — an invalid value is a 400
  `bad_draw` with the allowed list in the body). A null-draw row matches
  NEITHER filter value, so `singles` plus `doubles` is not everything.
- **`getHistoryCoverage()` — the measured point-completeness table.** BASIC,
  or any History plan. One object for the whole completed archive, typed as
  `CoveragePage`: per-`tour_draw` bucket (`atp_singles`, `itf_doubles`, … —
  each a `CoverageBucket`) how many completed matches we hold (`completed`),
  how many carry any tape (`any_tape`), how many have a complete
  point-by-point tape AVAILABLE (`point_complete`), how many a default read
  serves complete (`complete_on_default_read`), and the `share` — plus
  `totals` across every bucket. The two completeness counts differ on
  purpose: a complete tape can exist for a match a default read does not
  serve complete. The numbers are a built artifact (`as_of` stamps the
  build, `method` how they were measured); while it is not built the
  endpoint answers 503 `coverage_unavailable`, surfaced as
  `ServiceUnavailable` with the code on `err.errorCode` — never an empty
  object.
- The per-row `tape` block on `/history/matches` rows also carries
  `starts_at_love` and `computed_at` on servers that measure them — readable
  today through the types' index signature. An absent field there means an
  older server or "not measured", never "no".

### Notes
- **Fully backwards compatible.** Every addition is a new method, a new
  optional parameter, a new optional field, or a new exported type.

## [1.6.0] — 2026-08-17

### Added
- **The live point feed, end to end.** One record per committed point, keyed
  by `seq` — per-match, monotonic and **gapless** (`1..N`), so it is the
  dedup key and the resume cursor in one field. ULTRA, **and server-gated on
  top of it**: points are served only where the server's point gate is on and
  the plan includes points (see *Notes* below — this SDK treats the gate's
  refusal as an answer, not a retry case).
  - **REST:** `getMatchPoints(matchId, { after_seq })` returns one
    `PointsPage` (at most 500 points, oldest first) with the server's own
    resume cursor (`last_seq` / `has_more`), and
    `iterateMatchPoints(matchId, afterSeq)` walks that cursor across pages —
    stopping, rather than spinning, if the cursor ever fails to advance. On a
    live match the walk ends at "everything committed so far", not "the match
    is over"; resume later from the last `seq` you saw.
  - **Types:** `LivePoint` (the committed point: `seq`, set/game/number,
    `tiebreak`, `server`, `winner`, the point score after the point, the
    running match score in the same player-major layout as `Score`, and `ts`
    — the CAPTURE time, not when the point was played), `PointsPage`
    (`pbp_coverage: 'point' | 'game'` — read it before treating rows as
    points, `'game'` rows are game-grain commits; `quality:
    'clean' | 'revised'`; `covers_from_start`, which may be ABSENT on older
    servers and then means "not stated", never "no"), and `PointUpdate` — the
    `point` frame both live transports deliver, payload nested under `.point`
    exactly as score frames nest theirs under `.score`.
  - **Native feed:** `signals: ['points']` on `LiveScoreStream` now yields
    the `point` frames as `PointUpdate` alongside score (and break-point)
    frames — narrow on `frame.type`. With no `signals` the stream behaves
    exactly as before.
  - **Push feed:** `points: true` on `PushStream` subscribes the point
    channels resolved from the `/ws-token` mint's **own advertised
    vocabulary** (`point_match` / `point_slate`) — never a guessed channel
    name — and brings what an event feed needs that complete-state score
    frames do not: `pointsResume` (default on with `points`) keeps a
    per-match last-`seq` cursor that survives reconnects, catches up over
    REST on every (re)connect and yields the replayed points BEFORE any live
    frame, drops duplicates (`seq` at or below the cursor), and repairs a
    mid-stream gap (`seq` jumping past `cursor + 1`) over REST before
    yielding the frame that revealed it. `onGap(matchId, expectedSeq,
    gotSeq)` observes that repair. Slate caveat, documented on the option:
    cursors are per match, so a match that went live entirely inside an
    outage catches up only when its first live frame arrives (a back-fill
    from `seq` 1, not a reported gap). `pointsResume: false` takes the raw
    frames with no REST traffic.
- **`system: 'elo'` on `listRankings()`** — our own surface-aware Elo rating
  joins the ranking-system vocabulary, with the listing filters to shape its
  leaderboard: `tour` (**required** by the Elo listing — ratings are computed
  per tour, and the ATP and WTA tables are not one leaderboard), `surface`
  (the surface-specific rating), `archive_player` (widen the board to
  archive-era players), and `min_matches` / `activity_weeks` (who qualifies).
  Elo is deliberately **never implied**: omitting `system` returns the
  published-ranking systems only, so Elo records appear exactly when you name
  them.

### Notes
- **The point feed is server-gated, and this SDK says so instead of papering
  over it.** A plan (or a server) without the point feed answers the REST
  endpoint with `400 points_disabled` — surfaced as `BadRequest` with the
  code readable on `err.errorCode` — and the `/ws-token` mint simply does not
  advertise the point channels, which `PushStream` surfaces as
  `ServiceUnavailable` naming the cause rather than subscribing a guessed
  channel and delivering a silent empty feed. Neither refusal is retried:
  they are the server's honest answer, not a transient fault. Whether any
  given match carries point-grain rows is a data question the response itself
  answers (`pbp_coverage`, `covers_from_start`) — this client adds no claims
  of its own on top.

## [1.5.0] — 2026-08-16

### Added
- **`PushStream` — a built-in client for the high-fan-out push feed.** The
  second streaming transport (Centrifugo-backed, ULTRA) no longer needs
  `centrifuge-js`: the tiny protocol subset is implemented directly over the
  same WebSocket resolution the native streamer uses, keeping the package at
  zero runtime dependencies. Same ergonomics as `LiveScoreStream` — an async
  iterator of frames, `matches: [id, …]` for specific matches or the whole
  live slate by default, `close()`, auto-reconnect with exponential backoff —
  plus what the push protocol demands: a FRESH token minted via `getWsToken()`
  before every connection (never reused across reconnects), the server's
  empty-object ping answered promptly, newline-batched messages split before
  parsing, subscribe error replies raised, and publications dispatched by
  their `type` so a new frame kind published on a subscribed channel arrives
  without a client update (new channel *families* — the point feed's
  `point:*` channels, say — must be named via the `channels` option). Auth
  and tier refusals from the mint surface as the SDK's normal errors
  (`UpgradeRequired` with `requiredTier: 'ULTRA'`, `Unauthorized`,
  `ServiceUnavailable`) and are never retried; an invalid connect token —
  which the server reports by CLOSING the socket with code 3500/3501, never
  as a reply error — surfaces as `Unauthorized` instead of reconnect-looping.
  A dead-connection watchdog tears down and re-establishes a connection that
  goes completely silent for ~2× the server's advertised ping cadence, so a
  half-open socket can never hang the stream forever. Invalid `matches` ids
  (`NaN`, say) throw a `TypeError` up front rather than silently widening the
  subscription to the whole slate. Today the subscribed score channels carry
  `score` frames only — the break-point signal frames remain native-only.
- `PushFrame` — the publication type the push streamer yields.
- `PushStreamOptions.channels` — extra channel names subscribed verbatim, the
  escape hatch for channel families newer than this SDK (mirrors the Python
  SDK's `channels=` option); `WsToken.channels` now also types the optional
  `point_match` / `point_slate` grants.

### Changed
- README and doc-comments that pointed push-feed users at `centrifuge-js` now
  point at the built-in `PushStream`; minting the raw token remains supported
  for bring-your-own clients. The push streamer is recommended for
  continuous/production streaming, the native streamer for quick starts.
- `LiveScoreStream` gains the same dead-connection watchdog as `PushStream`:
  total silence past ~3 heartbeat intervals (~45s; the native feed pings every
  ~15s) tears the socket down and reconnects instead of hanging forever on a
  half-open connection.

## [1.4.2] — 2026-08-16

### Added
- `PackageKind` gains `'archive'` — the 1968–2022 results archive as yearly
  bulk packages (bare-year period, same entitlement as the tape packages).
  The type previously rejected a kind the API accepts.

### Changed
- Dev-only: esbuild 0.28.2 (clears a low-severity advisory).

## [1.4.1] — 2026-08-07

### Fixed
- **`ScoreUpdate` typed a frame that never existed.** The wire NESTS the
  payload — `{"type": "score", "match_id": N, "score": {sets, games, points,
  server, is_tiebreak, timestamp, win_probability_p1, danger}}` — but the
  type extended `Score` and described the fields flat on the frame. The
  stream has always passed the raw frame through, so every flat read
  (`frame.sets`, `frame.win_probability_p1`) compiled and returned
  `undefined`. `ScoreUpdate` is now `{type, match_id, score?: Score}` with
  the model fields inside `score`, matching what actually arrives. A
  regression test replays the real nested wire shape verbatim.
- **The CLI's `watch` printed `-` for every score** for the same reason: it
  read the score fields off the frame instead of `frame.score`. Fixed.
- **`BreakPoint.set` and `.game` are strings on the wire** (`'1-1'`,
  `'3-4'`), not numbers as typed since 1.2.0. Retyped to match.
- **The subscribe frame carried a stray `action: 'subscribe'` key.** The
  server ignores unknown keys, so it was harmless — but the documented frame
  is `{topics, signals?}` and that is now exactly what is sent.

### Notes
- No behavioural change for consumers who were already reading
  `frame.score` (which always worked at runtime); consumers who read the
  flat fields were reading `undefined` and will now get a compile error
  pointing at the fix.

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
