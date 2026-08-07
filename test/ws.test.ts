import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LiveScoreStream } from '../src/index.js';

/**
 * Install a fake global `WebSocket` that acks a subscribe immediately and then
 * replays the given frames. Returns the raw strings the client sent, so a test
 * can assert exactly what the subscribe frame looked like.
 */
function installMockWebSocket(opts: { ack?: unknown; frames?: unknown[] } = {}) {
  const sent: string[] = [];
  const ack = opts.ack ?? { type: 'subscribed', topics: ['live-scores'] };
  const frames = opts.frames ?? [];

  class MockWebSocket {
    private handlers: Record<string, ((event: unknown) => void)[]> = {};

    constructor(public url: string) {
      setTimeout(() => this.emit('open', {}), 0);
    }

    addEventListener(type: string, handler: (event: unknown) => void): void {
      (this.handlers[type] ??= []).push(handler);
    }

    private emit(type: string, event: unknown): void {
      for (const handler of this.handlers[type] ?? []) handler(event);
    }

    send(data: string): void {
      sent.push(data);
      setTimeout(() => {
        this.emit('message', { data: JSON.stringify(ack) });
        for (const frame of frames) this.emit('message', { data: JSON.stringify(frame) });
      }, 0);
    }

    close(): void {
      /* nothing to tear down */
    }
  }

  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  return { sent };
}

/** Collect up to `count` frames from a stream, then stop it cleanly. */
async function collect(stream: LiveScoreStream, count: number): Promise<Record<string, unknown>[]> {
  const got: Record<string, unknown>[] = [];
  for await (const frame of stream) {
    got.push(frame as Record<string, unknown>);
    if (got.length >= count) break;
  }
  return got;
}

describe('LiveScoreStream subscribe frame', () => {
  let originalWebSocket: unknown;

  beforeEach(() => {
    originalWebSocket = (globalThis as unknown as { WebSocket: unknown }).WebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it('sends exactly the documented frame: topics only by default', async () => {
    const { sent } = installMockWebSocket({ frames: [{ type: 'score', match_id: 1 }] });
    const stream = new LiveScoreStream({ apiKey: 'twjp_test' });
    await collect(stream, 1);
    const subscribe = JSON.parse(sent[0]!);
    // The documented subscribe frame is {topics, signals?} — no `action` key.
    expect(subscribe).toEqual({ topics: ['live-scores'] });
    expect(subscribe.signals).toBeUndefined();
  });

  it('sends signals when requested', async () => {
    const { sent } = installMockWebSocket({ frames: [{ type: 'score', match_id: 1 }] });
    const stream = new LiveScoreStream({ apiKey: 'twjp_test', signals: ['break_point'] });
    await collect(stream, 1);
    const subscribe = JSON.parse(sent[0]!);
    expect(subscribe.topics).toEqual(['live-scores']);
    expect(subscribe.signals).toEqual(['break_point']);
  });

  it('drops empty strings from signals', async () => {
    const { sent } = installMockWebSocket({ frames: [{ type: 'score', match_id: 1 }] });
    const stream = new LiveScoreStream({ apiKey: 'twjp_test', signals: ['', 'break_point', ''] });
    await collect(stream, 1);
    expect(JSON.parse(sent[0]!).signals).toEqual(['break_point']);
  });
});

describe('LiveScoreStream frame dispatch', () => {
  let originalWebSocket: unknown;

  beforeEach(() => {
    originalWebSocket = (globalThis as unknown as { WebSocket: unknown }).WebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it('yields score frames', async () => {
    installMockWebSocket({ frames: [{ type: 'score', match_id: 1, score: { sets: [1, 0] } }] });
    const stream = new LiveScoreStream({ apiKey: 'twjp_test' });
    const [frame] = await collect(stream, 1);
    expect(frame!.type).toBe('score');
    expect(frame!.match_id).toBe(1);
  });

  it('passes the nested score payload through exactly as the wire sends it', async () => {
    // The real frame shape, verbatim: the payload is NESTED under `score`,
    // model fields inside it. Nothing is flattened onto the frame — a
    // consumer reading `frame.sets` reads a field that has never existed.
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
    installMockWebSocket({ frames: [wire] });
    const stream = new LiveScoreStream({ apiKey: 'twjp_test' });
    const [frame] = await collect(stream, 1);
    expect(frame).toEqual(wire);
    const score = frame!.score as Record<string, unknown>;
    expect(score.sets).toEqual([1, 0]);
    expect(score.win_probability_p1).toBe(0.62);
    expect(score.danger).toBe(0.18);
    // And the flat reads the old types implied really are absent.
    expect(frame!.sets).toBeUndefined();
    expect(frame!.win_probability_p1).toBeUndefined();
  });

  it('yields break_point and break_point_result frames', async () => {
    installMockWebSocket({
      frames: [
        { type: 'break_point', match_id: 1, returner: 2, break_points: 1 },
        { type: 'break_point_result', match_id: 1, outcome: 'held' },
      ],
    });
    const stream = new LiveScoreStream({ apiKey: 'twjp_test', signals: ['break_point'] });
    const got = await collect(stream, 2);
    expect(got[0]!.type).toBe('break_point');
    expect(got[0]!.returner).toBe(2);
    expect(got[1]!.type).toBe('break_point_result');
    expect(got[1]!.outcome).toBe('held');
  });

  it('swallows ping and subscribed frames', async () => {
    installMockWebSocket({
      frames: [
        { type: 'ping' },
        { type: 'score', match_id: 7 },
        { type: 'subscribed', topics: ['live-scores'] },
      ],
    });
    const stream = new LiveScoreStream({ apiKey: 'twjp_test' });
    const got = await collect(stream, 1);
    expect(got).toHaveLength(1);
    expect(got[0]!.match_id).toBe(7);
  });

  it('preserves order and type across a mixed stream', async () => {
    installMockWebSocket({
      frames: [
        { type: 'score', match_id: 1 },
        { type: 'break_point', match_id: 1 },
        { type: 'break_point_result', match_id: 1, outcome: 'broken' },
        { type: 'score', match_id: 1 },
      ],
    });
    const stream = new LiveScoreStream({ apiKey: 'twjp_test', signals: ['break_point'] });
    const got = await collect(stream, 4);
    expect(got.map((f) => f.type)).toEqual(['score', 'break_point', 'break_point_result', 'score']);
  });
});
