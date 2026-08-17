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
 * FAMILIES are different: they must be subscribed by name. The point feed
 * (its own `point:match:{id}` / `point:slate` channels) is built in — pass
 * `points: true` and the stream subscribes it from the mint's own advertised
 * vocabulary, refusing loudly (`ServiceUnavailable`) when the mint does not
 * grant it; the `channels` option remains the verbatim escape hatch for
 * families newer than this SDK.
 *
 * Score frames are complete-state and best-effort: a missed frame
 * self-corrects on the next one, so there is no catch-up to do. POINT frames
 * are events — a missed frame is a missed point — so with `points: true` the
 * stream keeps a per-match `seq` cursor and (by default, `pointsResume`)
 * catches up over REST on every (re)connect, dedups replays, and back-fills
 * mid-stream gaps before yielding the frame that revealed them.
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
  NotFound,
  ServiceUnavailable,
  Unauthorized,
  UpgradeRequired,
} from './errors.js';
import type { PointUpdate, PushFrame, WsToken } from './types.js';
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
   * families newer than this SDK. Subscribed alongside the match channels, or
   * alone; the `slate:all` fallback applies only when neither option names a
   * channel. (For the point feed, prefer `points: true`, which resolves the
   * channel names from the mint's own vocabulary and adds resume/dedup.)
   */
  channels?: string[];
  /**
   * Also subscribe the live point feed: `point:match:{id}` per requested
   * match, or the whole point slate when no `matches` were named — resolved
   * from the `/ws-token` mint's OWN advertised vocabulary, never guessed.
   * When the mint does not advertise the point channels the stream throws
   * `ServiceUnavailable` instead of subscribing blind: an unadvertised
   * vocabulary is the server's honest refusal (the point gate is off, or the
   * plan does not include points), not something a retry can fix.
   *
   * Point frames arrive as {@link PointUpdate} — payload nested under
   * `.point`, with the per-match monotonic gapless `seq`.
   */
  points?: boolean;
  /**
   * With `points: true` (default **true**): repair the point feed's only
   * structural weakness — unlike score frames, point frames are events, so a
   * missed frame is a missed point. The stream keeps a per-match last-`seq`
   * cursor; on every (re)connect it catches up over REST
   * (`getMatchPoints({ after_seq })`) and yields the fetched points BEFORE
   * any live frame, drops duplicates (`seq` at or below the cursor), and
   * back-fills a mid-stream gap (`seq` jumping past `cursor + 1`) over REST
   * before yielding the frame that revealed it. The first frame of a match
   * the stream has not seen before triggers a back-fill from the start of
   * the match (`seq` 1), and is not reported as a gap.
   *
   * **Slate caveat:** cursors exist per MATCH, so on the point slate a
   * reconnect can only catch up matches the stream had already seen before
   * the drop — a match that went live entirely inside the outage is caught
   * up only when its first live frame arrives (the new-match back-fill
   * above). Joining a busy slate mid-play therefore costs one REST
   * back-fill per in-progress match; follow specific `matches` when that
   * matters. Set `false` to take the raw frames with no REST traffic.
   */
  pointsResume?: boolean;
  /**
   * With `points: true` and resume on: called when a live point frame
   * reveals a mid-stream gap — `expectedSeq` is `cursor + 1`, `gotSeq` the
   * frame's `seq`. The gap is already being repaired over REST when this
   * fires; the callback is observability, not a request to act.
   */
  onGap?: (matchId: number, expectedSeq: number, gotSeq: number) => void;
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
  readonly points: boolean;
  readonly pointsResume: boolean;
  readonly autoReconnect: boolean;
  readonly maxReconnectAttempts: number;
  readonly timeout: number;

  private readonly client: LiveTennisAPI;
  private readonly onGap?: (matchId: number, expectedSeq: number, gotSeq: number) => void;
  /**
   * Per-match last-seen `point.seq` — the resume/dedup state, deliberately an
   * instance field so it SURVIVES reconnects: the whole job of the cursor is
   * to say where the previous connection left off.
   */
  private readonly cursors = new Map<number, number>();
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
    this.points = options.points ?? false;
    this.pointsResume = this.points && (options.pointsResume ?? true);
    this.onGap = options.onGap;
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
   * or the whole live slate when neither was given — plus, with
   * `points: true`, the point channels. The server's templates win over the
   * hardcoded fallbacks so a renamed channel family never strands this client.
   */
  private channelsFor(channels: WsToken['channels']): string[] {
    const names: string[] = [];
    if (this.matches.length) {
      const template = typeof channels?.match === 'string' ? channels.match : 'match:{match_id}';
      names.push(...this.matches.map((id) => template.replace(/\{[^{}]*\}/, String(id))));
    }
    names.push(...this.channels);
    if (!names.length) names.push(typeof channels?.slate === 'string' ? channels.slate : 'slate:all');
    if (this.points) names.push(...this.pointChannelsFor(channels));
    // Dedupe: subscribing one channel twice on a single connection (a
    // duplicated match id, or `points: true` combined with the legacy
    // `channels: ['point:slate']` escape hatch) is a server-side reply ERROR
    // (already subscribed), which would put the stream into reconnect churn.
    return [...new Set(names)];
  }

  /**
   * The point channels, resolved ONLY from the mint's advertised vocabulary —
   * there is deliberately no hardcoded fallback here. A mint that does not
   * advertise `point_match` / `point_slate` is the server's honest refusal:
   * the point gate is off, or the plan does not include points. Subscribing a
   * guessed name would turn that refusal into a silent empty feed, so refuse
   * loudly instead — and fatally, because a fresh mint from the same key
   * re-fails identically (this is not a retry case).
   */
  private pointChannelsFor(channels: WsToken['channels']): string[] {
    const template = typeof channels?.point_match === 'string' ? channels.point_match : undefined;
    const slate = typeof channels?.point_slate === 'string' ? channels.point_slate : undefined;
    const wanted = this.matches.length ? template : slate;
    if (!wanted) {
      throw new ServiceUnavailable(
        'points: true, but the ws-token mint did not advertise the point channels — ' +
          'the point feed is not available to this key (the server has the point feed ' +
          'disabled, or the plan does not include points)',
        { status: 0 },
      );
    }
    if (this.matches.length) {
      return this.matches.map((id) => wanted.replace(/\{[^{}]*\}/, String(id)));
    }
    return [wanted];
  }

  /**
   * Fetch committed points over REST and yield them as {@link PointUpdate}
   * frames, advancing the match's cursor as it goes. `beforeSeq` bounds a
   * gap fill: the frame that revealed the gap will yield itself, so nothing
   * at or past its `seq` is yielded from REST.
   */
  private async *fetchPoints(
    matchId: number,
    beforeSeq?: number,
  ): AsyncGenerator<PushFrame, void, unknown> {
    let cursor = this.cursors.get(matchId) ?? 0;
    for (;;) {
      const page = await this.client.getMatchPoints(matchId, { after_seq: cursor });
      for (const point of page.points ?? []) {
        const seq = typeof point.seq === 'number' ? point.seq : undefined;
        if (seq === undefined) continue;
        if (seq <= (this.cursors.get(matchId) ?? 0)) continue; // already yielded
        if (beforeSeq !== undefined && seq >= beforeSeq) continue; // the trigger frame yields itself
        this.cursors.set(matchId, seq);
        const frame: PointUpdate = {
          type: 'point',
          match_id: matchId,
          point,
          pbp_coverage: page.pbp_coverage,
          quality: page.quality,
        };
        yield frame as PushFrame;
      }
      if (!page.has_more) return;
      // The server's own cursor drives the walk; a cursor that fails to
      // advance would refetch the same page forever.
      if (typeof page.last_seq !== 'number' || page.last_seq <= cursor) return;
      cursor = page.last_seq;
      if (beforeSeq !== undefined && cursor >= beforeSeq - 1) return; // gap fully covered
    }
  }

  /**
   * The post-(re)connect catch-up: replay, over REST, every point committed
   * past each known cursor — BEFORE any live frame from the new connection is
   * processed, so the consumer sees points in `seq` order across the outage.
   * Only matches with a cursor are caught up (see the slate caveat on
   * `pointsResume`); a match first seen on the new connection back-fills when
   * its first frame arrives.
   */
  private async *catchUp(): AsyncGenerator<PushFrame, void, unknown> {
    for (const matchId of [...this.cursors.keys()]) {
      try {
        yield* this.fetchPoints(matchId);
      } catch (err) {
        // A match that has aged out of the live window answers 404. That is
        // permanent for THIS match and says nothing about the others: drop
        // its cursor (nothing more can ever arrive for it) and move on.
        // Without this, one vanished match wedges the stream forever — the
        // NotFound aborts the connection, the reconnect re-runs catch-up on
        // the same cursors, and the identical 404 fires again before any
        // frame is ever delivered. Everything else still propagates.
        if (!(err instanceof NotFound)) throw err;
        this.cursors.delete(matchId);
      }
    }
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
   * Frames come as {@link PushFrame} — `score` frames (the exact
   * `ScoreUpdate` shape the native feed sends) and, with `points: true`,
   * `point` frames ({@link PointUpdate}), including the REST-fetched ones the
   * resume machinery replays after an outage. Narrow on `frame.type` and
   * ignore kinds you do not handle.
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
      // Point-feed catch-up runs once per CONNECTION, right after the last
      // subscribe ack — the cursors themselves live on the instance.
      let caughtUp = !this.pointsResume;

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
              if (!pending.size && !caughtUp) {
                // Every subscribe is acked: replay the points the outage
                // swallowed BEFORE any live frame — live publications keep
                // buffering in the queue while this awaits, and the dedup
                // below drops whatever the catch-up already covered.
                caughtUp = true;
                yield* this.catchUp();
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
              if (this.pointsResume && (frame as PushFrame).type === 'point') {
                const update = frame as PointUpdate;
                const matchId = typeof update.match_id === 'number' ? update.match_id : undefined;
                const seq = typeof update.point?.seq === 'number' ? update.point.seq : undefined;
                if (matchId !== undefined && seq !== undefined) {
                  const known = this.cursors.has(matchId);
                  const cursor = this.cursors.get(matchId) ?? 0;
                  // seq is gapless per match, so the cursor decides everything:
                  // at or below it is a duplicate (catch-up already yielded
                  // it); past cursor+1 is a hole, repaired over REST BEFORE
                  // the frame that revealed it. The opening back-fill of a
                  // match seen for the first time is normal operation, not a
                  // reportable gap.
                  if (seq <= cursor) continue;
                  if (seq > cursor + 1) {
                    if (known) this.onGap?.(matchId, cursor + 1, seq);
                    yield* this.fetchPoints(matchId, seq);
                  }
                  this.cursors.set(matchId, seq);
                }
              }
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
