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
 * Install a fake global `WebSocket` that speaks the Centrifugo v2 JSON server
 * side: acks the connect and every subscribe by id, then replays the given
 * publications. Returns the raw strings the client sent, so a test can assert
 * exactly what the connect and subscribe frames looked like.
 */
function installMockPushServer(
  opts: {
    /** Frames published on the first subscribed channel after its ack. */
    frames?: unknown[];
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
          const pushes = (opts.frames ?? []).map((frame) =>
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
