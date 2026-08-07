import { describe, expect, it, vi } from 'vitest';

import {
  AbuseThrottled,
  BadRequest,
  LiveTennisAPI,
  NotFound,
  RateLimited,
  ServerError,
  ServiceUnavailable,
  Unauthorized,
  UpgradeRequired,
  formatScore,
  gamesForSet,
} from '../src/index.js';

const BASE = 'https://api.livetennisapi.com/api/public/v1';

/** A client whose fetch replays the given responses in order. */
function clientReturning(
  responses: Response[] | Response,
  options: Record<string, unknown> = {},
) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  });
  const client = new LiveTennisAPI({
    apiKey: 'twjp_test',
    fetch: fetchImpl as unknown as typeof fetch,
    ...options,
  });
  return { client, calls, fetchImpl };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('auth', () => {
  it('sends a bearer header by default', async () => {
    const { client, calls } = clientReturning(json(200, { status: 'ok' }));
    await client.health();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer twjp_test');
  });

  it('sends X-API-Key when asked', async () => {
    const { client, calls } = clientReturning(json(200, {}), { authHeader: 'x-api-key' });
    await client.health();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('twjp_test');
    expect(headers.Authorization).toBeUndefined();
  });

  it('reads the key from the environment', () => {
    process.env.LIVETENNISAPI_KEY = 'twjp_from_env';
    expect(new LiveTennisAPI().apiKey).toBe('twjp_from_env');
    delete process.env.LIVETENNISAPI_KEY;
  });
});

describe('error mapping', () => {
  const cases: [number, unknown][] = [
    [400, BadRequest],
    [401, Unauthorized],
    [403, UpgradeRequired],
    [404, NotFound],
    [429, RateLimited],
    [500, ServerError],
    [503, ServiceUnavailable],
  ];

  for (const [status, Cls] of cases) {
    it(`maps ${status}`, async () => {
      const { client } = clientReturning(json(status, { error: 'x' }), { maxRetries: 0 });
      await expect(client.getMatch(1)).rejects.toBeInstanceOf(Cls as never);
    });
  }

  it('names ULTRA on an analysis 403', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.getMatchAnalysis(1)).rejects.toMatchObject({ requiredTier: 'ULTRA' });
  });

  it('names PRO on an events 403', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.listMatchEvents(1)).rejects.toMatchObject({ requiredTier: 'PRO' });
  });

  it('names PRO on a markets 403', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.listMarkets(1)).rejects.toMatchObject({ requiredTier: 'PRO' });
  });

  it('names BASIC on a history 403 (the FREE-tier wall)', async () => {
    // FREE stops short of /history/matches, so a free key hitting it must be
    // told BASIC — not left with the API's bare `upgrade_required`.
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.listCompletedMatches()).rejects.toMatchObject({ requiredTier: 'BASIC' });
  });

  it('names BASIC on a results-archive 403', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.listArchiveMatches()).rejects.toMatchObject({ requiredTier: 'BASIC' });
  });

  it('names BASIC on an h2h 403', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.getH2H('federer', 'nadal')).rejects.toMatchObject({ requiredTier: 'BASIC' });
  });

  it('names ULTRA on a statistics 403', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.getMatchStatistics(1)).rejects.toMatchObject({ requiredTier: 'ULTRA' });
  });

  it('names ULTRA on every rally 403, whichever id space addressed it', async () => {
    // `/rally/matches` and `/history/matches/{id}/rally` are the same ULTRA
    // product; the `/history` prefix of the latter must not demote it to BASIC.
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.listRallyMatches()).rejects.toMatchObject({ requiredTier: 'ULTRA' });
    await expect(client.getRallyMatch(1)).rejects.toMatchObject({ requiredTier: 'ULTRA' });
    await expect(client.getMatchRally(1)).rejects.toMatchObject({ requiredTier: 'ULTRA' });
  });

  it('names ULTRA on a charting 403', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.getChartingPlayer('federer')).rejects.toMatchObject({ requiredTier: 'ULTRA' });
    await expect(client.getChartingMatch(1)).rejects.toMatchObject({ requiredTier: 'ULTRA' });
  });

  it('names ULTRA on a ws-token 403', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.getWsToken()).rejects.toMatchObject({ requiredTier: 'ULTRA' });
  });

  it('names PRO on a packages 403 (not BASIC via the /history prefix)', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.listHistoryPackages()).rejects.toMatchObject({ requiredTier: 'PRO' });
    await expect(client.getHistoryPackage('2026-07')).rejects.toMatchObject({ requiredTier: 'PRO' });
  });

  it('names the tier by MODE on a rankings 403', async () => {
    // The path alone cannot say which mode was refused: the listing is PRO,
    // per-player as-of records are ULTRA.
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await expect(client.listRankings({ system: 'atp' })).rejects.toMatchObject({ requiredTier: 'PRO' });
    await expect(client.listRankings({ player: 925 })).rejects.toMatchObject({ requiredTier: 'ULTRA' });
  });

  it('surfaces resetsAt on a daily 429', async () => {
    const { client } = clientReturning(
      json(429, {
        error: 'rate_limited',
        scope: 'day',
        limit_per_day: 100,
        resets_at: '2026-08-07T22:00:00Z',
      }),
      { maxRetries: 0 },
    );
    const err = await client.getMatch(1).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect(err.resetsAt).toBe('2026-08-07T22:00:00Z');
    expect(err.message).toContain('2026-08-07T22:00:00Z');
  });

  it('maps abuse_throttled to its own class with retryAtEpoch', async () => {
    const { client } = clientReturning(
      json(429, { error: 'abuse_throttled', retry_at_epoch: 1_800_000_000 }),
      { maxRetries: 0 },
    );
    const err = await client.getMatch(1).catch((e) => e);
    expect(err).toBeInstanceOf(AbuseThrottled);
    expect(err).toBeInstanceOf(RateLimited); // catch RateLimited still catches it
    expect(err.retryAtEpoch).toBe(1_800_000_000);
    expect(err.errorCode).toBe('abuse_throttled');
  });

  it('surfaces ambiguous_name candidates on the error body', async () => {
    // /h2h and /history/archive/career refuse a fragment matching more than
    // one player — summing two people into one record would be a wrong answer.
    // The candidate list must stay reachable so a caller can disambiguate.
    const { client } = clientReturning(
      json(400, { error: 'ambiguous_name', candidates: ['Serena Williams', 'Venus Williams'] }),
      { maxRetries: 0 },
    );
    const err = await client.getH2H('williams', 'sharapova').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequest);
    expect(err.errorCode).toBe('ambiguous_name');
    expect((err.body as { candidates: string[] }).candidates).toContain('Venus Williams');
  });

  it('exposes retryAfter on 429', async () => {
    const { client } = clientReturning(json(429, { error: 'rate_limited' }, { 'retry-after': '12' }), {
      maxRetries: 0,
    });
    await expect(client.getMatch(1)).rejects.toMatchObject({ retryAfter: 12 });
  });

  it('exposes the machine-readable error code', async () => {
    const { client } = clientReturning(json(403, { error: 'upgrade_required' }), { maxRetries: 0 });
    await client.getMatch(1).catch((err) => {
      expect(err.errorCode).toBe('upgrade_required');
    });
  });

  it('survives a non-JSON error body', async () => {
    const { client } = clientReturning(new Response('<html>nginx</html>', { status: 500 }), {
      maxRetries: 0,
    });
    await expect(client.getMatch(1)).rejects.toBeInstanceOf(ServerError);
  });

  it('instanceof survives the class hierarchy', async () => {
    const { client } = clientReturning(json(503, {}), { maxRetries: 0 });
    const err = await client.getMatch(1).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailable);
    expect(err).toBeInstanceOf(ServerError);
  });
});

describe('retries', () => {
  it('retries 429 then succeeds', async () => {
    const { client, calls } = clientReturning(
      [json(429, {}, { 'retry-after': '0' }), json(200, { id: 1 })],
      { maxRetries: 2 },
    );
    expect((await client.getMatch(1)).id).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('retries 500 then succeeds', async () => {
    const { client, calls } = clientReturning([json(500, {}), json(200, { id: 1 })], {
      maxRetries: 2,
    });
    expect((await client.getMatch(1)).id).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('never retries 400', async () => {
    const { client, calls } = clientReturning(json(400, { error: 'bad' }), { maxRetries: 3 });
    await expect(client.getMatch(1)).rejects.toBeInstanceOf(BadRequest);
    expect(calls).toHaveLength(1);
  });

  it('never retries 401', async () => {
    const { client, calls } = clientReturning(json(401, { error: 'unauthorized' }), { maxRetries: 3 });
    await expect(client.getMatch(1)).rejects.toBeInstanceOf(Unauthorized);
    expect(calls).toHaveLength(1);
  });

  it('never retries 403', async () => {
    const { client, calls } = clientReturning(json(403, { error: 'x' }), { maxRetries: 3 });
    await expect(client.getMatch(1)).rejects.toBeInstanceOf(UpgradeRequired);
    expect(calls).toHaveLength(1);
  });

  it('bounds the retry count', async () => {
    const { client, calls } = clientReturning(json(500, {}), { maxRetries: 2 });
    await expect(client.getMatch(1)).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(3);
  });

  it('never retries a daily 429', async () => {
    // The daily allowance does not come back until the reset instant; no
    // backoff inside a request survives to it.
    const { client, calls } = clientReturning(
      json(429, { error: 'rate_limited', scope: 'day', resets_at: '2026-08-07T22:00:00Z' }),
      { maxRetries: 3 },
    );
    await expect(client.getMatch(1)).rejects.toBeInstanceOf(RateLimited);
    expect(calls).toHaveLength(1);
  });

  it('never retries abuse_throttled', async () => {
    // A ~24h block that counts rejected requests — retrying it is exactly the
    // loop the API is telling you to fix.
    const { client, calls } = clientReturning(
      json(429, { error: 'abuse_throttled', retry_at_epoch: 1_800_000_000 }),
      { maxRetries: 3 },
    );
    await expect(client.getMatch(1)).rejects.toBeInstanceOf(AbuseThrottled);
    expect(calls).toHaveLength(1);
  });
});

describe('requests', () => {
  it('omits undefined params', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.searchPlayers(undefined, { limit: 10 });
    expect(calls[0]!.url).not.toContain('search=');
    expect(calls[0]!.url).toContain('limit=10');
  });

  it('builds nested paths correctly', async () => {
    const { client, calls } = clientReturning(json(200, {}));
    await client.getMatchScore(18953);
    expect(calls[0]!.url).toContain(`${BASE}/matches/18953/score`);
  });

  it('defaults listMatches to live', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listMatches();
    expect(calls[0]!.url).toContain('status=live');
  });

  it('still defaults to live when status is explicitly undefined', async () => {
    // `{ status: maybeUndefined }` is what any caller forwarding an optional
    // produces. The default used to sit before the spread, so this overwrote it
    // and the request went out with no status at all.
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listMatches({ status: undefined, limit: 5 });
    expect(calls[0]!.url).toContain('status=live');
  });

  it('passes the tour filter through', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listMatches({ tour: 'wta' });
    expect(calls[0]!.url).toContain('tour=wta');
  });

  it('repeats the player parameter instead of comma-joining it', async () => {
    // The API reads `?player=1&player=2`; `player=1,2` is a 400.
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listMatches({ player: [925, 1137] });
    expect(calls[0]!.url).toContain('player=925&player=1137');
    expect(calls[0]!.url).not.toContain('player=925%2C1137');
  });

  it('accepts a single player id without an array', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listMatches({ player: 925 });
    expect(calls[0]!.url).toContain('player=925');
  });

  it('passes the date and country filters through', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listMatches({ from: '2026-07-01', to: '2026-07-31', country: 'ned' });
    expect(calls[0]!.url).toContain('from=2026-07-01');
    expect(calls[0]!.url).toContain('to=2026-07-31');
    expect(calls[0]!.url).toContain('country=ned');
  });

  it('passes history filters through, coverage included', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listCompletedMatches({ tour: 'itf', player: 925, coverage: 'from_start' });
    expect(calls[0]!.url).toContain('/history/matches');
    expect(calls[0]!.url).toContain('tour=itf');
    expect(calls[0]!.url).toContain('player=925');
    expect(calls[0]!.url).toContain('coverage=from_start');
  });

  it('builds the tournament paths', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listTournaments({ search: 'wimbledon', tour: 'atp' });
    expect(calls[0]!.url).toContain(`${BASE}/tournaments?`);
    expect(calls[0]!.url).toContain('search=wimbledon');
    await client.getTournament('atp-wimbledon');
    expect(calls[1]!.url).toContain(`${BASE}/tournaments/atp-wimbledon`);
  });

  it('builds the results-archive paths and filters', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listArchiveMatches({ tour: 'atp', name: 'borg', round: 'F', level: 'G', from: '1976-01-01' });
    expect(calls[0]!.url).toContain(`${BASE}/history/archive/matches?`);
    expect(calls[0]!.url).toContain('name=borg');
    expect(calls[0]!.url).toContain('round=F');
    expect(calls[0]!.url).toContain('level=G');
    await client.getArchiveMatch(123456);
    expect(calls[1]!.url).toContain(`${BASE}/history/archive/matches/123456`);
    await client.listArchivePlayers({ name: 'navratilova', tour: 'wta' });
    expect(calls[2]!.url).toContain(`${BASE}/history/archive/players?`);
    await client.getArchiveCareer('borg');
    expect(calls[3]!.url).toContain(`${BASE}/history/archive/career?name=borg`);
  });

  it('sends both h2h names', async () => {
    const { client, calls } = clientReturning(json(200, {}));
    await client.getH2H('federer', 'nadal');
    expect(calls[0]!.url).toContain(`${BASE}/h2h?p1=federer&p2=nadal`);
  });

  it('builds the statistics path', async () => {
    const { client, calls } = clientReturning(json(200, {}));
    await client.getMatchStatistics(18953);
    expect(calls[0]!.url).toContain(`${BASE}/matches/18953/statistics`);
  });

  it('builds the tape path and passes sequence through', async () => {
    const { client, calls } = clientReturning(json(200, {}));
    await client.getMatchTape(18953);
    expect(calls[0]!.url).toContain(`${BASE}/history/matches/18953`);
    expect(calls[0]!.url).not.toContain('sequence=');
    await client.getMatchTape(18953, { sequence: 'clean' });
    expect(calls[1]!.url).toContain('sequence=clean');
  });

  it('builds the rally paths and filters', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listRallyMatches({ player: 'sampras', gender: 'M', from: '1990-01-01', surface: 'grass' });
    expect(calls[0]!.url).toContain(`${BASE}/rally/matches?`);
    expect(calls[0]!.url).toContain('player=sampras');
    expect(calls[0]!.url).toContain('gender=M');
    expect(calls[0]!.url).toContain('surface=grass');
    await client.getRallyMatch(4242, { limit: 100, offset: 200 });
    expect(calls[1]!.url).toContain(`${BASE}/rally/matches/4242?`);
    expect(calls[1]!.url).toContain('limit=100');
    await client.getMatchRally(18953);
    expect(calls[2]!.url).toContain(`${BASE}/history/matches/18953/rally`);
  });

  it('builds the charting paths', async () => {
    const { client, calls } = clientReturning(json(200, {}));
    await client.getChartingPlayer('graf', { gender: 'women' });
    expect(calls[0]!.url).toContain(`${BASE}/charting/players?`);
    expect(calls[0]!.url).toContain('name=graf');
    expect(calls[0]!.url).toContain('gender=women');
    await client.getChartingMatch(777);
    expect(calls[1]!.url).toContain(`${BASE}/charting/matches/777`);
  });

  it('builds both rankings modes, repeating player and system', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listRankings({ system: 'atp', as_of: '2026-07-01', limit: 100 });
    expect(calls[0]!.url).toContain(`${BASE}/rankings?`);
    expect(calls[0]!.url).toContain('system=atp');
    expect(calls[0]!.url).toContain('as_of=2026-07-01');
    await client.listRankings({ player: [925, 1137], system: ['atp', 'utr'] });
    expect(calls[1]!.url).toContain('player=925&player=1137');
    expect(calls[1]!.url).toContain('system=atp&system=utr');
  });

  it('builds the packages paths with kind and year', async () => {
    const { client, calls } = clientReturning(json(200, { data: [] }));
    await client.listHistoryPackages();
    expect(calls[0]!.url).not.toContain('kind=');
    await client.listHistoryPackages({ kind: 'rankings', year: '2025' });
    expect(calls[1]!.url).toContain('kind=rankings');
    expect(calls[1]!.url).toContain('year=2025');
    await client.getHistoryPackage('2026-07', { kind: 'rally' });
    expect(calls[2]!.url).toContain(`${BASE}/history/packages/2026-07?kind=rally`);
  });

  it('builds the ws-token path', async () => {
    const { client, calls } = clientReturning(
      json(200, {
        token: 'x',
        expires_in: 300,
        ws_url: 'wss://api.livetennisapi.com/connection/websocket',
        channels: { match: 'match:{match_id}', slate: 'slate:all' },
      }),
    );
    const tok = await client.getWsToken();
    expect(calls[0]!.url).toContain(`${BASE}/ws-token`);
    expect(tok.channels?.slate).toBe('slate:all');
  });
});

describe('pagination', () => {
  it('stops on a short page', async () => {
    const pages = [
      json(200, { data: Array.from({ length: 200 }, (_, i) => ({ id: i })) }),
      json(200, { data: [{ id: 999 }] }),
    ];
    let n = 0;
    const client = new LiveTennisAPI({
      apiKey: 'k',
      fetch: (async () => pages[Math.min(n++, 1)]!.clone()) as unknown as typeof fetch,
    });
    const seen = [];
    for await (const item of client.paginate((p) => client.listMatches(p))) seen.push(item);
    expect(seen).toHaveLength(201);
  });

  it('caps page size at the API maximum', async () => {
    const calls: string[] = [];
    const client = new LiveTennisAPI({
      apiKey: 'k',
      fetch: (async (url: string) => {
        calls.push(String(url));
        return json(200, { data: [] });
      }) as unknown as typeof fetch,
    });
    for await (const _ of client.paginate((p) => client.listMatches(p), 5000)) void _;
    expect(calls[0]).toContain('limit=200');
  });
});

describe('score helpers', () => {
  it('reads games as player-major', () => {
    // [[6,3,2],[4,6,1]] is 6-4, 3-6, 2-1
    const score = { games: [[6, 3, 2], [4, 6, 1]] };
    expect(gamesForSet(score, 0)).toEqual([6, 4]);
    expect(gamesForSet(score, 1)).toEqual([3, 6]);
    expect(gamesForSet(score, 2)).toEqual([2, 1]);
  });

  it('handles missing games', () => {
    expect(gamesForSet({}, 0)).toEqual([undefined, undefined]);
    expect(gamesForSet(null, 0)).toEqual([undefined, undefined]);
  });

  it('formats a score', () => {
    expect(formatScore({ games: [[6, 3], [4, 6]], points: ['40', '30'] })).toBe('6-4 3-6 (40-30)');
  });

  it('formats an empty score', () => {
    expect(formatScore(null)).toBe('-');
  });

  it('handles a ragged in-progress set', () => {
    expect(formatScore({ games: [[6, 3, 2], [4, 6]] })).toBe('6-4 3-6 2--');
  });
});

describe('forward compatibility', () => {
  it('passes unknown fields through untouched', async () => {
    const { client } = clientReturning(
      json(200, { id: 1, tournament: 'X', a_field_from_next_year: { nested: true } }),
    );
    const match = await client.getMatch(1);
    expect(match.id).toBe(1);
    expect(match.a_field_from_next_year).toEqual({ nested: true });
  });
});
