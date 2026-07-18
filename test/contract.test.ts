/**
 * Contract tests — run against the real API.
 *
 * A valid spec is not proof of behaviour. These assert that what production
 * actually sends matches what these types expect.
 *
 *   LIVETENNISAPI_KEY=twjp_… npm run test:contract
 *
 * Skipped without a key so CI stays green for contributors without
 * credentials. Read-only, and tolerant of an empty slate — at 3am there may be
 * no live matches, and that is not a failure.
 */
import { describe, expect, it } from 'vitest';

import { LiveTennisAPI, NotFound, UpgradeRequired } from '../src/index.js';

const KEY = (process.env.LIVETENNISAPI_KEY ?? '').trim();
const withKey = KEY ? describe : describe.skip;

const client = new LiveTennisAPI({ apiKey: KEY });

describe('unauthenticated', () => {
  it('health needs no key', async () => {
    const health = await new LiveTennisAPI({ apiKey: '' }).health();
    expect(health.status).toBe('ok');
    expect(health.version).toBe('v1');
  });
});

withKey('BASIC', () => {
  it('lists matches with the documented shape', async () => {
    const page = await client.listMatches({ status: 'live', limit: 5 });
    expect(Array.isArray(page.data)).toBe(true);
    for (const match of page.data) {
      expect(match.id).toBeTypeOf('number');
      if (match.status) {
        expect(['live', 'upcoming', 'completed', 'cancelled']).toContain(match.status);
      }
    }
  });

  it('games are player-major', async () => {
    const page = await client.listMatches({ status: 'live', limit: 10 });
    const scored = page.data.find((m) => m.score?.games?.length);
    if (!scored) return; // no live match with games on the board
    const games = scored.score!.games!;
    expect(games).toHaveLength(2);
    expect(Array.isArray(games[0])).toBe(true);
    expect(Math.abs(games[0]!.length - games[1]!.length)).toBeLessThanOrEqual(1);
  });

  it('searches players', async () => {
    const page = await client.searchPlayers('a', { limit: 5 });
    for (const player of page.data) expect(player.id).toBeTypeOf('number');
  });

  it('lists fixtures', async () => {
    const page = await client.listFixtures({ limit: 5 });
    expect(Array.isArray(page.data)).toBe(true);
  });

  it('history carries a derived winner', async () => {
    const page = await client.listCompletedMatches({ limit: 5 });
    for (const match of page.data) expect([1, 2, null, undefined]).toContain(match.winner);
  });

  it('404s an unknown match', async () => {
    await expect(client.getMatch(999_999_999)).rejects.toBeInstanceOf(NotFound);
  });

  it('respects limit', async () => {
    const page = await client.listCompletedMatches({ limit: 3 });
    expect(page.data.length).toBeLessThanOrEqual(3);
  });
});

withKey('tier boundaries', () => {
  // Each is "either it works, or it throws UpgradeRequired naming the right
  // tier" — true regardless of the key's tier, and still catches a 403 that
  // surfaces as the wrong error.
  it('events are PRO-gated', async () => {
    const page = await client.listCompletedMatches({ limit: 1 });
    if (!page.data.length) return;
    try {
      await client.listMatchEvents(page.data[0]!.id!, { limit: 5 });
    } catch (err) {
      expect(err).toBeInstanceOf(UpgradeRequired);
      expect((err as UpgradeRequired).requiredTier).toBe('PRO');
    }
  });

  it('analysis is ULTRA-gated', async () => {
    const page = await client.listCompletedMatches({ limit: 1 });
    if (!page.data.length) return;
    try {
      await client.getMatchAnalysis(page.data[0]!.id!);
    } catch (err) {
      if (err instanceof NotFound) return; // entitled, no analysis for this match
      expect(err).toBeInstanceOf(UpgradeRequired);
      expect((err as UpgradeRequired).requiredTier).toBe('ULTRA');
    }
  });
});
