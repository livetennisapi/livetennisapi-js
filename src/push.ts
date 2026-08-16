/**
 * Push-feed live-score client (Centrifugo). **ULTRA tier only.**
 *
 * ```ts
 * import { PushStream } from 'livetennisapi';
 *
 * const stream = new PushStream({ apiKey: 'twjp_…' });
 * for await (const update of stream) {
 *   if (update.type === 'score') console.log(update.match_id, update.score?.sets);
 * }
 * ```
 *
 * The second live transport, built for high fan-out: it mints a short-lived
 * connection token via `/ws-token`, speaks the (tiny) Centrifugo JSON client
 * protocol directly over the same WebSocket implementation the native feed
 * uses, and subscribes to `slate:all` (every live match — the default) or to
 * one channel per requested match id. **No `centrifuge-js` needed.**
 *
 * Publications carry EXACTLY the frames the native feed sends: score frames
 * nest their payload under `.score`, model fields (`win_probability_p1`,
 * `danger`) included. Today the subscribed score channels carry score frames
 * only — frames are dispatched by their `type`, so a new frame kind published
 * on a SUBSCRIBED channel arrives without a client update. New channel
 * FAMILIES are different: the point feed lives on its own channels
 * (`point:match:{id}` / `point:slate`) which this stream does not subscribe
 * by default — pass their names via the `channels` option to receive them.
 * Frames are complete-state and best-effort: a missed frame self-corrects on
 * the next one, so there is no client-side catch-up to do.
 *
 * Reconnects automatically with exponential backoff, minting a FRESH token on
 * every attempt (tokens expire with the connection and are never reused), then
 * re-connects and re-subscribes every channel. A silently-dead connection is
 * detected too: the server pings on an advertised cadence (~25s), and total
 * silence beyond ~2 cadences tears the socket down and reconnects. It does
 * **not** reconnect on a bad key, an insufficient tier, or the feed being
 * disabled — those surface as the SDK's normal exceptions from the mint,
 * exactly as the REST client would throw them — nor on an invalid connect
 * token, which the server reports by CLOSING the socket with code 3500/3501
 * and which surfaces as `Unauthorized`.
 *
 * Uses the platform `WebSocket` when present (Node 22+, Deno, Bun, browsers)
 * and falls back to the `ws` package on older Node.
 */

import { DEFAULT_BASE_URL, LiveTennisAPI, readEnv } from './client.js';
import {
  APIConnectionError,
  LiveTennisAPIError,
  ServiceUnavailable,
  Unauthorized,
  UpgradeRequired,
} from './errors.js';
import type { PushFrame, WsToken } from './types.js';
import { resolveWebSocket, type AnySocket } from './ws.js';

/** How long the connect + subscribe handshake may take before we give up. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Fallback server ping cadence, used when the connect reply does not advertise
 * one. Centrifugo sends an empty-object ping on a fixed interval (~25s) and
 * tells the client the interval in the connect reply (`connect.ping`,
 * seconds). Total silence for about two cadences plus slack means the socket
 * is dead — see the watchdog in `listen()`.
 */
const DEFAULT_PING_INTERVAL_MS = 25_000;

/**
 * How long the feed may be COMPLETELY silent (no publication, no ping) after
 * the handshake before the connection is presumed half-open and torn down. A
 * silently-dead socket (NAT reset, network path loss without a FIN) fires no
 * 'close' or 'error' event, so without this deadline the stream would hang
 * forever. Two missed pings plus slack: ~60s at the default 25s cadence.
 */
const silenceLimitMs = (pingIntervalMs: number) =>
  2 * pingIntervalMs + Math.min(pingIntervalMs, 10_000);

/**
 * How long a connection must stay up before it counts as healthy enough to
 * reset the backoff. Resetting on a successful subscribe alone lets a flapping
 * server (accept -> ack -> drop) pin the delay at step one forever, so the
 * backoff never grows and `maxReconnectAttempts` is never reached.
 */
const HEALTHY_UPTIME_MS = 60_000;

/**
 * Centrifugo reply-error codes that reconnecting can never resolve. 101 is an
 * authentication failure — and the token was minted seconds ago, so retrying
 * re-fails identically. 103 means the token does not grant the channel, which
 * a fresh token from the same key cannot fix either.
 */
const FATAL_REPLY_CODES: Record<number, (message: string) => LiveTennisAPIError> = {
  101: (m) => new Unauthorized(m, { status: 0 }),
  103: (m) => new UpgradeRequired(m, { status: 0, requiredTier: 'ULTRA' }),
};

/**
 * Map a terminal Centrifugo DISCONNECT to a fatal SDK error, or return null
 * for a transient close the reconnect loop should retry.
 *
 * A bad connect token never comes back as a reply error: the server CLOSES
 * the socket with code 3500 ("invalid token"; 3501 for a malformed/empty
 * one). A fresh mint from the same key re-fails identically, so reconnecting
 * cannot fix it — those are Unauthorized. The rest of the 3500–3999 range is
 * Centrifugo's "do not reconnect" advice band and is surfaced as
 * ServiceUnavailable instead of being retried forever.
 */
function fatalCloseError(code: number, reason: string): LiveTennisAPIError | null {
  if (code === 3500 || code === 3501) {
    return new Unauthorized(`the push feed rejected the connection token: ${code} ${reason}`, {
      status: 0,
    });
  }
  if (code >= 3500 && code < 4000) {
    return new ServiceUnavailable(`the push feed refused the connection: ${code} ${reason}`, {
      status: 0,
    });
  }
  return null;
}

export interface PushStreamOptions {
  apiKey?: string;
  baseUrl?: string;
  /**
   * Follow only these match ids. Omitted (the default) means the whole live
   * slate. Every id must be a finite number — an invalid id (`NaN`, say)
   * throws a `TypeError` instead of silently widening the subscription.
   */
  matches?: number[];
  /**
   * Extra channel names to subscribe, verbatim — the escape hatch for channel
   * families this SDK does not subscribe on its own (the point feed's
   * `point:slate` / `point:match:{id}` channels the mint grants to
   * `points`-entitled keys, say). Subscribed alongside the match channels, or
   * alone; the `slate:all` fallback applies only when neither option names a
   * channel.
   */
  channels?: string[];
  autoReconnect?: boolean;
  /** 0 means retry forever. */
  maxReconnectAttempts?: number;
  timeout?: number;
  /** Injectable for tests or a custom transport — used for the token mint. */
  fetch?: typeof globalThis.fetch;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class PushStream {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly matches: number[];
  readonly channels: string[];
  readonly autoReconnect: boolean;
  readonly maxReconnectAttempts: number;
  readonly timeout: number;

  private readonly client: LiveTennisAPI;
  private socket: AnySocket | null = null;
  private closed = false;

  constructor(options: PushStreamOptions = {}) {
    this.apiKey = (options.apiKey ?? readEnv('LIVETENNISAPI_KEY')).trim();
    this.baseUrl = (options.baseUrl ?? (readEnv('LIVETENNISAPI_BASE_URL') || DEFAULT_BASE_URL)).replace(/\/+$/, '');
    // Validate, never filter: silently dropping a bad id (NaN from a failed
    // parse, say) would widen a single-match request to the entire live slate.
    const matches = options.matches ?? [];
    for (const id of matches) {
      if (typeof id !== 'number' || !Number.isFinite(id)) {
        throw new TypeError(
          `matches must be finite match ids — got ${String(id)}. ` +
            'Omit the option to follow the whole live slate.',
        );
      }
    }
    this.matches = [...matches];
    this.channels = (options.channels ?? []).filter(Boolean);
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? 0);
    this.timeout = options.timeout ?? 30_000;

    // The mint rides the normal REST client, so an ULTRA-gate refusal, a bad
    // key or a disabled feed surface as the SDK's standard exceptions
    // (UpgradeRequired / Unauthorized / ServiceUnavailable), not homemade ones.
    this.client = new LiveTennisAPI({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      timeout: this.timeout,
      fetch: options.fetch,
    });
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

  /**
   * Mint a fresh connection token. Called before EVERY connection attempt —
   * tokens expire with the connection and must never be reused across
   * reconnects.
   */
  private async mint(): Promise<{ token: string; wsUrl: string; channels: WsToken['channels'] }> {
    const minted = await this.client.getWsToken();
    const token = typeof minted.token === 'string' ? minted.token : '';
    const wsUrl = typeof minted.ws_url === 'string' ? minted.ws_url : '';
    if (!token || !wsUrl) {
      throw new ServiceUnavailable('the ws-token mint returned no usable token — the push feed is not available', {
        status: 0,
        body: minted,
      });
    }
    return { token, wsUrl, channels: minted.channels };
  }

  /**
   * The channels to subscribe, from the mint's own channel vocabulary: one
   * channel per requested match id, plus any extra `channels` names verbatim,
   * or the whole live slate when neither was given. The server's templates win
   * over the hardcoded fallbacks so a renamed channel family never strands
   * this client.
   */
  private channelsFor(channels: WsToken['channels']): string[] {
    const names: string[] = [];
    if (this.matches.length) {
      const template = typeof channels?.match === 'string' ? channels.match : 'match:{match_id}';
      names.push(...this.matches.map((id) => template.replace(/\{[^{}]*\}/, String(id))));
    }
    names.push(...this.channels);
    if (!names.length) names.push(typeof channels?.slate === 'string' ? channels.slate : 'slate:all');
    return names;
  }

  /**
   * One WebSocket message may hold several newline-delimited JSON objects
   * (Centrifugo batches), so this returns a list — including the server ping,
   * which is an EMPTY object.
   */
  private static parseBatch(data: unknown): Record<string, unknown>[] {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data as ArrayBufferView)) {
      text = new TextDecoder().decode(data as ArrayBufferView);
    } else if (data && typeof (data as { toString?: () => string }).toString === 'function') {
      text = String(data);
    } else return [];

    const objects: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') objects.push(obj as Record<string, unknown>);
      } catch {
        /* not JSON — protocol noise */
      }
    }
    return objects;
  }

  private static raiseReplyError(op: string, error: Record<string, unknown>): never {
    const code = typeof error.code === 'number' ? error.code : -1;
    const message = `the push feed refused the ${op}: ${code} ${String(error.message ?? 'error')}`;
    const build = FATAL_REPLY_CODES[code];
    if (build) throw build(message);
    throw new LiveTennisAPIError(message);
  }

  /**
   * Yield push-feed publications until the stream is closed.
   *
   * Frames come as {@link PushFrame} — today always `score` frames, the exact
   * `ScoreUpdate` shape the native feed sends. Narrow on `frame.type`
   * and ignore kinds you do not handle.
   */
  async *listen(): AsyncGenerator<PushFrame, void, unknown> {
    const WebSocketImpl = await resolveWebSocket();
    let attempt = 0;

    while (!this.closed) {
      // Frames buffer between yields so a slow consumer cannot drop pushes.
      const queue: Record<string, unknown>[] = [];
      let notify: (() => void) | null = null;
      let finished: Error | null | undefined;
      let connectedAt: number | null = null;
      let socket: AnySocket | null = null;
      let lastSeenAt = Date.now();
      let pingIntervalMs = DEFAULT_PING_INTERVAL_MS;

      try {
        // A FRESH token for every attempt — the previous one died with its
        // connection. The mint's failures are the SDK's normal exceptions.
        const minted = await this.mint();
        const channels = this.channelsFor(minted.channels);

        const ws: AnySocket = new WebSocketImpl(minted.wsUrl);
        socket = ws;
        this.socket = ws;

        const on = (type: string, handler: (event: any) => void) => {
          if (typeof ws.addEventListener === 'function') ws.addEventListener(type, handler);
          else if (typeof ws.on === 'function') ws.on(type, handler);
        };

        const wake = () => {
          notify?.();
          notify = null;
        };

        on('message', (event: any) => {
          lastSeenAt = Date.now(); // any traffic — the server ping included — proves liveness
          for (const obj of PushStream.parseBatch(event?.data ?? event)) {
            // The server ping is an empty object; reply {} promptly or the
            // server disconnects us. Never surfaces to the consumer.
            if (Object.keys(obj).length === 0) {
              try {
                ws.send('{}');
              } catch {
                /* racing a close */
              }
              continue;
            }
            queue.push(obj);
          }
          wake();
        });
        on('error', () => {
          finished = new APIConnectionError('push feed socket error');
          wake();
        });
        on('close', (event: any, closeReason?: any) => {
          // Platform WebSocket delivers a CloseEvent; the `ws` package calls
          // back with (code, reason). Normalize both, then classify: an
          // auth-class close (3500/3501) is fatal, a routine drop is not.
          const code =
            typeof event === 'number' ? event : typeof event?.code === 'number' ? event.code : 0;
          const reason = String((typeof event === 'number' ? closeReason : event?.reason) ?? '');
          finished ??= fatalCloseError(code, reason || 'connection closed');
          wake();
        });

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new APIConnectionError('timed out opening the push feed')),
            this.timeout,
          );
          on('open', () => {
            clearTimeout(timer);
            resolve();
          });
          on('error', () => {
            clearTimeout(timer);
            reject(new APIConnectionError('could not open the push feed'));
          });
        });

        // Handshake: connect with the token, then one subscribe per channel
        // once the connect is acked. Replies are matched by id; an `error`
        // reply raises instead of acking.
        ws.send(JSON.stringify({ connect: { token: minted.token }, id: 1 }));
        const pending = new Map<number, string>([[1, 'connect']]);
        let nextId = 2;
        const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;

        for (;;) {
          while (queue.length) {
            const obj = queue.shift()!;

            if (typeof obj.id === 'number' && pending.has(obj.id)) {
              const op = pending.get(obj.id)!;
              pending.delete(obj.id);
              if (obj.error && typeof obj.error === 'object') {
                PushStream.raiseReplyError(op, obj.error as Record<string, unknown>);
              }
              if (op === 'connect') {
                // The connect reply advertises the server's ping cadence in
                // seconds; the watchdog below scales its deadline from it.
                const connectInfo = obj.connect as Record<string, unknown> | undefined;
                const ping = typeof connectInfo?.ping === 'number' ? connectInfo.ping : 0;
                if (ping > 0) pingIntervalMs = ping * 1000;
                for (const channel of channels) {
                  pending.set(nextId, `subscribe to ${channel}`);
                  ws.send(JSON.stringify({ subscribe: { channel }, id: nextId }));
                  nextId += 1;
                }
              }
              continue;
            }

            // A publication: {"push": {"channel": …, "pub": {"data": <frame>}}}.
            // Dispatched by the frame's own `type` — score today, anything the
            // channel may carry tomorrow. Everything else is protocol noise.
            const push = obj.push as Record<string, unknown> | undefined;
            const pub = push?.pub as Record<string, unknown> | undefined;
            const frame = pub?.data;
            if (frame && typeof frame === 'object' && typeof (frame as PushFrame).type === 'string') {
              yield frame as PushFrame;
            }
          }

          if (this.closed) return;
          if (finished !== undefined) throw finished ?? new APIConnectionError('push feed closed');
          if (pending.size) {
            if (Date.now() > deadline) {
              throw new APIConnectionError('timed out waiting for the push feed to acknowledge the subscription');
            }
          } else if (connectedAt === null) {
            connectedAt = Date.now();
          }
          // Dead-connection watchdog: a half-open socket fires no 'close' or
          // 'error' event, but the server pings on a fixed advertised cadence,
          // so total post-handshake silence beyond ~2 cadences + slack means
          // the connection is dead. Throwing hands control to the reconnect
          // machinery (the finally closes the socket, a fresh token is minted).
          if (!pending.size && Date.now() - lastSeenAt > silenceLimitMs(pingIntervalMs)) {
            throw new APIConnectionError(
              'push feed went silent (no server ping) — connection presumed dead',
            );
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
            setTimeout(resolve, pending.size ? 100 : 250);
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
          socket?.close();
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
          `push feed did not recover after ${this.maxReconnectAttempts} attempts`,
        );
      }
      await sleep(Math.min(500 * 2 ** Math.min(attempt, 6) + Math.random() * 1000, 30_000));
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<PushFrame, void, unknown> {
    return this.listen();
  }
}
