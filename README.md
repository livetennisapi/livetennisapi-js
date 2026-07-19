<div align="center">

<img src="https://raw.githubusercontent.com/livetennisapi/.github/main/profile/banner.jpg" alt="Live Tennis API" width="640">

# livetennisapi

**Official JavaScript / TypeScript client for the [Live Tennis API](https://livetennisapi.com).**

Real-time tennis scores, players, rankings, match-winner market prices and model
win-probability — for ATP, WTA, Challenger and ITF, over REST and WebSocket.

[![npm](https://img.shields.io/npm/v/livetennisapi.svg)](https://www.npmjs.com/package/livetennisapi)
[![types](https://img.shields.io/npm/types/livetennisapi.svg)](https://www.npmjs.com/package/livetennisapi)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[**Documentation**](https://docs.livetennisapi.com) · [**Get an API key**](https://livetennisapi.com/#pricing)

</div>

---

## Install

```bash
npm install livetennisapi
```

**Zero runtime dependencies.** Uses the platform `fetch` and `WebSocket`, so it runs
unchanged on Node 18+, Deno, Bun, Cloudflare Workers and the browser.

## Use

```ts
import { LiveTennisAPI } from 'livetennisapi';

const client = new LiveTennisAPI({ apiKey: 'twjp_…' });   // or $LIVETENNISAPI_KEY

const { data } = await client.listMatches({ status: 'live' });
for (const match of data) {
  console.log(match.tournament, match.players?.p1?.name, 'vs', match.players?.p2?.name);
}
```

Fully typed — every response, every option, every error.

## Command line

No install needed:

```console
$ npx livetennisapi live
live matches (3)
ID     Tournament       Rd   Players             Score
18953  ATP Wimbledon    R16  *Alcaraz / Sinner   6-4 3-6 2-1 (40-30)

$ npx livetennisapi match 18953
$ npx livetennisapi players djokovic
$ npx livetennisapi watch --match 18953
```

## Live score feed (ULTRA)

```ts
import { LiveScoreStream } from 'livetennisapi';

const stream = new LiveScoreStream({ apiKey: 'twjp_…' });

for await (const update of stream) {
  console.log(update.match_id, update.sets);
}
```

Reconnects with exponential backoff and re-subscribes automatically. Heartbeats are
consumed internally, so you only see real score changes. It deliberately does **not**
reconnect on a bad key or insufficient tier — those throw immediately instead of
retrying forever.

> On Node 22+ the global `WebSocket` is used. On Node 18–20, `npm install ws`.

## Tiers

| | BASIC | PRO | ULTRA |
|---|:--:|:--:|:--:|
| `listMatches` `getMatch` `getMatchScore` | ✅ | ✅ | ✅ |
| `searchPlayers` `getPlayer` `listFixtures` `listCompletedMatches` | ✅ | ✅ | ✅ |
| `listMatchEvents` `listMarkets` `getMarketPrices` | — | ✅ | ✅ |
| `getMatchAnalysis`, `win_probability_p1` / `danger`, WebSocket | — | — | ✅ |

Calling above your tier throws `UpgradeRequired`, which tells you which tier you need:

```ts
import { UpgradeRequired } from 'livetennisapi';

try {
  await client.getMatchAnalysis(18953);
} catch (err) {
  if (err instanceof UpgradeRequired) console.log(err.requiredTier); // 'ULTRA'
}
```

## Errors

| Class | When |
|---|---|
| `Unauthorized` | 401 — key missing, unknown, or disabled |
| `UpgradeRequired` | 403 — valid key, tier too low (has `.requiredTier`) |
| `NotFound` | 404 — no such resource, or no data yet |
| `RateLimited` | 429 — has `.retryAfter` in seconds |
| `ServerError` / `ServiceUnavailable` | 5xx |
| `APIConnectionError` / `APITimeoutError` | never reached the API |

All extend `LiveTennisAPIError`.

Requests retry on **429 and 5xx only**, honouring `Retry-After` with exponential
backoff and jitter. Other 4xx are never retried — a bad key or an unentitled tier
cannot start working, and retrying only burns rate limit.

## Pagination

`limit` defaults to 50; the API rejects anything above 200. To walk everything —
`paginate()` clamps the page size for you:

```ts
for await (const player of client.paginate((p) => client.searchPlayers('nadal', p))) {
  console.log(player.name);
}
```

## Forward compatibility

The API ships **additive changes within `v1`**, so every response type carries an
index signature. A field added server-side is readable immediately, without
upgrading this package and without a type error:

```ts
const match = await client.getMatch(18953);
match.some_new_field;   // readable — typed as `unknown`
```

## The score shape (read this one)

`games` is **player-major**, not set-major:

```ts
score.games   // [[6, 3, 2], [4, 6, 1]]  ->  6-4, 3-6, 2-1
              //  ^p1 per set  ^p2 per set
score.sets    // [1, 1]
score.server  // 1 | 2
```

Indexing it the other way is the most common mistake made against this API, so
there are helpers:

```ts
import { gamesForSet, formatScore } from 'livetennisapi';

gamesForSet(score, 0);   // [6, 4]
formatScore(score);      // '6-4 3-6 2-1 (40-30)'
```

## Configuration

```ts
new LiveTennisAPI({
  apiKey: 'twjp_…',       // or $LIVETENNISAPI_KEY
  baseUrl: undefined,      // or $LIVETENNISAPI_BASE_URL
  timeout: 30_000,
  maxRetries: 2,
  authHeader: 'bearer',   // or 'x-api-key'
  fetch: undefined,       // inject a custom fetch
});
```

## Contributing

Issues and pull requests welcome at
[livetennisapi/livetennisapi-js](https://github.com/livetennisapi/livetennisapi-js).

```bash
npm install
npm run test:unit                     # unit tests, offline
LIVETENNISAPI_KEY=twjp_… npm run test:contract   # verify against the live API
```

The contract tests assert the live API's real responses match these types. If the
API and the [spec](https://github.com/livetennisapi/openapi) disagree, that's a bug
worth reporting.

## Related

Everything in the Live Tennis API developer surface:

| | Install | Source | Package |
|---|---|---|---|
| Python client | `pip install livetennisapi` | [repo](https://github.com/livetennisapi/livetennisapi-python) | [package](https://pypi.org/project/livetennisapi/) |
| JavaScript / TypeScript client **(this repo)** | `npm install livetennisapi` | — | [package](https://www.npmjs.com/package/livetennisapi) |
| MCP server for LLM agents | `npx livetennisapi-mcp` | [repo](https://github.com/livetennisapi/livetennisapi-mcp) | [package](https://www.npmjs.com/package/livetennisapi-mcp) |

- **API reference** — <https://docs.livetennisapi.com> ([plain-HTML version](https://docs.livetennisapi.com/reference.html), no JavaScript required)
- **OpenAPI 3.1 specification** — [livetennisapi/openapi](https://github.com/livetennisapi/openapi)
- **Website and plans** — <https://livetennisapi.com>

## Licence

MIT — see [LICENSE](LICENSE). Use of the API service is governed by the
[Terms of Service](https://livetennisapi.com/terms).
