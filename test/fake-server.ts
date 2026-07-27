/**
 * Minimal in-process ioBroker Admin websocket server, for testing
 * `AdminSocketClient` / `AdminObjectsApi` without a real ioBroker instance.
 *
 * Protocol (verified against real Admin 7.6.17): frames are JSON arrays
 * `[type, id, name, args]` where type 0=message, 1=ping, 2=pong, 3=callback.
 * On connect the server sends `[0, null, "___ready___"]`. Commands arrive as
 * `[3, id, command, args]` and are answered with `[3, id, null, [err, result]]`.
 */

import WebSocket from 'ws';
import { IoBrokerObject } from '../src/types';

type Frame = [number, (number | null)?, string?, unknown?];

/** Deep-merge `src` into `dest`, mirroring the real server's `extendObject` behaviour. */
function deepMerge(dest: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(src)) {
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

function matchPattern(pattern: string, id: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(id);
}

export class FakeAdminServer {
  private wss: WebSocket.Server | null = null;
  private readonly sockets = new Set<WebSocket>();
  private readonly objects = new Map<string, IoBrokerObject>();
  private readonly failCommands = new Map<string, string>();
  private readonly delayedCommands = new Map<string, number>();
  private corruptNextSetObjectFn: ((obj: IoBrokerObject) => IoBrokerObject) | null = null;

  /** Delay before sending `___ready___` after connect, in ms. */
  readyDelayMs = 0;
  /** Set to true once a client has replied `[2]` to a server-initiated `[1]` ping. */
  pongReceived = false;

  /** Binds `port` (default 0 = random free port) and resolves with the bound port. */
  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocket.Server({ port }, () => {
        const address = wss.address();
        if (typeof address === 'string' || address === null) {
          reject(new Error('Unexpected server address'));
          return;
        }
        resolve(address.port);
      });
      this.wss = wss;

      wss.on('connection', (ws: WebSocket) => {
        this.sockets.add(ws);

        ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(ws, data);
        });

        ws.on('close', () => {
          this.sockets.delete(ws);
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
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = this.wss;
      if (!wss) {
        resolve();
        return;
      }
      for (const ws of this.sockets) {
        ws.terminate();
      }
      this.sockets.clear();
      wss.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        this.wss = null;
        resolve();
      });
    });
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

  seed(objects: IoBrokerObject[]): void {
    for (const obj of objects) {
      this.objects.set(obj._id, obj);
    }
  }

  /**
   * Clears the object store and any one-shot knobs. Tests that share a server
   * instance must call this between cases — `seed()` merges rather than replaces,
   * so without a reset an object created by one test silently survives into the next.
   */
  reset(): void {
    this.objects.clear();
    this.corruptNextSetObjectFn = null;
    this.failCommands.clear();
    this.delayedCommands.clear();
  }

  getObject(id: string): IoBrokerObject | null {
    return this.objects.get(id) ?? null;
  }

  getAll(): IoBrokerObject[] {
    return Array.from(this.objects.values());
  }

  /** Broadcast an objectChange message to all connected clients (bypassing storage). */
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
      frame = JSON.parse(data.toString());
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
        const [, viewType, range] = args as [string, string, { startkey?: string; endkey?: string }];
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
        const merged = deepMerge({ ...existing }, partial as Record<string, unknown>) as unknown as IoBrokerObject;
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

      case 'subscribeObjects':
      case 'unsubscribeObjects': {
        // No server-side subscription bookkeeping needed for the fake: object
        // changes are broadcast to every connection, and the real client
        // filters locally by pattern.
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
