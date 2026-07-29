/**
 * Minimal ioBroker Admin websocket client.
 *
 * Implements the wire protocol verified against a live Admin 7.6.17 instance:
 * frames are JSON arrays `[type, id, name, args]` with type 0=message, 1=ping,
 * 2=pong, 3=callback. The server sends `[0, null, "___ready___"]` once the
 * connection is usable; until then commands must not be sent.
 *
 * Uses the `ws` npm package rather than Node's built-in WebSocket: Node 22's
 * built-in (undici) WebSocket has been observed to infinite-loop
 * (`RangeError: Maximum call stack size exceeded`) on connection errors
 * against this server, and `ws` is required anyway to set a Cookie header
 * for authenticated instances.
 */

import WebSocket from 'ws';
import {
  IoBrokerObject,
  LogHandler,
  LogMessage,
  ObjectChangeHandler,
  SocketClient,
  SocketOptions,
  UserError,
} from '../types';

const READY_MESSAGE = '___ready___';
const OBJECT_CHANGE = 'objectChange';
const LOG_MESSAGE = 'log';
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const CLIENT_NAME = 'iobroker-sync';

type Frame = [number, number | null, string?, unknown?];

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SubscriptionEntry {
  handler: ObjectChangeHandler;
  regex: RegExp;
}

/** Turns an ioBroker `*`-wildcard pattern into an anchored RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function toWebSocketUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new UserError(`Invalid Admin URL: "${baseUrl}"`, 'Check the "url" field in your config file.');
  }
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const sid = Date.now();
  return `${wsProtocol}//${parsed.host}/?sid=${sid}&name=${encodeURIComponent(CLIENT_NAME)}`;
}

export class AdminSocketClient implements SocketClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private idCounter = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Map<string, SubscriptionEntry[]>();
  private readonly logHandlers: LogHandler[] = [];
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private connectPromise: Promise<void> | null = null;
  private userClosed = false;

  constructor(private readonly options: SocketOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.ready && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.userClosed = false;
    const wsUrl = toWebSocketUrl(this.options.url);
    const wsOptions: WebSocket.ClientOptions = {};
    if (this.options.cookie) {
      wsOptions.headers = { Cookie: this.options.cookie };
    }
    if (this.options.allowSelfSigned) {
      wsOptions.rejectUnauthorized = false;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl, wsOptions);
      this.ws = ws;

      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        ws.terminate();
        reject(
          new UserError(
            `Timed out waiting for ioBroker Admin to become ready (${this.connectTimeoutMs}ms).`,
            'Check that the Admin instance is running and reachable at ' + this.options.url,
          ),
        );
      }, this.connectTimeoutMs);

      ws.on('open', () => {
        // The socket is open, but not usable until ___ready___ arrives.
      });

      ws.on('message', (data: WebSocket.RawData) => {
        let frame: Frame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        const [type, id, name, args] = frame;

        if (type === 1) {
          // Ping -> must reply with a pong or the server drops the connection.
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify([2]));
          }
          return;
        }

        if (type === 3) {
          if (typeof id === 'number') {
            this.handleCallback(id, args as unknown[] | undefined);
          }
          return;
        }

        if (type === 0) {
          if (name === READY_MESSAGE) {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              this.ready = true;
              resolve();
            }
            return;
          }
          if (name === OBJECT_CHANGE) {
            const [objId, obj] = (args as [string, IoBrokerObject | null]) ?? [undefined, undefined];
            if (typeof objId === 'string') {
              this.dispatchObjectChange(objId, obj ?? null);
            }
            return;
          }
          if (name === LOG_MESSAGE) {
            const [entry] = (args as [LogMessage | undefined]) ?? [undefined];
            if (entry && typeof entry.message === 'string') {
              this.dispatchLog(entry);
            }
          }
        }
      });

      ws.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          this.connectPromise = null;
          reject(
            new UserError(
              `Could not connect to ioBroker Admin at ${this.options.url}: ${err.message}`,
              'Check the URL/port and that the Admin instance is reachable.',
            ),
          );
          return;
        }
        // Post-connect error: fail any in-flight requests; no auto-reconnect.
        // Clearing connectPromise is essential — otherwise a later connect() would
        // hand back this already-resolved promise and report a dead socket as connected.
        this.ready = false;
        this.connectPromise = null;
        this.failAll(new UserError(`ioBroker Admin connection error: ${err.message}`));
      });

      ws.on('close', () => {
        this.ready = false;
        clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(
            new UserError(
              `Connection to ioBroker Admin closed before it became ready.`,
              'Check credentials/auth cookie and that the Admin instance is reachable at ' + this.options.url,
            ),
          );
          return;
        }
        // Same reasoning as the error handler: a resolved connectPromise must not
        // outlive the socket it represents, or reconnection silently no-ops.
        this.connectPromise = null;
        if (!this.userClosed) {
          this.failAll(new UserError('Connection to ioBroker Admin was closed unexpectedly.'));
        }
      });
    });

    return this.connectPromise;
  }

  close(): Promise<void> {
    this.userClosed = true;
    this.failAll(new UserError('Connection closed.'));

    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.ready = false;
      this.connectPromise = null;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const finish = () => {
        this.ready = false;
        this.connectPromise = null;
        resolve();
      };
      ws.once('close', finish);
      if (ws.readyState === WebSocket.CLOSING) {
        return;
      }
      try {
        ws.close();
      } catch {
        finish();
      }
    });
  }

  emit<T = unknown>(command: string, args: unknown[] = []): Promise<T> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new UserError('Not connected to ioBroker Admin.'));
    }
    const ws = this.ws;
    const id = ++this.idCounter;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UserError(`Request "${command}" timed out after ${this.requestTimeoutMs}ms.`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify([3, id, command, args]));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new UserError(`Failed to send "${command}": ${(err as Error).message}`));
      }
    });
  }

  async subscribeObjects(pattern: string, handler: ObjectChangeHandler): Promise<void> {
    const entry: SubscriptionEntry = { handler, regex: patternToRegExp(pattern) };
    const list = this.subscriptions.get(pattern);
    if (list) {
      list.push(entry);
    } else {
      this.subscriptions.set(pattern, [entry]);
    }
    await this.emit('subscribeObjects', [pattern]);
  }

  async unsubscribeObjects(pattern: string): Promise<void> {
    this.subscriptions.delete(pattern);
    await this.emit('unsubscribeObjects', [pattern]);
  }

  /**
   * Subscribes to the server log stream.
   *
   * The wire command is the generic `subscribe` with the literal type `log` — not a
   * `subscribeLog` of its own. Server-side that flips `requireLog(true)` on the
   * adapter, after which log lines arrive as ordinary `[0, null, "log", [entry]]`
   * message frames.
   */
  async subscribeLog(handler: LogHandler): Promise<void> {
    this.logHandlers.push(handler);
    await this.emit('subscribe', ['log']);
  }

  async unsubscribeLog(): Promise<void> {
    this.logHandlers.length = 0;
    await this.emit('unsubscribe', ['log']);
  }

  private handleCallback(id: number, args: unknown[] | undefined): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);

    const [err, result] = args ?? [];
    if (err !== null && err !== undefined && err !== false) {
      const message = typeof err === 'string' ? err : JSON.stringify(err);
      pending.reject(new UserError(`ioBroker Admin returned an error: ${message}`));
      return;
    }
    pending.resolve(result);
  }

  private dispatchLog(entry: LogMessage): void {
    for (const handler of this.logHandlers) {
      handler(entry);
    }
  }

  private dispatchObjectChange(objId: string, obj: IoBrokerObject | null): void {
    for (const entries of this.subscriptions.values()) {
      for (const { handler, regex } of entries) {
        if (regex.test(objId)) {
          handler(objId, obj);
        }
      }
    }
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
