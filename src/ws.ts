/**
 * WebSocket live-score feed. **ULTRA tier only.**
 *
 * ```ts
 * import { LiveScoreStream } from 'livetennisapi';
 *
 * const stream = new LiveScoreStream({ apiKey: 'twjp_…' });
 * for await (const update of stream) {
 *   console.log(update.match_id, update.sets);
 * }
 * ```
 *
 * The feed pushes a `score` frame whenever a subscribed match changes, plus a
 * `ping` heartbeat roughly every 15s. Heartbeats are consumed internally and
 * never yielded.
 *
 * Pass `signals: ['break_point']` to also receive the headline break-point feed:
 * `break_point` frames (yielded as {@link BreakPoint}) the instant a break point
 * arises and `break_point_result` frames ({@link BreakPointResult}) when it
 * resolves. Narrow on `frame.type` to tell frames apart. With no `signals` the
 * stream yields only `score` frames, exactly as before.
 *
 * Reconnects automatically with exponential backoff and re-subscribes. It does
 * **not** reconnect on a bad key, an insufficient tier, or the service being
 * disabled — retrying those would just hammer a closed door.
 *
 * Uses the platform `WebSocket` when present (Node 22+, Deno, Bun, browsers)
 * and falls back to the `ws` package on older Node.
 */

import { DEFAULT_BASE_URL, readEnv } from './client.js';
import {
  APIConnectionError,
  LiveTennisAPIError,
  ServiceUnavailable,
  Unauthorized,
  UpgradeRequired,
} from './errors.js';
import type { BreakPoint, BreakPointResult, ScoreUpdate, StreamFrame } from './types.js';

/** The server drops the socket if the subscribe frame is late. */
const SUBSCRIBE_TIMEOUT_MS = 15_000;

/**
 * How long a connection must stay up before it counts as healthy enough to
 * reset the backoff. Resetting on a successful subscribe alone lets a flapping
 * server (accept -> ack -> drop) pin the delay at step one forever, so the
 * backoff never grows and `maxReconnectAttempts` is never reached.
 */
const HEALTHY_UPTIME_MS = 60_000;

/** Server error codes that reconnecting can never resolve. */
const FATAL: Record<string, (message: string) => LiveTennisAPIError> = {
  unauthorized: (m) => new Unauthorized(m, { status: 0 }),
  upgrade_required: (m) => new UpgradeRequired(m, { status: 0, requiredTier: 'ULTRA' }),
  service_unavailable: (m) => new ServiceUnavailable(m, { status: 0 }),
};

export interface StreamOptions {
  apiKey?: string;
  baseUrl?: string;
  /** `live-scores` for every live match, or `match:<id>`. */
  topics?: string[];
  /**
   * Opt-in signals to receive on top of score frames, e.g. `['break_point']`.
   * Omitted (the default) means score frames only — identical to before. ULTRA.
   */
  signals?: string[];
  autoReconnect?: boolean;
  /** 0 means retry forever. */
  maxReconnectAttempts?: number;
  timeout?: number;
}

type AnySocket = {
  send(data: string): void;
  close(): void;
  addEventListener?(type: string, listener: (event: any) => void): void;
  on?(type: string, listener: (...args: any[]) => void): void;
};

async function resolveWebSocket(): Promise<any> {
  if (typeof (globalThis as any).WebSocket === 'function') return (globalThis as any).WebSocket;
  try {
    // Indirected through a variable so TypeScript does not try to resolve an
    // optional peer dependency that may not be installed, and so bundlers do
    // not hard-fail on it. `ws` is only reached on Node without global WebSocket.
    const moduleName = 'ws';
    const mod = await import(/* @vite-ignore */ moduleName);
    return (mod as any).default ?? mod;
  } catch {
    throw new LiveTennisAPIError(
      'No WebSocket implementation available. Use Node 22+, or install the "ws" package.',
    );
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class LiveScoreStream {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly topics: string[];
  readonly signals: string[];
  readonly autoReconnect: boolean;
  readonly maxReconnectAttempts: number;
  readonly timeout: number;

  private socket: AnySocket | null = null;
  private closed = false;

  constructor(options: StreamOptions = {}) {
    this.apiKey = (options.apiKey ?? readEnv('LIVETENNISAPI_KEY')).trim();
    this.baseUrl = (options.baseUrl ?? (readEnv('LIVETENNISAPI_BASE_URL') || DEFAULT_BASE_URL)).replace(/\/+$/, '');
    this.topics = options.topics?.length ? options.topics : ['live-scores'];
    this.signals = (options.signals ?? []).filter(Boolean);
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? 0);
    this.timeout = options.timeout ?? 30_000;
  }

  /**
   * The `wss://` endpoint, with the key as a query parameter.
   *
   * The key travels in the query string because the browser WebSocket API
   * cannot set headers on the handshake; the server accepts either. Over TLS
   * it is encrypted in transit, but it can still reach server logs — prefer a
   * scoped key for streaming.
   */
  get url(): string {
    const url = new URL(`${this.baseUrl}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.apiKey) url.searchParams.set('token', this.apiKey);
    return url.toString();
  }

  close(): void {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = null;
  }

  private static parse(data: unknown): Record<string, unknown> | null {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data as ArrayBufferView)) {
      text = new TextDecoder().decode(data as ArrayBufferView);
    } else if (data && typeof (data as { toString?: () => string }).toString === 'function') {
      text = String(data);
    } else return null;

    try {
      const frame = JSON.parse(text);
      return frame && typeof frame === 'object' ? (frame as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private static raiseFrameError(frame: Record<string, unknown>): never {
    const code = String(frame.error ?? 'error');
    const build = FATAL[code];
    if (build) throw build(`the live feed refused the connection: ${code}`);
    const hint = frame.hint ? ` — ${String(frame.hint)}` : '';
    throw new LiveTennisAPIError(`live feed error: ${code}${hint}`);
  }

  /**
   * Yield stream frames until the stream is closed.
   *
   * Score frames come as {@link ScoreUpdate}. When `signals` requested
   * `break_point`, break-point frames come as {@link BreakPoint} and
   * {@link BreakPointResult}. With no signals only {@link ScoreUpdate} is ever
   * yielded, exactly as before. Narrow on `frame.type`.
   */
  async *listen(): AsyncGenerator<StreamFrame, void, unknown> {
    const WebSocketImpl = await resolveWebSocket();
    let attempt = 0;

    while (!this.closed) {
      // Frames buffer between yields so a slow consumer cannot drop pushes.
      const queue: Record<string, unknown>[] = [];
      let notify: (() => void) | null = null;
      let finished: Error | null | undefined;

      const socket: AnySocket = new WebSocketImpl(this.url);
      this.socket = socket;
      let connectedAt: number | null = null;

      const on = (type: string, handler: (event: any) => void) => {
        if (typeof socket.addEventListener === 'function') socket.addEventListener(type, handler);
        else if (typeof socket.on === 'function') socket.on(type, handler);
      };

      const wake = () => {
        notify?.();
        notify = null;
      };

      on('message', (event: any) => {
        const frame = LiveScoreStream.parse(event?.data ?? event);
        if (frame) queue.push(frame);
        wake();
      });
      on('error', () => {
        finished = new APIConnectionError('live feed socket error');
        wake();
      });
      on('close', () => {
        finished ??= null;
        wake();
      });

      try {
        // Open, then subscribe immediately — the server enforces a deadline.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new APIConnectionError('timed out opening the live feed')),
            this.timeout,
          );
          on('open', () => {
            clearTimeout(timer);
            resolve();
          });
          on('error', () => {
            clearTimeout(timer);
            reject(new APIConnectionError('could not open the live feed'));
          });
        });

        // The server keys off `topics` (+ optional `signals`); `action` is
        // ignored but kept for forward compatibility.
        const subscribe: Record<string, unknown> = { action: 'subscribe', topics: this.topics };
        if (this.signals.length) subscribe.signals = this.signals;
        socket.send(JSON.stringify(subscribe));

        // Wait for the `subscribed` ack before yielding anything.
        const deadline = Date.now() + SUBSCRIBE_TIMEOUT_MS;
        let acked = false;
        while (!acked) {
          if (Date.now() > deadline) {
            throw new APIConnectionError('timed out waiting for the subscribe acknowledgement');
          }
          while (queue.length) {
            const frame = queue.shift()!;
            if (frame.type === 'subscribed') {
              acked = true;
              break;
            }
            if (frame.type === 'error') LiveScoreStream.raiseFrameError(frame);
          }
          if (acked) break;
          if (finished !== undefined) throw finished ?? new APIConnectionError('feed closed');
          await new Promise<void>((resolve) => {
            notify = resolve;
            setTimeout(resolve, 100);
          });
        }

        connectedAt = Date.now();

        for (;;) {
          while (queue.length) {
            const frame = queue.shift()!;
            if (frame.type === 'score') yield frame as ScoreUpdate;
            else if (frame.type === 'break_point') yield frame as BreakPoint;
            else if (frame.type === 'break_point_result') yield frame as BreakPointResult;
            else if (frame.type === 'error') LiveScoreStream.raiseFrameError(frame);
            // 'ping' and 'subscribed' are protocol noise.
          }
          if (this.closed) return;
          if (finished !== undefined) throw finished ?? new APIConnectionError('feed closed');
          await new Promise<void>((resolve) => {
            notify = resolve;
            setTimeout(resolve, 250);
          });
        }
      } catch (err) {
        if (
          err instanceof Unauthorized ||
          err instanceof UpgradeRequired ||
          err instanceof ServiceUnavailable
        ) {
          throw err; // reconnecting cannot fix any of these
        }
        if (!this.autoReconnect || this.closed) throw err;
      } finally {
        try {
          socket.close();
        } catch {
          /* already gone */
        }
        this.socket = null;
      }

      if (this.closed || !this.autoReconnect) return;

      // Only a connection that STAYED up resets the backoff. See
      // HEALTHY_UPTIME_MS: a server that accepts then immediately drops would
      // otherwise hold the delay at step one indefinitely.
      if (connectedAt !== null && Date.now() - connectedAt >= HEALTHY_UPTIME_MS) attempt = 0;

      attempt += 1;
      if (this.maxReconnectAttempts && attempt > this.maxReconnectAttempts) {
        throw new APIConnectionError(
          `live feed did not recover after ${this.maxReconnectAttempts} attempts`,
        );
      }
      await sleep(Math.min(500 * 2 ** Math.min(attempt, 6) + Math.random() * 1000, 30_000));
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<StreamFrame, void, unknown> {
    return this.listen();
  }
}
