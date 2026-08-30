/**
 * Minimal in-process ioBroker Admin websocket server, for testing
 * `AdminSocketClient` / `AdminObjectsApi` without a real ioBroker instance.
 *
 * Protocol (verified against real Admin 7.6.17): frames are JSON arrays
 * `[type, id, name, args]` where type 0=message, 1=ping, 2=pong, 3=callback.
 * On connect the server sends `[0, null, "___ready___"]`. Commands arrive as
 * `[3, id, command, args]` and are answered with `[3, id, null, [err, result]]`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import WebSocket from 'ws';
import { IoBrokerObject } from '../src/types';

/**
 * Self-signed certificate for the TLS mode.
 *
 * An ioBroker instance with authentication enabled is normally also on HTTPS with
 * exactly this kind of certificate, so the `allowSelfSigned` path needs a real TLS
 * handshake to be tested at all.
 *
 * The pair is **generated on first use and cached** in `test/fixtures/`, not committed.
 * Committing a private key — even a worthless one for localhost — means every future
 * secret scanner flags the repository forever. Generating it per run would be slower,
 * so it is written once and reused; the files are gitignored.
 *
 * Resolved against the source tree because the compiled tests live in `dist-test/`.
 */
function fixturesDir(): string {
  for (const candidate of [
    path.resolve(process.cwd(), 'test', 'fixtures'),
    path.resolve(__dirname, 'fixtures'),
    path.resolve(__dirname, '..', '..', 'test', 'fixtures'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'test', 'fixtures');
}

/** True when a TLS fixture can be produced, i.e. `openssl` is on PATH. */
export function tlsFixtureAvailable(): boolean {
  return ensureTlsFixture() !== null;
}

let cachedFixture: { key: Buffer; cert: Buffer } | null | undefined;

function ensureTlsFixture(): { key: Buffer; cert: Buffer } | null {
  if (cachedFixture !== undefined) return cachedFixture;

  const dir = fixturesDir();
  const keyPath = path.join(dir, 'self-signed-key.pem');
  const certPath = path.join(dir, 'self-signed-cert.pem');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '7300',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
          '-keyout',
          keyPath,
          '-out',
          certPath,
        ],
        { stdio: 'ignore' },
      );
    } catch {
      // No openssl. The TLS suite skips rather than failing the whole run.
      cachedFixture = null;
      return cachedFixture;
    }
  }

  cachedFixture = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  return cachedFixture;
}

type Frame = [number, (number | null)?, string?, unknown?];

/** Mirrors the client's handling: RawData may be a Buffer, ArrayBuffer or Buffer[]. */
function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/**
 * How the fake instance answers the HTTP auth probes in `src/client/auth.ts`.
 *
 * - `disabled` — `GET /login` 404s, which is how the client detects that no
 *   authentication is configured. This is the only path real usage has ever taken.
 * - `oauth` — Admin >= 6 style: `POST /oauth/token` returns an `access_token` cookie.
 * - `legacy` — older Admin: `POST /login` returns a `connect.sid` session cookie.
 */
export type FakeAuthMode = 'disabled' | 'oauth' | 'legacy';

export interface FakeAuthConfig {
  mode: FakeAuthMode;
  username: string;
  password: string;
}

/** One recorded HTTP request, so tests can assert what the client actually sent. */
export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

/**
 * Keys that must never be copied by `deepMerge`. `src` arrives as parsed JSON off the
 * websocket, so an object id like `__proto__` would otherwise reach through the merge
 * and rewrite the prototype instead of setting a property.
 */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep-merge `src` into `dest`, mirroring the real server's `extendObject` behaviour. */
function deepMerge(
  dest: Record<string, unknown>,
  src: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(src)) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    const srcVal = src[key];
    const destVal = dest[key];
    if (
      srcVal &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      destVal &&
      typeof destVal === 'object' &&
      !Array.isArray(destVal)
    ) {
      deepMerge(destVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      dest[key] = srcVal;
    }
  }
  return dest;
}

/** ioBroker id pattern (`javascript.*.scriptEnabled.*`) as a regex. `*` is the only wildcard. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export class FakeAdminServer {
  private wss: WebSocket.Server | null = null;
  private httpServer: http.Server | null = null;
  private readonly sockets = new Set<WebSocket>();
  /**
   * Sockets that have asked for logs with `requireLog(true)`.
   *
   * The fake used to broadcast log frames to every connection, which is why it happily
   * agreed with a client that sent `subscribe(['log'])` — a command the real Admin
   * accepts as a *state* pattern and then never acts on. The suite passed for months
   * against a fake that shared the client's misunderstanding. Gating delivery here is
   * the whole point: it is what makes the wire command a tested contract instead of a
   * comment.
   */
  private readonly logSubscribers = new Set<WebSocket>();
  private readonly objects = new Map<string, IoBrokerObject>();
  /**
   * State *values*, stored independently of `objects` — which is the entire point.
   * In a real ioBroker the states DB and the objects DB are separate, and a value
   * outliving its object is both possible and the condition this suite has to cover.
   */
  private readonly states = new Map<string, { val: unknown; ack: boolean }>();
  private readonly failCommands = new Map<string, string>();
  private readonly delayedCommands = new Map<string, number>();
  private corruptNextSetObjectFn: ((obj: IoBrokerObject) => IoBrokerObject) | null = null;

  /**
   * Authentication behaviour of the HTTP side. Defaults to `disabled`, so every
   * existing test keeps the auth-free behaviour it was written against.
   */
  auth: FakeAuthConfig = { mode: 'disabled', username: 'admin', password: 'secret' };

  /** Every HTTP request received, in order. */
  readonly httpRequests: RecordedRequest[] = [];

  /** Generic `subscribe`/`unsubscribe` calls, e.g. `subscribe:log`. */
  readonly subscriptionRequests: string[] = [];

  /** Every `requireLog` call, as `requireLog:true` / `requireLog:false`. */
  readonly logRequests: string[] = [];

  /** Delay before sending `___ready___` after connect, in ms. */
  readyDelayMs = 0;

  /**
   * When true, a websocket arriving without a `Cookie` header is accepted, told
   * `___ready___`, and then has every command frame dropped on the floor.
   *
   * That is what a real authenticated Admin does, and it is worth reproducing exactly
   * because of how badly it presents: there is no auth error, no close, no anything —
   * just requests that never come back. Both `iob-sync doctor` and the hint on the
   * request timeout exist for this case, so both need it to be reproducible.
   */
  requireCookieOnSocket = false;

  /** Sockets that connected without a cookie while `requireCookieOnSocket` was set. */
  private readonly unauthenticated = new WeakSet<WebSocket>();
  /** Set to true once a client has replied `[2]` to a server-initiated `[1]` ping. */
  pongReceived = false;

  /**
   * Binds `port` (0 = random free port) and resolves with it. With `tls: true` the
   * server speaks HTTPS using a locally generated self-signed certificate, which is what
   * an auth-enabled ioBroker instance normally looks like.
   */
  start(port = 0, opts: { tls?: boolean } = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      // One server for both protocols, as real Admin does on 8081: the auth probes
      // in src/client/auth.ts hit the same origin the websocket later connects to.
      const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        void this.handleHttp(req, res);
      };

      let httpServer: http.Server;
      if (opts.tls) {
        const fixture = ensureTlsFixture();
        if (!fixture) {
          reject(new Error('TLS mode needs openssl on PATH to generate a test certificate.'));
          return;
        }
        httpServer = https.createServer({ key: fixture.key, cert: fixture.cert }, handler);
      } else {
        httpServer = http.createServer(handler);
      }
      this.httpServer = httpServer;

      const wss = new WebSocket.Server({ server: httpServer });
      this.wss = wss;

      httpServer.listen(port, () => {
        const address = httpServer.address();
        if (typeof address === 'string' || address === null) {
          reject(new Error('Unexpected server address'));
          return;
        }
        resolve(address.port);
      });

      wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
        this.sockets.add(ws);
        if (this.requireCookieOnSocket && !req.headers.cookie) {
          this.unauthenticated.add(ws);
        }

        ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(ws, data);
        });

        ws.on('close', () => {
          this.sockets.delete(ws);
          this.logSubscribers.delete(ws);
        });

        const sendReady = () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify([0, null, '___ready___']));
          }
        };
        if (this.readyDelayMs > 0) {
          setTimeout(sendReady, this.readyDelayMs);
        } else {
          sendReady();
        }
      });

      wss.on('error', reject);
      httpServer.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = this.wss;
      const httpServer = this.httpServer;
      if (!wss || !httpServer) {
        resolve();
        return;
      }
      for (const ws of this.sockets) {
        ws.terminate();
      }
      this.sockets.clear();
      wss.close(() => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          this.wss = null;
          this.httpServer = null;
          resolve();
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // HTTP side — only what src/client/auth.ts probes
  // -------------------------------------------------------------------------

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const urlPath = (req.url ?? '/').split('?')[0];

    this.httpRequests.push({ method: req.method ?? 'GET', path: urlPath, body });

    const { mode, username, password } = this.auth;
    const credentialsMatch = (raw: string): boolean => {
      const form = new URLSearchParams(raw);
      return form.get('username') === username && form.get('password') === password;
    };

    if (req.method === 'GET' && urlPath === '/login') {
      // A 404 here is precisely how the client concludes "auth is disabled".
      if (mode === 'disabled') {
        res.writeHead(404).end('not found');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>login</html>');
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/oauth/token') {
      if (mode !== 'oauth') {
        res.writeHead(404).end('not found');
        return;
      }
      if (!credentialsMatch(body)) {
        res.writeHead(401).end('bad credentials');
        return;
      }
      res
        .writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'access_token=fake-oauth-token; Path=/; HttpOnly',
        })
        .end(JSON.stringify({ access_token: 'fake-oauth-token', token_type: 'Bearer' }));
      return;
    }

    if (req.method === 'POST' && urlPath === '/login') {
      if (mode !== 'legacy' || !credentialsMatch(body)) {
        // No cookie: the client must treat this as a failed login, not a success.
        res.writeHead(401).end('bad credentials');
        return;
      }
      res
        .writeHead(302, {
          Location: '/',
          'Set-Cookie': 'connect.sid=fake-session-id; Path=/; HttpOnly',
        })
        .end();
      return;
    }

    res.writeHead(404).end('not found');
  }

  /** Forcefully terminate all active client connections without stopping the server. */
  terminateConnections(): void {
    for (const ws of this.sockets) {
      ws.terminate();
    }
    this.sockets.clear();
  }

  /** Send a server-initiated ping `[1]` to all connected clients. */
  sendPing(): void {
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify([1]));
      }
    }
  }

  /**
   * Real Admin's `delState` removes the object along with the value. Older builds do
   * not, and `AdminObjectsApi.deleteScriptMarker` is written to cope with either, so
   * the fake can be put into either mode.
   */
  delStateAlsoDeletesObject = true;

  seed(objects: IoBrokerObject[]): void {
    for (const obj of objects) {
      this.objects.set(obj._id, obj);
    }
  }

  /**
   * Seeds a `scriptEnabled` marker the way the javascript adapter writes one: a state
   * object plus a boolean value. `objectOnly`/`valueOnly` create the half-rotted forms.
   */
  seedMarker(
    id: string,
    val: unknown = true,
    opts: { objectOnly?: boolean; valueOnly?: boolean } = {},
  ): void {
    if (!opts.valueOnly) {
      this.objects.set(id, {
        _id: id,
        type: 'state',
        common: { name: id, type: 'boolean', role: 'indicator.state' },
        native: {},
      } as unknown as IoBrokerObject);
    }
    if (!opts.objectOnly) {
      this.states.set(id, { val, ack: true });
    }
  }

  getState(id: string): { val: unknown; ack: boolean } | null {
    return this.states.get(id) ?? null;
  }

  /** Ids of every stored state value, sorted. */
  stateIds(): string[] {
    return Array.from(this.states.keys()).sort();
  }

  /**
   * Clears the object store and any one-shot knobs. Tests that share a server
   * instance must call this between cases — `seed()` merges rather than replaces,
   * so without a reset an object created by one test silently survives into the next.
   */
  reset(): void {
    this.objects.clear();
    this.states.clear();
    this.delStateAlsoDeletesObject = true;
    this.corruptNextSetObjectFn = null;
    this.failCommands.clear();
    this.delayedCommands.clear();
    this.auth = { mode: 'disabled', username: 'admin', password: 'secret' };
    this.requireCookieOnSocket = false;
    this.httpRequests.length = 0;
    this.subscriptionRequests.length = 0;
    this.logRequests.length = 0;
    // Not the socket set itself: `reset` runs between tests while connections from the
    // previous one may still be closing, and dropping them here would be a different
    // kind of lie. Only the recorded intent is cleared.
    this.logSubscribers.clear();
  }

  getObject(id: string): IoBrokerObject | null {
    return this.objects.get(id) ?? null;
  }

  getAll(): IoBrokerObject[] {
    return Array.from(this.objects.values());
  }

  /** Broadcast an objectChange message to all connected clients (bypassing storage). */
  /**
   * Pushes a log line to every client that asked for logs with `requireLog(true)`,
   * as the real server does. Shape mirrors ioBroker's log objects.
   *
   * A client that never sent `requireLog` receives nothing — see `logSubscribers`.
   */
  emitLog(entry: { message: string; severity?: string; from?: string; ts?: number }): void {
    const payload = {
      message: entry.message,
      severity: entry.severity ?? 'info',
      from: entry.from ?? 'javascript.0',
      ts: entry.ts ?? Date.now(),
    };
    for (const ws of this.logSubscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify([0, null, 'log', [payload]]));
      }
    }
  }

  emitObjectChange(id: string, obj: IoBrokerObject | null): void {
    const frame = JSON.stringify([0, null, 'objectChange', [id, obj]]);
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  /** Make the next (and subsequent) calls to `name` fail with `message`. */
  failCommand(name: string, message: string): void {
    this.failCommands.set(name, message);
  }

  /** Delay the NEXT reply to command `name` by `ms` (one-shot; useful for timeout tests). */
  delayCommand(name: string, ms: number): void {
    this.delayedCommands.set(name, ms);
  }

  /**
   * One-shot: the NEXT `setObject` call stores `mutate(obj)` instead of `obj`, while
   * still replying success as if the write succeeded normally. Lets tests simulate a
   * copy-then-delete's copy step landing with the wrong (or empty) source, without the
   * client ever seeing an error — the only way to genuinely exercise the
   * verify-before-delete safety path in rename/move.
   */
  corruptNextSetObject(mutate: (obj: IoBrokerObject) => IoBrokerObject): void {
    this.corruptNextSetObjectFn = mutate;
  }

  private handleMessage(ws: WebSocket, data: WebSocket.RawData): void {
    let frame: Frame;
    try {
      frame = JSON.parse(rawDataToString(data));
    } catch {
      return;
    }
    const [type, id, name, args] = frame;

    if (type === 1) {
      // Client pinged us -> reply with pong.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify([2]));
      }
      return;
    }

    if (type === 2) {
      // Client ponged our ping.
      this.pongReceived = true;
      return;
    }

    if (type === 3 && typeof id === 'number' && typeof name === 'string') {
      // No reply, no error, no close — the silence is the behaviour being reproduced.
      if (this.unauthenticated.has(ws)) return;
      this.handleCommand(ws, id, name, (args as unknown[]) ?? []);
    }
  }

  private reply(ws: WebSocket, id: number, err: unknown, result: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify([3, id, null, [err, result]]));
    }
  }

  private handleCommand(ws: WebSocket, id: number, name: string, args: unknown[]): void {
    const delayMs = this.delayedCommands.get(name);
    if (delayMs !== undefined) {
      this.delayedCommands.delete(name);
      const timer = setTimeout(() => this.executeCommand(ws, id, name, args), delayMs);
      timer.unref?.();
      return;
    }
    this.executeCommand(ws, id, name, args);
  }

  private executeCommand(ws: WebSocket, id: number, name: string, args: unknown[]): void {
    const failMessage = this.failCommands.get(name);
    if (failMessage) {
      this.reply(ws, id, failMessage, null);
      return;
    }

    switch (name) {
      case 'getObjectView': {
        const [, viewType, range] = args as [
          string,
          string,
          { startkey?: string; endkey?: string },
        ];
        const { startkey = '', endkey = '￿' } = range ?? {};
        const rows = Array.from(this.objects.values())
          .filter((obj) => obj.type === viewType)
          .filter((obj) => obj._id >= startkey && obj._id <= endkey)
          .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
          .map((obj) => ({ id: obj._id, value: obj }));
        this.reply(ws, id, null, { rows });
        return;
      }

      case 'getObject': {
        const [objId] = args as [string];
        this.reply(ws, id, null, this.objects.get(objId) ?? null);
        return;
      }

      case 'setObject': {
        const [objId, obj] = args as [string, IoBrokerObject];
        let toStore = obj;
        if (this.corruptNextSetObjectFn) {
          const mutate = this.corruptNextSetObjectFn;
          this.corruptNextSetObjectFn = null;
          toStore = mutate(obj);
        }
        this.objects.set(objId, toStore);
        this.reply(ws, id, null, null);
        this.emitObjectChange(objId, toStore);
        return;
      }

      case 'extendObject': {
        const [objId, partial] = args as [string, Partial<IoBrokerObject>];
        const existing = this.objects.get(objId) ?? ({ _id: objId } as IoBrokerObject);
        const merged = deepMerge({ ...existing }, partial) as unknown as IoBrokerObject;
        merged._id = objId;
        this.objects.set(objId, merged);
        this.reply(ws, id, null, null);
        this.emitObjectChange(objId, merged);
        return;
      }

      case 'delObject': {
        const [objId] = args as [string];
        this.objects.delete(objId);
        this.reply(ws, id, null, null);
        this.emitObjectChange(objId, null);
        return;
      }

      // `getForeignStates` is the deprecated alias real Admin still answers; the client
      // falls back to it, so the fake has to be able to be the instance where only it works.
      case 'getStates':
      case 'getForeignStates': {
        const [pattern] = args as [string];
        const match = patternToRegExp(pattern ?? '*');
        const out: Record<string, unknown> = Object.create(null);
        for (const [stateId, value] of this.states) {
          if (match.test(stateId)) out[stateId] = value;
        }
        this.reply(ws, id, null, out);
        return;
      }

      case 'getForeignObjects': {
        const [pattern, type] = args as [string, string | undefined];
        const match = patternToRegExp(pattern ?? '*');
        const out: Record<string, unknown> = Object.create(null);
        for (const [objId, obj] of this.objects) {
          if (match.test(objId) && (!type || obj.type === type)) out[objId] = obj;
        }
        this.reply(ws, id, null, out);
        return;
      }

      case 'delState': {
        const [stateId] = args as [string];
        this.states.delete(stateId);
        if (this.delStateAlsoDeletesObject) {
          this.objects.delete(stateId);
        }
        this.reply(ws, id, null, null);
        return;
      }

      case 'subscribeObjects':
      case 'unsubscribeObjects': {
        // No server-side subscription bookkeeping needed for the fake: object
        // changes are broadcast to every connection, and the real client
        // filters locally by pattern.
        this.reply(ws, id, null, null);
        return;
      }

      case 'subscribe':
      case 'unsubscribe': {
        // The generic subscribe. In the real Admin this takes a *state id pattern*,
        // so `subscribe(['log'])` is a request to watch states named `log` — accepted,
        // acknowledged, and silent forever. Recorded, but deliberately does not enable
        // log delivery: that is the bug this fake now refuses to reproduce.
        const [what] = (args as string[]) ?? [];
        this.subscriptionRequests.push(`${name}:${what}`);
        this.reply(ws, id, null, null);
        return;
      }

      case 'requireLog': {
        // The actual log command. Only this turns the stream on.
        const [enabled] = (args as [boolean]) ?? [false];
        this.logRequests.push(`requireLog:${enabled}`);
        if (enabled) {
          this.logSubscribers.add(ws);
        } else {
          this.logSubscribers.delete(ws);
        }
        this.reply(ws, id, null, null);
        return;
      }

      default: {
        this.reply(ws, id, `Unknown command: ${name}`, null);
        return;
      }
    }
  }
}

/** Realistic seed data mirroring a live ioBroker instance's `script.js.*` tree. */
export function defaultSeed(): IoBrokerObject[] {
  return [
    {
      _id: 'script.js.common',
      type: 'channel',
      common: { name: { en: 'Common scripts (common)', de: 'Allgemeine Skripte (common)' } },
      native: {},
    },
    {
      _id: 'script.js.Rollos',
      type: 'channel',
      common: { name: 'Rollos' },
      native: {},
    },
    {
      _id: 'script.js.common.garage',
      type: 'script',
      common: {
        name: 'garage',
        engineType: 'TypeScript/ts',
        enabled: true,
        engine: 'system.adapter.javascript.1',
        source: 'console.log("garage");',
      },
      native: {},
    },
    {
      _id: 'script.js.common.dehumidifier',
      type: 'script',
      common: {
        name: 'dehumidifier',
        engineType: 'TypeScript/ts',
        enabled: true,
        engine: 'system.adapter.javascript.2',
        source: 'console.log("dehumidifier");',
        sourceHash: 'abc123hash',
        compiled: 'console.log("compiled dehumidifier");',
      },
      native: {},
    },
    {
      _id: 'script.js.Switch-Musiccast',
      type: 'script',
      common: {
        name: 'Switch-Musiccast',
        engineType: 'Javascript/js',
        enabled: true,
        engine: 'system.adapter.javascript.1',
        source: 'console.log("switch musiccast");',
      },
      native: {},
    },
    {
      _id: 'script.js.fetch-test',
      type: 'script',
      common: {
        name: 'fetch-test',
        engineType: 'TypeScript/ts',
        enabled: false,
        engine: 'system.adapter.javascript.3',
        source: 'console.log("fetch test");',
      },
      native: {},
    },
  ] as IoBrokerObject[];
}
