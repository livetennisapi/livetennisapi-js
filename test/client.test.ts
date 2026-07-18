import { describe, expect, it, vi } from 'vitest';

import {
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
