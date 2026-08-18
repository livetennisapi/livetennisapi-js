import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APIConnectionError,
  LiveTennisAPIError,
  PushStream,
  ServiceUnavailable,
  Unauthorized,
  UpgradeRequired,
} from '../src/index.js';

/**
 * A fetch stub for the `/ws-token` mint. Returns the documented mint shape
 * (or the given responses, one per call) and records every URL hit, so a test
 * can assert both that the mint happened and how often.
 */
function installMintFetch(responses?: Array<{ status?: number; body?: unknown }>) {
  const calls: string[] = [];
  let call = 0;
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    const spec = responses?.[Math.min(call, (responses?.length ?? 1) - 1)] ?? {};
    call += 1;
    const body = spec.body ?? {
      token: `jwt-${call}`,
      expires_in: 3600,
      ws_url: 'wss://push.example/connection/websocket',
      channels: { match: 'match:{match_id}', slate: 'slate:all' },
    };
    return new Response(JSON.stringify(body), {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
    });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

/**
 * A fetch stub for the POINT-feed tests: routes `/ws-token` to a mint whose
 * vocabulary DOES advertise the point channels (unless `pointChannels: false`),
 * and `/matches/{id}/points` to the given page builder. Records every URL so a
 * test can assert exactly which REST catch-ups happened and with what cursor.
 */
function installPointsFetch(
  opts: {
    /** Advertise `point_match` / `point_slate` in the mint. Default true. */
    pointChannels?: boolean;
    /** Build the `/matches/{id}/points` response body. Return null to 404. */
    page?: (matchId: number, afterSeq: number) => unknown;
  } = {},
) {
  const calls: string[] = [];
  let mints = 0;
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/ws-token')) {
      mints += 1;
      const channels: Record<string, string> = { match: 'match:{match_id}', slate: 'slate:all' };
      if (opts.pointChannels !== false) {
        channels.point_match = 'point:match:{match_id}';
        channels.point_slate = 'point:slate';
      }
      return new Response(
        JSON.stringify({
          token: `jwt-${mints}`,
          expires_in: 3600,
          ws_url: 'wss://push.example/connection/websocket',
          channels,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const match = parsed.pathname.match(/\/matches\/(\d+)\/points$/);
    if (match && opts.page) {
      const body = opts.page(Number(match[1]), Number(parsed.searchParams.get('after_seq') ?? '0'));
      if (body !== null) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

/**
 * A `/matches/{id}/points` page builder for a match whose committed tape runs
 * `1..maxSeq` — exactly what the real endpoint serves for any `after_seq`,
 * gapless, oldest first, one page.
 */
const tapeUpTo =
  (maxSeq: number) =>
  (matchId: number, afterSeq: number): unknown => ({
    match_id: matchId,
    pbp_coverage: 'point',
    quality: 'clean',
    covers_from_start: true,
    points: Array.from({ length: Math.max(0, maxSeq - afterSeq) }, (_, i) => ({
      seq: afterSeq + 1 + i,
    })),
    last_seq: maxSeq,
    has_more: false,
  });

/** A live `point` frame as the wire sends it — the point NESTED under `.point`. */
const pointFrame = (matchId: number, seq: number) => ({
  type: 'point',
  match_id: matchId,
  point: { seq, set: 1, game: 1, number: seq, server: 1, winner: 2 },
  pbp_coverage: 'point',
  quality: 'clean',
});

/**
 * Install a fake global `WebSocket` that speaks the Centrifugo v2 JSON server
 * side: acks the connect and every subscribe by id, then replays the given
 * publications. Returns the raw strings the client sent, so a test can assert
 * exactly what the connect and subscribe frames looked like.
 */
function installMockPushServer(
  opts: {
    /** Frames published on the first subscribed channel after its ack. */
    frames?: unknown[];
    /** Frames published PER channel — overrides `frames` when given. */
    framesByChannel?: Record<string, unknown[]>;
    /** Reply to every subscribe with this error instead of an ack. */
    subscribeError?: { code: number; message: string };
    /** Deliver all publications in ONE newline-batched message. */
    batch?: boolean;
    /** Send the server ping (`{}`) before publishing. */
    ping?: boolean;
    /** Close the socket after the publications, forcing a reconnect. */
    closeAfterFrames?: boolean;
    /**
     * Instead of acking the connect, CLOSE the socket with this code — how
     * the real server reports an invalid/expired connect token (3500; 3501
     * for a malformed one). Never a reply error.
     */
    closeOnConnect?: { code: number; reason?: string };
    /** Ping cadence (seconds) advertised in the connect reply. Default 25. */
    pingInterval?: number;
    /** Actually SEND the server ping (`{}`) on this real-time cadence (ms). */
    pingEveryMs?: number;
  } = {},
) {
  const sent: string[] = [];

  class MockWebSocket {
    private handlers: Record<string, ((event: unknown) => void)[]> = {};
    private pinger: ReturnType<typeof setInterval> | null = null;

    constructor(public url: string) {
      setTimeout(() => this.emit('open', {}), 0);
    }

    addEventListener(type: string, handler: (event: unknown) => void): void {
      (this.handlers[type] ??= []).push(handler);
    }

    private emit(type: string, event: unknown): void {
      for (const handler of this.handlers[type] ?? []) handler(event);
    }

    private reply(obj: unknown): void {
      setTimeout(() => this.emit('message', { data: JSON.stringify(obj) }), 0);
    }

    send(data: string): void {
      sent.push(data);
      const msg = JSON.parse(data) as Record<string, unknown>;
      if (Object.keys(msg).length === 0) return; // the client's pong
      if (msg.connect) {
        if (opts.closeOnConnect) {
          setTimeout(
            () =>
              this.emit('close', {
                code: opts.closeOnConnect!.code,
                reason: opts.closeOnConnect!.reason ?? '',
              }),
            0,
          );
          return;
        }
        this.reply({
          id: msg.id,
          connect: { client: 'c1', version: '5.4.5', ping: opts.pingInterval ?? 25 },
        });
        return;
      }
      if (msg.subscribe) {
        if (opts.subscribeError) {
          this.reply({ id: msg.id, error: opts.subscribeError });
          return;
        }
        this.reply({ id: msg.id, subscribe: {} });
        if (opts.pingEveryMs && !this.pinger) {
          this.pinger = setInterval(() => this.emit('message', { data: '{}' }), opts.pingEveryMs);
        }
        const channel = (msg.subscribe as { channel: string }).channel;
        setTimeout(() => {
          if (opts.ping) this.emit('message', { data: '{}' });
          const frames = opts.framesByChannel
            ? opts.framesByChannel[channel] ?? []
            : opts.frames ?? [];
          const pushes = frames.map((frame) =>
            JSON.stringify({ push: { channel, pub: { data: frame } } }),
          );
          if (opts.batch) {
            if (pushes.length) this.emit('message', { data: pushes.join('\n') });
          } else {
            for (const push of pushes) this.emit('message', { data: push });
          }
          if (opts.closeAfterFrames) setTimeout(() => this.emit('close', {}), 0);
        }, 0);
      }
    }

    close(): void {
      if (this.pinger) {
        clearInterval(this.pinger);
        this.pinger = null;
      }
    }
  }

  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  return { sent };
}

/** Collect up to `count` frames from a stream, then stop it cleanly. */
async function collect(stream: PushStream, count: number): Promise<Record<string, unknown>[]> {
  const got: Record<string, unknown>[] = [];
  for await (const frame of stream) {
    got.push(frame as Record<string, unknown>);
    if (got.length >= count) break;
  }
  return got;
}

let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = (globalThis as unknown as { WebSocket: unknown }).WebSocket;
});

afterEach(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

describe('PushStream handshake', () => {
  it('mints a token then sends the documented connect and subscribe frames', async () => {
    const { fetchImpl, calls } = installMintFetch();
    const { sent } = installMockPushServer({ frames: [{ type: 'score', match_id: 1 }] });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    await collect(stream, 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/ws-token');
    // Connect first, with the minted token; then the slate subscribe.
    expect(JSON.parse(sent[0]!)).toEqual({ connect: { token: 'jwt-1' }, id: 1 });
    expect(JSON.parse(sent[1]!)).toEqual({ subscribe: { channel: 'slate:all' }, id: 2 });
  });

  it('subscribes one channel per match id, using the minted template', async () => {
    const { fetchImpl } = installMintFetch();
    const { sent } = installMockPushServer({ frames: [{ type: 'score', match_id: 11 }] });
    const stream = new PushStream({ apiKey: 'twjp_test', matches: [11, 22], fetch: fetchImpl });
    await collect(stream, 1);

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['match:11', 'match:22']);
  });

  it('surfaces the ULTRA gate from the mint as UpgradeRequired, no reconnect', async () => {
    const { fetchImpl, calls } = installMintFetch([
      { status: 403, body: { error: 'upgrade_required' } },
    ]);
    installMockPushServer();
    const stream = new PushStream({ apiKey: 'twjp_free', fetch: fetchImpl });
    const err = await collect(stream, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpgradeRequired);
    expect((err as UpgradeRequired).requiredTier).toBe('ULTRA');
    expect(calls).toHaveLength(1); // fatal — never retried
  });

  it('surfaces a disabled feed (503) as ServiceUnavailable', async () => {
    const { fetchImpl } = installMintFetch([
      { status: 503, body: { error: 'service_unavailable' } },
    ]);
    installMockPushServer();
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    await expect(collect(stream, 1)).rejects.toBeInstanceOf(ServiceUnavailable);
  });

  it('treats a 200 mint with no token as the feed being unavailable', async () => {
    const { fetchImpl } = installMintFetch([{ body: { expires_in: 3600 } }]);
    installMockPushServer();
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    await expect(collect(stream, 1)).rejects.toBeInstanceOf(ServiceUnavailable);
  });

  it('raises on a subscribe error reply', async () => {
    const { fetchImpl } = installMintFetch();
    installMockPushServer({ subscribeError: { code: 999, message: 'nope' } });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl, autoReconnect: false });
    const err = await collect(stream, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveTennisAPIError);
    expect(String((err as Error).message)).toContain('999');
  });

  it('maps a permission-denied subscribe reply (103) to UpgradeRequired', async () => {
    const { fetchImpl } = installMintFetch();
    installMockPushServer({ subscribeError: { code: 103, message: 'permission denied' } });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const err = await collect(stream, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpgradeRequired);
  });

  it('surfaces an invalid-token CLOSE (3500) as Unauthorized — no reconnect, no re-mint', async () => {
    // The real server never sends a reply error for a bad connect token: it
    // CLOSES the socket with code 3500 "invalid token". That must be fatal,
    // not an infinite reconnect+mint loop.
    const { fetchImpl, calls } = installMintFetch();
    installMockPushServer({ closeOnConnect: { code: 3500, reason: 'invalid token' } });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl }); // default autoReconnect
    const err = await collect(stream, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unauthorized);
    expect(String((err as Error).message)).toContain('3500');
    expect(String((err as Error).message)).toContain('invalid token');
    expect(calls).toHaveLength(1); // fatal — never re-minted
  });

  it('surfaces an empty-token CLOSE (3501) as Unauthorized too', async () => {
    const { fetchImpl, calls } = installMintFetch();
    installMockPushServer({ closeOnConnect: { code: 3501, reason: 'bad request' } });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const err = await collect(stream, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unauthorized);
    expect(calls).toHaveLength(1);
  });
});

describe('PushStream option validation', () => {
  it('throws a TypeError on a non-finite match id instead of widening to the slate', () => {
    expect(() => new PushStream({ apiKey: 'twjp_test', matches: [NaN] })).toThrow(TypeError);
    expect(() => new PushStream({ apiKey: 'twjp_test', matches: [Number('bad')] })).toThrow(
      /finite match ids/,
    );
    expect(() => new PushStream({ apiKey: 'twjp_test', matches: [18953, Infinity] })).toThrow(
      TypeError,
    );
  });

  it('still treats an omitted or empty matches option as the whole slate', async () => {
    const { fetchImpl } = installMintFetch();
    const { sent } = installMockPushServer({ frames: [{ type: 'score', match_id: 1 }] });
    const stream = new PushStream({ apiKey: 'twjp_test', matches: [], fetch: fetchImpl });
    await collect(stream, 1);
    expect(JSON.parse(sent[1]!)).toEqual({ subscribe: { channel: 'slate:all' }, id: 2 });
  });

  it('subscribes extra channel names verbatim via the channels escape hatch', async () => {
    const { fetchImpl } = installMintFetch();
    const { sent } = installMockPushServer({ frames: [{ type: 'point', match_id: 9 }] });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      channels: ['point:slate'],
      fetch: fetchImpl,
    });
    const [frame] = await collect(stream, 1);
    expect(frame!.type).toBe('point');

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['point:slate']); // named channels replace the slate fallback
  });

  it('subscribes match channels AND extra channels together', async () => {
    const { fetchImpl } = installMintFetch();
    const { sent } = installMockPushServer({ frames: [{ type: 'score', match_id: 7 }] });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      matches: [7],
      channels: ['point:match:7'],
      fetch: fetchImpl,
    });
    await collect(stream, 1);

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['match:7', 'point:match:7']);
  });
});

describe('PushStream frame dispatch', () => {
  it('passes the nested score payload through exactly as the wire sends it', async () => {
    // The real frame shape, verbatim: identical to the native feed — the
    // payload NESTED under `score`, model fields inside it.
    const wire = {
      type: 'score',
      match_id: 18953,
      score: {
        sets: [1, 0],
        games: [[6, 3], [4, 2]],
        points: ['30', '40'],
        server: 2,
        is_tiebreak: false,
        timestamp: '2026-08-07T00:41:12Z',
        win_probability_p1: 0.62,
        danger: 0.18,
      },
    };
    const { fetchImpl } = installMintFetch();
    installMockPushServer({ frames: [wire] });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const [frame] = await collect(stream, 1);
    expect(frame).toEqual(wire);
    expect((frame!.score as Record<string, unknown>).win_probability_p1).toBe(0.62);
  });

  it('splits newline-batched messages into their frames, in order', async () => {
    const { fetchImpl } = installMintFetch();
    installMockPushServer({
      batch: true,
      frames: [
        { type: 'score', match_id: 1 },
        { type: 'score', match_id: 2 },
      ],
    });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const got = await collect(stream, 2);
    expect(got.map((f) => f.match_id)).toEqual([1, 2]);
  });

  it('dispatches by type generically — a new frame kind on a subscribed channel is yielded, not dropped', async () => {
    const { fetchImpl } = installMintFetch();
    installMockPushServer({
      frames: [
        { type: 'stat', match_id: 5, aces_p1: 7 },
        { type: 'score', match_id: 5 },
      ],
    });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const got = await collect(stream, 2);
    expect(got.map((f) => f.type)).toEqual(['stat', 'score']);
  });

  it('replies {} to the server ping and never yields it', async () => {
    const { fetchImpl } = installMintFetch();
    const { sent } = installMockPushServer({ ping: true, frames: [{ type: 'score', match_id: 3 }] });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const got = await collect(stream, 1);
    expect(got[0]!.match_id).toBe(3);
    expect(sent).toContain('{}');
  });
});

describe('PushStream reconnect', () => {
  it('re-mints a fresh token and re-subscribes on every reconnect', { timeout: 15_000 }, async () => {
    const { fetchImpl, calls } = installMintFetch();
    const { sent } = installMockPushServer({
      frames: [{ type: 'score', match_id: 1 }],
      closeAfterFrames: true,
    });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const got = await collect(stream, 2); // the 2nd frame needs a 2nd connection
    expect(got).toHaveLength(2);
    expect(calls.length).toBeGreaterThanOrEqual(2); // one mint per connection

    const tokens = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.connect)
      .map((msg) => (msg.connect as { token: string }).token);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tokens).size).toBe(tokens.length); // never reused
  });

  it('detects a silently-dead connection: total silence past the ping cadence raises', async () => {
    // The server advertises a (tiny, for the test) ping cadence in the
    // connect reply, then goes completely silent after one frame — no close,
    // no error, exactly like a half-open socket. Without a watchdog the
    // generator would park forever.
    const { fetchImpl } = installMintFetch();
    installMockPushServer({ pingInterval: 0.05, frames: [{ type: 'score', match_id: 1 }] });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl, autoReconnect: false });
    const err = await collect(stream, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(String((err as Error).message)).toContain('silent');
  });

  it('reconnects with a fresh mint after the dead-connection watchdog fires', { timeout: 15_000 }, async () => {
    const { fetchImpl, calls } = installMintFetch();
    installMockPushServer({ pingInterval: 0.05, frames: [{ type: 'score', match_id: 1 }] });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const got = await collect(stream, 2); // the 2nd frame needs a 2nd connection
    expect(got).toHaveLength(2);
    expect(calls.length).toBeGreaterThanOrEqual(2); // one mint per connection
  });

  it('a server ping resets the silence watchdog — regular pings keep the stream alive', async () => {
    // Pings arrive but no publications: the stream must stay connected well
    // past the bare silence deadline (2×cadence + slack) without reconnecting.
    const { fetchImpl, calls } = installMintFetch();
    const { sent } = installMockPushServer({ pingInterval: 0.05, frames: [], pingEveryMs: 40 });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    const it = stream[Symbol.asyncIterator]();
    const next = it.next();
    await new Promise((resolve) => setTimeout(resolve, 700)); // >4× the 150ms deadline
    stream.close();
    await next.catch(() => undefined);
    expect(calls).toHaveLength(1); // never reconnected
    expect(sent.filter((raw) => raw === '{}').length).toBeGreaterThan(0); // pongs flowed
  });
});

describe('PushStream point feed', () => {
  it('points: true subscribes the point slate from the mint vocabulary', async () => {
    const { fetchImpl } = installPointsFetch();
    const { sent } = installMockPushServer({
      framesByChannel: { 'point:slate': [pointFrame(9, 1)] },
    });
    const stream = new PushStream({ apiKey: 'twjp_test', points: true, fetch: fetchImpl });
    const [frame] = await collect(stream, 1);
    expect(frame!.type).toBe('point');

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['slate:all', 'point:slate']);
  });

  it('points: true subscribes one point channel per match, using the minted template', async () => {
    const { fetchImpl } = installPointsFetch();
    const { sent } = installMockPushServer({
      framesByChannel: { 'point:match:7': [pointFrame(7, 1)] },
    });
    const stream = new PushStream({ apiKey: 'twjp_test', matches: [7], points: true, fetch: fetchImpl });
    await collect(stream, 1);

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['match:7', 'point:match:7']);
  });

  it('refuses loudly when the mint does not advertise the point channels — fatal, no re-mint', async () => {
    // An unadvertised vocabulary is the server's honest refusal (the point
    // gate is off, or the plan does not include points). Subscribing a guessed
    // channel name would turn that refusal into a silent empty feed.
    const { fetchImpl, calls } = installPointsFetch({ pointChannels: false });
    installMockPushServer();
    const stream = new PushStream({ apiKey: 'twjp_test', points: true, fetch: fetchImpl }); // default autoReconnect
    const err = await collect(stream, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailable);
    expect(String((err as Error).message)).toContain('point');
    expect(calls).toHaveLength(1); // fatal — never re-minted
  });

  it('passes the live point frame through verbatim, payload nested under .point', async () => {
    const wire = pointFrame(18953, 1);
    const { fetchImpl } = installPointsFetch();
    installMockPushServer({ framesByChannel: { 'point:match:18953': [wire] } });
    const stream = new PushStream({ apiKey: 'twjp_test', matches: [18953], points: true, fetch: fetchImpl });
    const [frame] = await collect(stream, 1);
    expect(frame).toEqual(wire);
    expect((frame!.point as Record<string, unknown>).seq).toBe(1);
  });

  it('catches up over REST on reconnect — replayed points arrive in seq order, duplicates dropped', { timeout: 15_000 }, async () => {
    // Connection 1 delivers seq 1 live, then dies. By reconnect time the
    // match has committed up to seq 3: the catch-up must fetch after the
    // cursor (after_seq=1), yield 2 and 3 BEFORE any live frame of the new
    // connection, and drop the replayed live seq 1 as a duplicate.
    const { fetchImpl, calls } = installPointsFetch({ page: tapeUpTo(3) });
    installMockPushServer({
      framesByChannel: { 'point:match:5': [pointFrame(5, 1)] },
      closeAfterFrames: true,
    });
    const stream = new PushStream({ apiKey: 'twjp_test', matches: [5], points: true, fetch: fetchImpl });
    const got = await collect(stream, 3);
    expect(got.map((f) => (f.point as Record<string, unknown>).seq)).toEqual([1, 2, 3]);
    // The catch-up resumed exactly after the cursor, not from scratch.
    const restCalls = calls.filter((url) => url.includes('/matches/5/points'));
    expect(restCalls).toHaveLength(1);
    expect(restCalls[0]).toContain('after_seq=1');
  });

  it('repairs a mid-stream gap over REST before the trigger frame, and reports it via onGap', async () => {
    // Live delivers seq 1 then seq 4: the hole (2, 3) must be filled over
    // REST and yielded BEFORE the frame that revealed it, with onGap fired
    // once for observability.
    const gaps: [number, number, number][] = [];
    const { fetchImpl } = installPointsFetch({ page: tapeUpTo(4) });
    installMockPushServer({
      framesByChannel: { 'point:match:5': [pointFrame(5, 1), pointFrame(5, 4)] },
    });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      matches: [5],
      points: true,
      onGap: (matchId, expectedSeq, gotSeq) => gaps.push([matchId, expectedSeq, gotSeq]),
      fetch: fetchImpl,
    });
    const got = await collect(stream, 4);
    expect(got.map((f) => (f.point as Record<string, unknown>).seq)).toEqual([1, 2, 3, 4]);
    expect(gaps).toEqual([[5, 2, 4]]);
  });

  it('back-fills a match first seen mid-play from seq 1, without reporting a gap', async () => {
    // The first frame of an unseen match is normal operation (joining the
    // slate mid-play), not a hole in a stream we were following: back-fill
    // from the start, no onGap.
    const gaps: unknown[] = [];
    const { fetchImpl } = installPointsFetch({ page: tapeUpTo(3) });
    installMockPushServer({
      framesByChannel: { 'point:slate': [pointFrame(5, 3)] },
    });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      points: true,
      onGap: (...gap) => gaps.push(gap),
      fetch: fetchImpl,
    });
    const got = await collect(stream, 3);
    expect(got.map((f) => (f.point as Record<string, unknown>).seq)).toEqual([1, 2, 3]);
    expect(gaps).toEqual([]);
  });

  it('walks a multi-page gap fill with the server cursor, bounded by the trigger frame', async () => {
    // Live delivers seq 1 then seq 6 with the server paging two points at a
    // time: the fill must follow last_seq/has_more across pages (after_seq=1,
    // then after_seq=3), yield 2..5 in order, and stop BEFORE the trigger's
    // seq — the trigger frame yields itself.
    const gaps: [number, number, number][] = [];
    const pagedTape =
      (maxSeq: number, pageSize: number) => (matchId: number, afterSeq: number) => {
        const end = Math.min(afterSeq + pageSize, maxSeq);
        return {
          match_id: matchId,
          pbp_coverage: 'point',
          quality: 'clean',
          points: Array.from({ length: Math.max(0, end - afterSeq) }, (_, i) => ({
            seq: afterSeq + 1 + i,
          })),
          last_seq: end,
          has_more: end < maxSeq,
        };
      };
    const { fetchImpl, calls } = installPointsFetch({ page: pagedTape(6, 2) });
    installMockPushServer({
      framesByChannel: { 'point:match:5': [pointFrame(5, 1), pointFrame(5, 6)] },
    });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      matches: [5],
      points: true,
      onGap: (matchId, expectedSeq, gotSeq) => gaps.push([matchId, expectedSeq, gotSeq]),
      fetch: fetchImpl,
    });
    const got = await collect(stream, 6);
    expect(got.map((f) => (f.point as Record<string, unknown>).seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(gaps).toEqual([[5, 2, 6]]);
    const restCalls = calls.filter((url) => url.includes('/matches/5/points'));
    expect(restCalls).toHaveLength(2);
    expect(restCalls[0]).toContain('after_seq=1');
    expect(restCalls[1]).toContain('after_seq=3');
  });

  it('a 404 during catch-up prunes that match and moves on — one vanished match cannot wedge the stream', { timeout: 15_000 }, async () => {
    // A long-running slate stream can hold cursors for matches that aged out
    // of the live window before the idle eviction fires. Their 404 must drop
    // the cursor and let the other matches catch up — not abort the
    // connection into an eternal reconnect -> same-404 loop that never
    // delivers a frame again.
    const { fetchImpl, calls } = installPointsFetch({
      page: (matchId, afterSeq) => (matchId === 4 ? null : tapeUpTo(2)(matchId, afterSeq)),
    });
    installMockPushServer({
      framesByChannel: { 'point:slate': [pointFrame(4, 1), pointFrame(5, 1)] },
      closeAfterFrames: true,
    });
    const stream = new PushStream({ apiKey: 'twjp_test', points: true, fetch: fetchImpl });
    const got = await collect(stream, 3);
    expect(got.map((f) => [f.match_id, (f.point as Record<string, unknown>).seq])).toEqual([
      [4, 1],
      [5, 1],
      [5, 2], // match 5 still caught up, even though match 4's catch-up 404ed first
    ]);
    expect(calls.filter((url) => url.includes('/matches/4/points'))).toHaveLength(1);
    expect(calls.filter((url) => url.includes('/matches/5/points'))).toHaveLength(1);
  });

  it('evicts a cursor idle past the window before catch-up — stale matches cost no REST calls', async () => {
    // The bound on the cursor set: a match silent for two hours is evicted
    // at reconnect-catch-up time, so the fan-out stays proportional to
    // matches actually in play. The recently-active match still catches up.
    const { fetchImpl, calls } = installPointsFetch({ page: tapeUpTo(2) });
    installMockPushServer({
      framesByChannel: { 'point:slate': [] },
      closeAfterFrames: false,
    });
    const stream = new PushStream({ apiKey: 'twjp_test', points: true, fetch: fetchImpl });
    // Prime the resume state as a previous connection would have left it:
    // match 4 last seen beyond the eviction window, match 5 fresh.
    const state = stream as unknown as {
      cursors: Map<number, number>;
      cursorSeen: Map<number, number>;
    };
    state.cursors.set(4, 1);
    state.cursorSeen.set(4, Date.now() - (2 * 60 * 60 * 1_000 + 1_000));
    state.cursors.set(5, 1);
    state.cursorSeen.set(5, Date.now());
    const got = await collect(stream, 1); // the catch-up frame for match 5
    expect(got.map((f) => [f.match_id, (f.point as Record<string, unknown>).seq])).toEqual([[5, 2]]);
    expect(calls.filter((url) => url.includes('/matches/4/points'))).toHaveLength(0);
    expect(calls.filter((url) => url.includes('/matches/5/points'))).toHaveLength(1);
    expect(state.cursors.has(4)).toBe(false);
  });

  it('never subscribes one channel twice — points: true deduped against a legacy channels entry', async () => {
    // The README migrates `channels: ['point:slate']` users to `points: true`;
    // keeping both must not double-subscribe the channel (a server-side
    // "already subscribed" reply error and reconnect churn).
    const { fetchImpl } = installPointsFetch();
    const { sent } = installMockPushServer({
      framesByChannel: { 'point:slate': [pointFrame(9, 1)] },
    });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      points: true,
      channels: ['point:slate'],
      fetch: fetchImpl,
    });
    const [frame] = await collect(stream, 1);
    expect(frame!.type).toBe('point');
    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['point:slate']);
  });

  it('pointsResume: false takes the raw frames with no REST traffic', async () => {
    const { fetchImpl, calls } = installPointsFetch({ page: tapeUpTo(3) });
    installMockPushServer({
      framesByChannel: { 'point:match:5': [pointFrame(5, 3)] },
    });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      matches: [5],
      points: true,
      pointsResume: false,
      fetch: fetchImpl,
    });
    const [frame] = await collect(stream, 1);
    expect((frame!.point as Record<string, unknown>).seq).toBe(3); // raw, no back-fill
    expect(calls.filter((url) => url.includes('/points'))).toHaveLength(0);
    expect(calls.filter((url) => url.includes('/ws-token'))).toHaveLength(1);
  });
});

/** A `/ws-token` mint body whose vocabulary DOES advertise the signal channels. */
const signalsMintBody = () => ({
  token: 'jwt-signals',
  expires_in: 3600,
  ws_url: 'wss://push.example/connection/websocket',
  channels: {
    match: 'match:{match_id}',
    slate: 'slate:all',
    signal_match: 'signal:match:{match_id}',
    signal_slate: 'signal:slate',
  },
});

describe('PushStream signal feed', () => {
  it('signals: true subscribes the signal slate from the mint vocabulary', async () => {
    const { fetchImpl } = installMintFetch([{ body: signalsMintBody() }]);
    const { sent } = installMockPushServer({
      framesByChannel: { 'signal:slate': [{ type: 'break_point', match_id: 9 }] },
    });
    const stream = new PushStream({ apiKey: 'twjp_test', signals: true, fetch: fetchImpl });
    const [frame] = await collect(stream, 1);
    expect(frame!.type).toBe('break_point');

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['slate:all', 'signal:slate']);
  });

  it('signals: true subscribes one signal channel per match, using the minted template', async () => {
    const { fetchImpl } = installMintFetch([{ body: signalsMintBody() }]);
    const { sent } = installMockPushServer({
      framesByChannel: { 'signal:match:7': [{ type: 'break_point', match_id: 7 }] },
    });
    const stream = new PushStream({ apiKey: 'twjp_test', matches: [7], signals: true, fetch: fetchImpl });
    await collect(stream, 1);

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['match:7', 'signal:match:7']);
  });

  it('signals stay off by default — an advertised signal vocabulary is never subscribed unasked', async () => {
    const { fetchImpl } = installMintFetch([{ body: signalsMintBody() }]);
    const { sent } = installMockPushServer({ frames: [{ type: 'score', match_id: 1 }] });
    const stream = new PushStream({ apiKey: 'twjp_test', fetch: fetchImpl });
    await collect(stream, 1);

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['slate:all']);
  });

  it('refuses loudly when the mint does not advertise the signal channels — fatal, no re-mint', async () => {
    // An unadvertised vocabulary is the server's honest refusal (the signal
    // feed is off). Subscribing a guessed channel name would turn that
    // refusal into a silent empty feed.
    const { fetchImpl, calls } = installMintFetch(); // default mint: no signal channels
    installMockPushServer();
    const stream = new PushStream({ apiKey: 'twjp_test', signals: true, fetch: fetchImpl }); // default autoReconnect
    const err = await collect(stream, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailable);
    expect(String((err as Error).message)).toContain('signal');
    expect(calls).toHaveLength(1); // fatal — never re-minted
  });

  it('passes every signal kind through verbatim, in order — break_point, its result, divergence', async () => {
    // The exact event shapes the server publishes (the same frames the
    // native feed's `signals` option delivers), untouched by any resume or
    // dedup machinery — signals have no seq.
    const wires = [
      {
        type: 'break_point',
        match_id: 18953,
        server: 1,
        returner: 2,
        break_points: 2,
        set: '1-1',
        game: '3-4',
        point: '15-40',
        win_probability_p1: 0.58,
        prob_swing: 0.14,
        server_side_favoured: true,
        ts: '2026-08-18T12:00:00Z',
      },
      {
        type: 'break_point_result',
        match_id: 18953,
        server: 1,
        outcome: 'broken',
        win_probability_p1_after: 0.41,
        ts: '2026-08-18T12:01:30Z',
      },
      {
        type: 'divergence',
        match_id: 18953,
        model_prob: 0.62,
        market_prob: 0.51,
        gap: 0.11,
        direction: 'p1',
        price_source: 'polymarket',
        ts: '2026-08-18T12:02:00Z',
      },
    ];
    const { fetchImpl } = installMintFetch([{ body: signalsMintBody() }]);
    installMockPushServer({ framesByChannel: { 'signal:match:18953': wires } });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      matches: [18953],
      signals: true,
      fetch: fetchImpl,
    });
    const got = await collect(stream, 3);
    expect(got).toEqual(wires);
  });

  it('signals: true triggers no REST traffic — events have no resume', async () => {
    const { fetchImpl, calls } = installMintFetch([{ body: signalsMintBody() }]);
    installMockPushServer({
      framesByChannel: {
        'signal:slate': [
          { type: 'break_point', match_id: 5 },
          { type: 'break_point_result', match_id: 5, outcome: 'held' },
        ],
      },
    });
    const stream = new PushStream({ apiKey: 'twjp_test', signals: true, fetch: fetchImpl });
    const got = await collect(stream, 2);
    expect(got.map((f) => f.type)).toEqual(['break_point', 'break_point_result']);
    expect(calls).toHaveLength(1); // the mint only — no catch-up, no back-fill
  });

  it('signals: true composes with points: true — both families subscribed alongside the slate', async () => {
    const { fetchImpl } = installPointsFetch();
    // installPointsFetch advertises the point channels; graft the signal
    // vocabulary onto its mint by wrapping the fetch.
    const wrapped = (async (url: unknown, init?: unknown) => {
      const res = await (fetchImpl as (u: unknown, i?: unknown) => Promise<Response>)(url, init);
      if (!String(url).includes('/ws-token')) return res;
      const body = (await res.json()) as { channels: Record<string, string> };
      body.channels.signal_match = 'signal:match:{match_id}';
      body.channels.signal_slate = 'signal:slate';
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    const { sent } = installMockPushServer({
      framesByChannel: { 'signal:match:7': [{ type: 'break_point', match_id: 7 }] },
    });
    const stream = new PushStream({
      apiKey: 'twjp_test',
      matches: [7],
      points: true,
      pointsResume: false,
      signals: true,
      fetch: wrapped,
    });
    await collect(stream, 1);

    const subscribes = sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.subscribe)
      .map((msg) => (msg.subscribe as { channel: string }).channel);
    expect(subscribes).toEqual(['match:7', 'point:match:7', 'signal:match:7']);
  });
});
