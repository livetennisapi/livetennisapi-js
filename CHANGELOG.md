# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — unreleased

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
