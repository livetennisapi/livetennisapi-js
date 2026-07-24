# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
