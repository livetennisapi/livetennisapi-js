<div align="center">

<img src="https://raw.githubusercontent.com/livetennisapi/.github/main/profile/banner.jpg" alt="Live Tennis API" width="640">

# livetennisapi

**Official JavaScript / TypeScript client for the [Live Tennis API](https://livetennisapi.com).**

Real-time tennis scores, players, rankings, match-winner market prices and model
win-probability — for ATP, WTA, Challenger, ITF and juniors, over REST and WebSocket.

[![npm](https://img.shields.io/npm/v/livetennisapi.svg)](https://www.npmjs.com/package/livetennisapi)
[![types](https://img.shields.io/npm/types/livetennisapi.svg)](https://www.npmjs.com/package/livetennisapi)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[**Documentation**](https://docs.livetennisapi.com) · [**Get a free API key**](https://livetennisapi.com/subscribe/free)

</div>

---

## Install

```bash
npm install livetennisapi
```

**Zero runtime dependencies.** Uses the platform `fetch` and `WebSocket`, so it runs
unchanged on Node 18+, Deno, Bun, Cloudflare Workers and the browser.

**CORS is enabled** on the API (`Access-Control-Allow-Origin: *`), so browser calls
work directly. Caveat: a FREE key in browser code is acceptable; a **paid key never
is** — anyone can read it from the page. Keep paid keys server-side.

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
  if (update.type === 'score') console.log(update.match_id, update.score?.sets);
}
```

Score frames nest their payload under `.score` — the same object the REST
score reads return: `{ type: 'score', match_id, score: { sets, games, points,
server, is_tiebreak, timestamp, win_probability_p1, danger } }`.

Reconnects with exponential backoff and re-subscribes automatically. Heartbeats are
consumed internally, so you only see real score changes. It deliberately does **not**
reconnect on a bad key or insufficient tier — those throw immediately instead of
retrying forever.

> On Node 22+ the global `WebSocket` is used. On Node 18–20, `npm install ws`.

### Break-point signals

Opt in with `signals: ['break_point']` to also receive the headline break-point
feed. The stream then yields a `BreakPoint` the moment a break point arises and a
`BreakPointResult` when it resolves, alongside the usual `ScoreUpdate` — narrow on
`frame.type`:

```ts
import { LiveScoreStream } from 'livetennisapi';

const stream = new LiveScoreStream({ apiKey: 'twjp_…', signals: ['break_point'] });

for await (const frame of stream) {
  if (frame.type === 'break_point') {
    console.log(`BREAK POINT on ${frame.match_id}: p${frame.returner} has ${frame.break_points}`);
  } else if (frame.type === 'break_point_result') {
    console.log(`  -> ${frame.outcome} (p1 win prob now ${frame.win_probability_p1_after})`);
  } else if (frame.type === 'score') {
    console.log(frame.match_id, frame.score?.sets);
  }
}
```

With no `signals` the stream behaves exactly as before — score frames only. Both
the feed and its fields are ULTRA-only. A runnable example lives in
[`livetennisapi-starter-node`](https://github.com/livetennisapi/livetennisapi-starter-node).

Score frames carry the model fields — `win_probability_p1` and `danger` —
inside `.score`, just like the REST score reads (the whole feed is ULTRA). A
`null` there means the model had no output for that state, not a missing
feature.

### Push feed (Centrifugo)

For high fan-out there is a second transport: `getWsToken()` (ULTRA) mints a
short-lived token for a Centrifugo push endpoint. Connect any
Centrifugo-protocol client (e.g. [`centrifuge-js`](https://www.npmjs.com/package/centrifuge))
to `ws_url` and subscribe to `match:{id}` for one match or `slate:all` for
every live score frame — the exact channel names come back in `channels`:

```ts
const { token, ws_url, channels } = await client.getWsToken();
// channels.slate === 'slate:all', channels.match === 'match:{match_id}'
// Frames are the same score objects the polling endpoints return,
// win_probability_p1 and danger included. Mint a fresh token on reconnect.
```

## Tiers

| | FREE | BASIC | PRO | ULTRA |
|---|:--:|:--:|:--:|:--:|
| `listMatches` `getMatch` `getMatchScore` | ✅ | ✅ | ✅ | ✅ |
| `searchPlayers` `getPlayer` `listFixtures` | ✅ | ✅ | ✅ | ✅ |
| `listTournaments` `getTournament` | ✅ | ✅ | ✅ | ✅ |
| `listCompletedMatches` `getMatchTape` (history) | — | ✅¹ | ✅ | ✅ |
| `listArchiveMatches` `getArchiveMatch` `listArchivePlayers` `getArchiveCareer` `getH2H` (results archive · head-to-head) | — | ✅¹ | ✅ | ✅ |
| `listMatchEvents` `listMarkets` `getMarketPrices` | — | — | ✅ | ✅ |
| `listRankings` (rank-ordered listing) | — | — | ✅ | ✅ |
| `listHistoryPackages` `getHistoryPackage` (bulk downloads)² | — | — | ✅ | ✅ |
| `listRankings` (per-player as-of records) | — | — | — | ✅ |
| `getMatchStatistics` (in-play statistics) | — | — | — | ✅ |
| `listRallyMatches` `getRallyMatch` `getMatchRally` `getChartingPlayer` `getChartingMatch` (shot-by-shot) | — | — | — | ✅ |
| `getMatchAnalysis`, `win_probability_p1` / `danger`, WebSocket, `getWsToken` | — | — | — | ✅ |

¹ Also unlocked by any History plan, which works on top of a FREE key.
² `kind: 'rally' | 'rankings'` packages and the `year` archive listing need ULTRA.

## Quotas

| Tier | Requests/min | Requests/day | Price |
|---|--:|--:|--:|
| FREE | 30 | 100 | $0 |
| BASIC | 60 | 1,000 | $9.99/mo |
| PRO | 300 | 10,000 | $29.99/mo |
| ULTRA | 600 | 500,000 | $99.99/mo |

At 100/day, a free key polling faster than every ~15 minutes will spend its
allowance before the day ends — an always-on dashboard belongs on BASIC. Every
response carries `X-RateLimit-Limit` / `-Remaining` / `-Reset` headers; a 429
carries `Retry-After`, and the client retries those for you (per-minute 429s
only — see below).

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
| `RateLimited` | 429 — has `.retryAfter` (seconds); a **daily** 429 also has `.resetsAt`, the absolute ISO instant the allowance returns |
| `AbuseThrottled` | 429 `abuse_throttled` — a ~24h block for chronic over-cap use; has `.retryAtEpoch`. Fix the retry loop |
| `ServerError` / `ServiceUnavailable` | 5xx |
| `APIConnectionError` / `APITimeoutError` | never reached the API |

All extend `LiveTennisAPIError` (`AbuseThrottled` extends `RateLimited`, so an
existing `catch` keeps working).

Requests retry on **per-minute 429 and 5xx only**, honouring `Retry-After` with
exponential backoff and jitter. Other 4xx are never retried — a bad key or an
unentitled tier cannot start working, and retrying only burns rate limit. Nor
are the two 429s retrying cannot fix: a daily 429 (nothing lifts before
`.resetsAt`) and `abuse_throttled` (the block that counting retries earned).

## The results archive (1968–2022) and head-to-head

Two halves, one product: the **results archive** — a licensed corpus of
completed-match results, ATP and WTA, main draws, qualifying and the
ITF/futures tiers, 1968 through 2022 — and the **point-by-point tape
(2023→now)** behind `listCompletedMatches`. The archive ends exactly where the
tape begins, so no match is ever served from two datasets.

```ts
// Winner/loser-shaped results with ranks and seeds AT THE TIME of the match.
const { data } = await client.listArchiveMatches({ tour: 'atp', name: 'borg', round: 'F' });

// Cross-era head-to-head — archive + our own completed matches, in one call.
const h2h = await client.getH2H('federer', 'nadal');
console.log(h2h.totals, h2h.by_surface);

// Career aggregates: W-L by surface/level/year, titles, summed serve stats.
const career = await client.getArchiveCareer('borg');
```

Three things worth knowing before you lean on it:

- **`event_date` is the tournament START date** — per-match dates do not exist
  in this era's records, and none are invented.
- **Names are the keys** for `getH2H` and `getArchiveCareer` (archive people
  have no roster ids). A fragment matching more than one player is refused
  with a `400 ambiguous_name` carrying the candidate list in
  `err.body.candidates` — disambiguate and retry.
- **`meetings[].winner` in an H2H is 1|2 of your request** (`p1`/`p2` as you
  passed them), not of the underlying match row.

## The tape, statistics, rankings and shot-by-shot data

Everything the 1.4.0 surface adds, in one place:

```ts
// The point-by-point tape for one match — works on a LIVE match too. BASIC.
// sequence: 'clean' collapses corrections to one row per score state and is
// the only sequence that carries point_winner. Check meta.coverage before
// backtesting; tiebreaks holds per-set tiebreak final scores.
const tape = await client.getMatchTape(18953, { sequence: 'clean' });

// In-play statistics — aces, serve split, hold/break %, break points. ULTRA.
// Two families: derived (from the tape) and measured (counted upstream).
// Absent measured fields are omitted, never zero-filled.
const stats = await client.getMatchStatistics(18953);

// Point-in-time rankings. Listing mode (PRO): the full published table for
// one system. Per-player mode (ULTRA): the record in force at as_of.
// Rows carry previous_rank (ATP/WTA) for week-on-week movement.
const table = await client.listRankings({ system: 'atp', limit: 100 });
const asOf = await client.listRankings({ player: 925, as_of: '2026-07-01' });

// Shot-by-shot rally construction (Match Charting Project corpus). ULTRA.
// Its own id space, reaching back decades; getMatchRally() resolves OUR
// match ids and 404s with errorCode 'not_charted' when nobody charted it.
const charted = await client.listRallyMatches({ player: 'sampras' });
const rally = await client.getRallyMatch(charted.data[0]!.rally_match_id!);

// Career serve/return/clutch aggregate for one charted player. ULTRA.
const profile = await client.getChartingPlayer('graf', { gender: 'women' });

// Bulk packages — whole months of tape as JSONL/CSV. PRO+.
// kind: 'rally' | 'rankings' and the ?year= listing need ULTRA.
const packages = await client.listHistoryPackages();
const manifest = await client.getHistoryPackage('2026-07');
```

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

## Authentication

Keys are `twjp_…` strings. The client sends `Authorization: Bearer <key>` by
default — the preferred form — or `X-API-Key` with `authHeader: 'x-api-key'`.
The WebSocket feed authenticates with `?token=<key>` on the handshake, because
the browser WebSocket API cannot set headers; over TLS it is encrypted in
transit. Only `health()` needs no key.

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
| Vercel AI SDK tools | `npm install livetennisapi-ai` | [repo](https://github.com/livetennisapi/livetennisapi-ai) | — |
| Break-point starter — Python | — | [repo](https://github.com/livetennisapi/livetennisapi-starter-python) | — |
| Break-point starter — Node | — | [repo](https://github.com/livetennisapi/livetennisapi-starter-node) | — |
| Break-point starter — Go | — | [repo](https://github.com/livetennisapi/livetennisapi-starter-go) | — |

- **API reference** — <https://docs.livetennisapi.com> ([plain-HTML version](https://docs.livetennisapi.com/reference.html), no JavaScript required)
- **OpenAPI 3.1 specification** — [livetennisapi/openapi](https://github.com/livetennisapi/openapi)
- **Get a free API key** — <https://livetennisapi.com/subscribe/free>
- **Products** — <https://livetennisapi.com/products>
- **Website and plans** — <https://livetennisapi.com>
- **Discord** — <https://discord.gg/f8WUZHgDm6>
- **GitHub org** — <https://github.com/livetennisapi>

## Affiliate program

Know developers who need tennis data? The [affiliate program](https://affiliates.livetennisapi.com/program) pays 51% recurring commission for the life of every referred subscription — 30-day cookie, and the people you refer get 10% off.

## Licence

MIT — see [LICENSE](LICENSE). Use of the API service is governed by the
[Terms of Service](https://livetennisapi.com/terms).
