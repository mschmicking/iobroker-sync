/**
 * Shared type contracts for iobroker-sync.
 *
 * This file is the interface boundary between all modules. It is frozen: implementations
 * conform to it, it does not bend to implementations. If something genuinely cannot be
 * expressed here, raise it rather than redefining a local variant.
 *
 * Field shapes below were verified against a live ioBroker Admin 7.6.17 instance.
 */

// ---------------------------------------------------------------------------
// ioBroker object model
// ---------------------------------------------------------------------------

/**
 * The four script engines ioBroker supports, spelled exactly as stored in
 * `common.engineType`. Casing matters — the javascript adapter compares these literally.
 */
export const ENGINE_TYPES = {
  javascript: 'Javascript/js',
  typescript: 'TypeScript/ts',
  blockly: 'Blockly',
  rules: 'Rules',
} as const;

export type EngineType = (typeof ENGINE_TYPES)[keyof typeof ENGINE_TYPES];

/**
 * ioBroker stores some names as a plain string and others as a translation map
 * (folder objects created by the Admin UI use the map form). Always narrow with
 * `resolveName()` from sync/mapping.ts rather than assuming a string.
 */
export type MultilingualName =
  string | { en?: string; de?: string; [lang: string]: string | undefined };

/** Access control list as returned by the server. Treated as opaque; never written by us. */
export interface ObjectAcl {
  object?: number;
  owner?: string;
  ownerGroup?: string;
  [key: string]: unknown;
}

/**
 * `common` section of a script object.
 *
 * `sourceHash` and `compiled` are adapter-managed derived fields. We never write them:
 * the javascript adapter recomputes the hash from `source` and only reuses `compiled`
 * on a hash match, so leaving them stale is safe and forces a correct recompile.
 */
export interface ScriptCommon {
  name?: string;
  source?: string;
  engineType?: string;
  /** e.g. "system.adapter.javascript.2" — varies per script, must be preserved on update. */
  engine?: string;
  enabled?: boolean;
  debug?: boolean;
  verbose?: boolean;
  expert?: boolean;
  /** Adapter-managed. Read-only from our perspective. */
  sourceHash?: string;
  /** Adapter-managed. Read-only from our perspective. */
  compiled?: string;
  [key: string]: unknown;
}

/** A script object: `script.js.<folder...>.<name>`, `type: "script"`. */
export interface ScriptObject {
  _id: string;
  type: 'script';
  common: ScriptCommon;
  native?: Record<string, unknown>;
  from?: string;
  user?: string;
  ts?: number;
  acl?: ObjectAcl;
  [key: string]: unknown;
}

/** A folder object: `script.js.<folder>`, `type: "channel"`. */
export interface FolderObject {
  _id: string;
  type: 'channel';
  common: { name?: MultilingualName; expert?: boolean; [key: string]: unknown };
  native?: Record<string, unknown>;
  from?: string;
  ts?: number;
  acl?: ObjectAcl;
  [key: string]: unknown;
}

export type IoBrokerObject = ScriptObject | FolderObject;

/** Shape of a `getObjectView` reply. */
export interface ObjectViewResult<T> {
  rows: { id: string; value: T }[];
}

/**
 * The two per-script bookkeeping states the javascript adapter maintains.
 *
 * They are created together by `load()` and deleted together in the same block, so
 * anything that treats one without the other cleans up half a mess and reports
 * success — verified the hard way against a live instance, which had eight orphaned
 * `scriptProblem` states while reporting zero orphaned `scriptEnabled` ones.
 */
export const MARKER_KINDS = ['scriptEnabled', 'scriptProblem'] as const;

export type MarkerKind = (typeof MARKER_KINDS)[number];

/**
 * One `javascript.<n>.<kind>.<suffix>` entry — per-script bookkeeping the javascript
 * adapter keeps beside every script, on every instance.
 *
 * Every instance creates both markers for every non-global script, because `load()`
 * calls `createActiveObject`/`createProblemObject` before `prepareScript` checks
 * whether this instance actually owns the script (verified in ioBroker.javascript
 * v8.9.2, both at startup and on every source change). Only the owning instance ever
 * deletes them again, so each delete strands one pair per other instance.
 *
 * Both halves are tracked separately because they rot apart. `hasValue && !hasObject`
 * is the combination js-controller warns about on every restart, and the adapter
 * itself can produce it: its cleanup calls `delObject` before `delState`.
 */
export interface ScriptMarkerEntry {
  /** e.g. "javascript.2.scriptEnabled.common.garage". */
  id: string;
  /** The script it belongs to, e.g. "script.js.common.garage". */
  scriptId: string;
  kind: MarkerKind;
  /** A value is stored under this id. */
  hasValue: boolean;
  /** An object is defined for this id. */
  hasObject: boolean;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Frame type tags used by the ioBroker Admin websocket protocol. */
export const MESSAGE_TYPE = {
  message: 0,
  ping: 1,
  pong: 2,
  callback: 3,
} as const;

export interface SocketOptions {
  /** Admin base URL, e.g. "https://iobroker.local:8081". */
  url: string;
  /** Cookie header value when the instance requires auth; omitted when auth is disabled. */
  cookie?: string;
  /** Accept self-signed TLS certificates. */
  allowSelfSigned?: boolean;
  /**
   * Pinned SHA-256 certificate fingerprint. When set, the server's certificate must
   * match it exactly; this is what supplies the identity check that `allowSelfSigned`
   * takes away. See `src/client/tls.ts`.
   */
  certFingerprint?: string;
  /** Milliseconds to wait for `___ready___` before failing. Default 15000. */
  connectTimeoutMs?: number;
  /** Milliseconds to wait for a single request's callback. Default 20000. */
  requestTimeoutMs?: number;
}

export type ObjectChangeHandler = (id: string, obj: IoBrokerObject | null) => void;

/** ioBroker severities, ascending. `silly` exists but is rarely enabled. */
export const LOG_LEVELS = ['silly', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * One line from the server's log stream.
 *
 * `from` is the adapter instance that emitted it (`javascript.2`, `admin.1`, ...);
 * for a script, the script name appears inside `message`, not in a separate field,
 * which is why filtering by script is substring matching rather than a lookup.
 */
export interface LogMessage {
  message: string;
  severity: string;
  from: string;
  /** Milliseconds since the epoch. */
  ts: number;
}

export type LogHandler = (log: LogMessage) => void;

/**
 * Minimal ioBroker Admin websocket client.
 *
 * `emit` correlates a request id with its callback frame and resolves with the
 * callback's result, rejecting when the server passes a non-null error argument.
 */
export interface SocketClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  readonly connected: boolean;
  /** Send a command and await its callback. Rejects on server error or timeout. */
  emit<T = unknown>(command: string, args?: unknown[]): Promise<T>;
  /** Subscribe to object changes matching an ioBroker pattern, e.g. "script.js.*". */
  subscribeObjects(pattern: string, handler: ObjectChangeHandler): Promise<void>;
  unsubscribeObjects(pattern: string): Promise<void>;
  /** Start receiving the server's log stream. */
  subscribeLog(handler: LogHandler): Promise<void>;
  unsubscribeLog(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Object-layer API (src/client/objects.ts)
// ---------------------------------------------------------------------------

export interface ObjectsApi {
  /** All objects of `type: "script"` under `script.js.`. */
  listScripts(): Promise<ScriptObject[]>;
  /** All objects of `type: "channel"` under `script.js.`. */
  listFolders(): Promise<FolderObject[]>;
  getScript(id: string): Promise<ScriptObject | null>;
  /**
   * Partial update. This is the only write path used by `push`, and it must be
   * called with a `common` containing nothing beyond `source` and `engineType`.
   */
  extendScript(id: string, common: Pick<ScriptCommon, 'source' | 'engineType'>): Promise<void>;
  /** Toggle `common.enabled`. Used by start/stop only. */
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Full object write. Used only when creating a new script. */
  createScript(obj: ScriptObject): Promise<void>;
  /** Create any missing `channel` objects along the path to a script id. Never deletes. */
  ensureFolders(scriptId: string): Promise<string[]>;
  /** Delete an object. Callers must have obtained explicit confirmation and written a backup. */
  deleteObject(id: string): Promise<void>;
  /**
   * Every script marker on the instance — both kinds, across all javascript instances.
   *
   * Deliberately unfiltered: callers narrow by `scriptId` themselves. Building a
   * server-side pattern out of a script id would mean interpolating an id into a
   * wildcard expression, and the one thing that must never happen here is a delete
   * loop running against a pattern that matched more than it was meant to.
   */
  listScriptMarkers(): Promise<ScriptMarkerEntry[]>;
  /**
   * Delete one marker: the value first, then the object. Never the other way round —
   * an object deleted out from under a surviving value is precisely the state that
   * makes js-controller warn forever.
   */
  deleteScriptMarker(entry: ScriptMarkerEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface Config {
  /** Admin base URL including scheme and port. */
  url: string;
  /** Folder holding synced scripts, relative to the project root. */
  scriptRoot: string;
  allowSelfSigned: boolean;
  /**
   * SHA-256 fingerprint of the certificate this instance is expected to present,
   * as colon-separated uppercase hex. Recorded automatically on the first connection
   * that uses `allowSelfSigned`, and verified on every one after that.
   *
   * Optional: configs written before pinning existed have no such field, and they
   * must keep working. Not a secret — a fingerprint is public information — so it
   * belongs in the committed project config rather than the credentials store.
   */
  certFingerprint?: string;
  /** Only needed when the instance has authentication enabled. */
  username: string | null;
  /** Instance assigned to newly created scripts, e.g. "system.adapter.javascript.0". */
  defaultInstance: string;
}

export const CONFIG_FILENAME = '.iobroker-sync.json';
export const STATE_DIR = '.iobroker-sync';
export const MANIFEST_FILENAME = 'state.json';
export const TRASH_DIRNAME = 'trash';

// ---------------------------------------------------------------------------
// Manifest and sync state
// ---------------------------------------------------------------------------

/**
 * One synced script's baseline. `baseHash` is the sha256 of the normalised source at the
 * time of the last successful sync, and is what makes three-way comparison possible.
 */
export interface ManifestEntry {
  /** Exact ioBroker id. Authoritative — never re-derived from the path for a known script. */
  id: string;
  /** Path relative to `scriptRoot`, POSIX separators. */
  path: string;
  engineType: string;
  engine?: string;
  enabled?: boolean;
  baseHash: string;
  lastSync: string;
}

export interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

export type SyncState =
  | 'in-sync'
  | 'local-modified'
  | 'remote-modified'
  | 'conflict'
  | 'local-only'
  | 'remote-only'
  | 'remote-missing';

export interface SyncStatus {
  /**
   * ioBroker id. Always populated: for a `local-only` file with no manifest entry
   * yet, this is derived from the path via `relPathToId()` and is therefore the id
   * the script *would* get on push, not one the server has confirmed.
   */
  id: string;
  /** Path relative to `scriptRoot`. */
  path: string;
  state: SyncState;
  engineType?: string;
  engine?: string;
  enabled?: boolean;
  localHash?: string;
  remoteHash?: string;
  baseHash?: string;
}

// ---------------------------------------------------------------------------
// Command context
// ---------------------------------------------------------------------------

/** Everything a command implementation needs. Built once by cli.ts. */
export interface CommandContext {
  /** Absolute path to the project root (directory holding the config file). */
  root: string;
  config: Config;
  /** Absolute path to the script root. */
  scriptRoot: string;
  objects: ObjectsApi;
  socket: SocketClient;
  dryRun: boolean;
  /** Structured output helpers so commands never call console.* directly. */
  log: Logger;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Only emitted when verbose output is enabled. */
  debug(msg: string): void;
  /** Machine-ish result line, e.g. "pull  common/garage.ts". */
  result(msg: string): void;
  /**
   * One machine-readable record.
   *
   * Silently dropped in human mode; under `--json` it is written to stdout as a
   * single line of JSON (NDJSON). Commands should call this alongside `result`,
   * never instead of it, so both audiences are served by one code path.
   */
  data(payload: unknown): void;
}

/** Thrown for expected, user-facing failures. cli.ts prints these without a stack trace. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
