import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/**
 * The DSH wire, as the browser speaks it (verified against the Rowel Bridle's
 * working client, `@rowel/bridle/lib/dsh/{auth,client,remote-mux}.js`):
 *
 * - unary: `POST /api/<endpoint>` carrying `{ type: "client-request", rpcId,
 *   method, payload: { args } }`, answered `{ type: "server-response", result }`
 *   where `result` is `{ ok: true, value }` or `{ ok: false, error }`;
 * - streams: every logical stream rides one `/api/remote.mux` WebSocket,
 *   framed `open` / `item` / `end` / `cancel` up and `item` / `end` / `error`
 *   down, all keyed by a client-chosen `streamId`.
 *
 * Nothing here touches a non-loopback address: the host is a child process we
 * started ourselves, and its launch token must never cross the network.
 */

/** The failure branch of a dsh result: plain JSON, as it crosses the wire. */
export interface DshFailure {
  code: string;
  message: string;
  details: unknown;
}

/** A failure the provider raises itself (or re-raises from a dsh result). */
export class DshError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, code: string, details: unknown = {}) {
    super(message);
    this.name = "DshError";
    this.code = code;
    this.details = details;
  }
}

export type DshResult = { ok: true; value: unknown } | { ok: false; error: DshFailure };

export interface StreamSink {
  item: (value: unknown) => void;
  end: () => void;
  error: (error: DshFailure) => void;
}

export interface StreamHandle {
  item: (value: unknown) => void;
  end: () => void;
  cancel: () => void;
}

export interface MuxState {
  connected: boolean;
  detail?: string;
}

/** What a caller gets back from one unary endpoint. Never throws for carrier trouble. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MUX_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;

let rpcCounter = 0;

function nextRpcId(): string {
  rpcCounter += 1;
  return `paseo-${String(process.pid)}-${String(rpcCounter)}`;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const chain: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current instanceof Error && depth < 4) {
    if (chain.at(-1) !== current.message) chain.push(current.message);
    current = current.cause;
    depth += 1;
  }
  return chain.join(": ");
}

function asDshError(raw: unknown): DshFailure {
  const value = raw as { code?: unknown; message?: unknown; details?: unknown } | null;
  return {
    code: typeof value?.code === "string" ? value.code : "internal",
    message: typeof value?.message === "string" ? value.message : "dsh failed the call",
    details: value?.details ?? {},
  };
}

/**
 * One loopback DSH host's wire: unary calls plus the shared stream socket.
 * The cookie is set after the launch-token exchange; a 401 drops it so the
 * owner can re-exchange rather than hammering a dead credential.
 */
export class DshWire {
  readonly base: URL;
  private cookie: string | undefined;
  private readonly mux: Mux;
  private requestTimeoutMs: number;

  constructor(baseUrl: string, options: { requestTimeoutMs?: number } = {}) {
    this.base = new URL(baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.mux = new Mux(this.base);
  }

  setCookie(cookie: string | undefined): void {
    this.cookie = cookie;
    this.mux.setCookie(cookie);
  }

  get hasCookie(): boolean {
    return this.cookie !== undefined;
  }

  start(): void {
    this.mux.start();
  }

  stop(): void {
    this.mux.stop();
  }

  get connection(): MuxState {
    return this.mux.state;
  }

  onConnection(listener: (state: MuxState) => void): () => void {
    return this.mux.onState(listener);
  }

  /** Invoke one endpoint; carrier failures fold into the error branch. */
  async call(endpoint: string, args: unknown, signal?: AbortSignal): Promise<DshResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`dsh did not answer ${endpoint} in ${String(this.requestTimeoutMs)}ms`),
      );
    }, this.requestTimeoutMs);
    timeout.unref?.();
    const abort = (): void => {
      controller.abort(signal?.reason);
    };
    if (signal !== undefined) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.cookie !== undefined) headers.cookie = this.cookie;
      const response = await fetch(new URL(`/api/${endpoint}`, this.base), {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "client-request",
          rpcId: nextRpcId(),
          method: endpoint,
          payload: { args },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401) this.cookie = undefined;
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          error: {
            code: response.status === 401 ? "unauthorized" : "carrier",
            message: `dsh answered HTTP ${String(response.status)} for ${endpoint}${text === "" ? "" : `: ${text.slice(0, 400)}`}`,
            details: {},
          },
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "carrier",
            message: `${endpoint}: malformed response (${describe(error)})`,
            details: {},
          },
        };
      }
      const envelope = body as { type?: unknown; result?: unknown };
      if (envelope.type !== "server-response" || envelope.result === undefined) {
        return {
          ok: false,
          error: {
            code: "carrier",
            message: `${endpoint}: dsh returned a malformed envelope`,
            details: {},
          },
        };
      }
      return envelope.result as DshResult;
    } catch (error) {
      const code = signal?.aborted === true ? "cancelled" : "carrier";
      return {
        ok: false,
        error: { code, message: `${endpoint}: ${describe(error)}`, details: {} },
      };
    } finally {
      clearTimeout(timeout);
      if (signal !== undefined) signal.removeEventListener("abort", abort);
    }
  }

  open(endpoint: string, args: unknown, sink: StreamSink): StreamHandle {
    return this.mux.open(endpoint, args, sink);
  }
}

/**
 * The one connection every stream shares. A dropped socket ends every stream on
 * it — dsh has no stream-level resumption — so each sink is told
 * `upstream-lost` and the session layer reopens its follow stream on a fresh
 * socket and gets a fresh baseline.
 */
class Mux {
  private readonly base: URL;
  private socket: WebSocketClient | undefined;
  private cookie: string | undefined;
  private readonly streams = new Map<string, StreamSink>();
  private readonly listeners = new Set<(state: MuxState) => void>();
  private current: MuxState = { connected: false, detail: "not started" };
  private counter = 0;
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  constructor(base: URL) {
    this.base = base;
  }

  setCookie(cookie: string | undefined): void {
    this.cookie = cookie;
    if (this.socket !== undefined) {
      // A fresh cookie needs a fresh handshake; the redial loop reconnects.
      this.socket.close();
    }
  }

  get state(): MuxState {
    return this.current;
  }

  onState(listener: (state: MuxState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.failAll("the connection to dsh was closed");
    this.publish({ connected: false, detail: "stopped" });
  }

  open(endpoint: string, args: unknown, sink: StreamSink): StreamHandle {
    const socket = this.socket;
    if (socket === undefined || !socket.isOpen || !this.current.connected) {
      queueMicrotask(() => {
        sink.error({
          code: "upstream-lost",
          message: `dsh is not connected (${this.current.detail ?? "reconnecting"})`,
          details: {},
        });
      });
      return { item: () => {}, end: () => {}, cancel: () => {} };
    }
    this.counter += 1;
    const streamId = `p${String(this.counter)}`;
    this.streams.set(streamId, sink);
    socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    return {
      item: (value) => {
        if (this.streams.has(streamId))
          socket.send(JSON.stringify({ type: "item", streamId, value }));
      },
      end: () => {
        if (this.streams.has(streamId)) socket.send(JSON.stringify({ type: "end", streamId }));
      },
      cancel: () => {
        if (!this.streams.delete(streamId)) return;
        socket.send(JSON.stringify({ type: "cancel", streamId }));
      },
    };
  }

  private dial(): void {
    if (this.stopped) return;
    const address = new URL("/api/remote.mux", this.base);
    address.protocol = "ws:";
    const socket = new WebSocketClient(address, this.cookie);
    this.socket = socket;
    let refusal: string | undefined;
    socket.on("open", () => {
      this.attempt = 0;
      this.publish({ connected: true });
    });
    socket.on("message", (text: string) => {
      this.deliver(text);
    });
    socket.on("refused", (status: number) => {
      refusal =
        status === 401
          ? "dsh refused the stream socket (HTTP 401) — the launch cookie is stale"
          : `dsh refused the stream socket (HTTP ${String(status)})`;
    });
    socket.on("error", (error: Error) => {
      refusal ??= error.message;
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.failAll("the connection to dsh dropped");
      this.publish({ connected: false, detail: refusal ?? "the connection to dsh dropped" });
      this.scheduleRedial();
    });
  }

  private scheduleRedial(): void {
    if (this.stopped) return;
    const ceiling = MUX_BACKOFF_MS[Math.min(this.attempt, MUX_BACKOFF_MS.length - 1)] ?? 10_000;
    this.attempt += 1;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.dial();
      },
      ceiling * (0.5 + Math.random() * 0.5),
    );
    this.timer.unref?.();
  }

  private deliver(text: string): void {
    let frame: { type?: unknown; streamId?: unknown; value?: unknown; error?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame.streamId !== "string") return;
    const sink = this.streams.get(frame.streamId);
    if (sink === undefined) return;
    switch (frame.type) {
      case "item":
        sink.item(frame.value);
        return;
      case "end":
        this.streams.delete(frame.streamId);
        sink.end();
        return;
      case "error":
        this.streams.delete(frame.streamId);
        sink.error(asDshError(frame.error));
        return;
      default:
        return;
    }
  }

  private failAll(why: string): void {
    const sinks = [...this.streams.values()];
    this.streams.clear();
    for (const sink of sinks) {
      try {
        sink.error({ code: "upstream-lost", message: why, details: {} });
      } catch {
        // One opener's failure must not keep the rest from hearing.
      }
    }
  }

  private publish(next: MuxState): void {
    if (next.connected === this.current.connected && next.detail === this.current.detail) return;
    this.current = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // A listener that throws is not the transport's problem.
      }
    }
  }
}

/**
 * A minimal RFC 6455 client, hand-rolled because the daemon's plugin runtime
 * provides no `ws` package and the handshake needs a `Cookie` header, which the
 * WHATWG WebSocket API cannot send. Text frames only; DSH speaks JSON.
 */
class WebSocketClient extends EventEmitter {
  readonly url: URL;
  private readonly cookie: string | undefined;
  private socket: Socket | undefined;
  private open = false;
  private closed = false;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];

  constructor(url: URL, cookie: string | undefined) {
    super();
    this.url = url;
    this.cookie = cookie;
    this.connect();
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(text: string): void {
    if (!this.open || this.socket === undefined) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    if (this.socket !== undefined) {
      try {
        this.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
      } catch {
        // The socket is already gone; closing the handle below is what matters.
      }
      this.socket.destroy();
      this.socket = undefined;
    }
    this.emit("close");
  }

  private connect(): void {
    const key = randomBytes(16).toString("base64");
    const request = httpRequest({
      host: this.url.hostname,
      port: this.url.port === "" ? 80 : Number(this.url.port),
      path: `${this.url.pathname}${this.url.search}`,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        ...(this.cookie === undefined ? {} : { Cookie: this.cookie }),
      },
    });
    request.on("upgrade", (response: IncomingMessage, socket: Socket, head: Buffer) => {
      if (response.statusCode !== 101) {
        this.emit("refused", response.statusCode ?? 0);
        socket.destroy();
        this.close();
        return;
      }
      const accept = response.headers["sec-websocket-accept"];
      const expected = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      if (accept !== expected) {
        this.emit(
          "error",
          new Error("dsh answered a WebSocket handshake with the wrong accept key"),
        );
        socket.destroy();
        this.close();
        return;
      }
      this.socket = socket;
      this.open = true;
      socket.setNoDelay(true);
      if (head.length > 0) this.consume(head);
      socket.on("data", (chunk: Buffer) => {
        this.consume(chunk);
      });
      socket.on("error", (error: Error) => {
        this.emit("error", error);
      });
      socket.on("close", () => {
        this.close();
      });
      this.emit("open");
    });
    request.on("response", (response: IncomingMessage) => {
      this.emit("refused", response.statusCode ?? 0);
      response.resume();
      this.close();
    });
    request.on("error", (error: Error) => {
      this.emit("error", error);
      this.close();
    });
    request.end();
  }

  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = decodeFrame(this.buffer);
      if (parsed === undefined) return;
      this.buffer = this.buffer.subarray(parsed.consumed);
      const frame = parsed.frame;
      if (frame.opcode === 0x9) {
        // Ping: answer with the same payload, as RFC 6455 requires.
        this.socket?.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x2) continue;
      if (frame.opcode === 0x0) {
        this.fragments.push(frame.payload);
      } else {
        this.fragments = [frame.payload];
      }
      if (!frame.fin) continue;
      const text = Buffer.concat(this.fragments).toString("utf8");
      this.fragments = [];
      this.emit("message", text);
    }
  }
}

interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

function decodeFrame(buffer: Buffer): { frame: DecodedFrame; consumed: number } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    length = Number(big);
    offset += 8;
  }
  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;
  let payload = buffer.subarray(offset, offset + length);
  if (mask !== undefined) {
    payload = Buffer.from(payload);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  }
  return { frame: { fin, opcode, payload }, consumed: offset + length };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = (masked[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  let header: Buffer;
  if (masked.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | masked.length]);
  } else if (masked.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(masked.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(masked.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}
