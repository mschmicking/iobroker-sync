/**
 * Shared harness for command-layer tests.
 *
 * Builds a real CommandContext (real socket, real objects API) pointed at an
 * in-process FakeAdminServer, plus a capturing Logger so tests can assert on
 * what the user would actually see.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AdminSocketClient } from '../src/client/socket';
import { AdminObjectsApi } from '../src/client/objects';
import {
  CommandContext,
  Config,
  Logger,
  Manifest,
  ManifestEntry,
  MANIFEST_FILENAME,
  STATE_DIR,
} from '../src/types';
import { hashSource } from '../src/sync/mapping';

export interface CapturedLog {
  info: string[];
  warn: string[];
  error: string[];
  debug: string[];
  result: string[];
  /** Everything, in emission order — handy for "did it mention X at all" assertions. */
  all: string[];
  /** Machine-readable records, as `--json` would emit them. */
  data: unknown[];
}

export function makeCapturingLogger(): { log: Logger; captured: CapturedLog } {
  const captured: CapturedLog = {
    info: [],
    warn: [],
    error: [],
    debug: [],
    result: [],
    all: [],
    data: [],
  };
  const push =
    (bucket: Exclude<keyof CapturedLog, 'all' | 'data'>) =>
    (msg: string) => {
      captured[bucket].push(msg);
      captured.all.push(msg);
    };
  return {
    captured,
    log: {
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      debug: push('debug'),
      result: push('result'),
      data: (payload: unknown) => {
        captured.data.push(payload);
      },
    },
  };
}

export interface TempProject {
  root: string;
  scriptRoot: string;
  cleanup(): Promise<void>;
}

export async function makeTempProject(scriptRootName = 'scripts'): Promise<TempProject> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iobsync-test-'));
  const scriptRoot = path.join(root, scriptRootName);
  await fs.mkdir(scriptRoot, { recursive: true });
  return {
    root,
    scriptRoot,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: 'http://127.0.0.1:1',
    scriptRoot: 'scripts',
    allowSelfSigned: false,
    username: null,
    defaultInstance: 'system.adapter.javascript.0',
    ...overrides,
  };
}

export interface TestContext {
  ctx: CommandContext;
  captured: CapturedLog;
  socket: AdminSocketClient;
  close(): Promise<void>;
}

/** Connects a real client to the fake server and assembles a CommandContext around it. */
export async function makeContext(
  port: number,
  project: TempProject,
  opts: { dryRun?: boolean; config?: Partial<Config> } = {},
): Promise<TestContext> {
  const config = testConfig({ url: `http://127.0.0.1:${port}`, ...opts.config });
  const socket = new AdminSocketClient({
    url: config.url,
    connectTimeoutMs: 3000,
    requestTimeoutMs: 3000,
  });
  await socket.connect();

  const { log, captured } = makeCapturingLogger();

  const ctx: CommandContext = {
    root: project.root,
    config,
    scriptRoot: project.scriptRoot,
    objects: new AdminObjectsApi(socket),
    socket,
    dryRun: Boolean(opts.dryRun),
    log,
  };

  return {
    ctx,
    captured,
    socket,
    close: () => socket.close().catch(() => undefined),
  };
}

// ---------------------------------------------------------------------------
// Local file / manifest fixtures
// ---------------------------------------------------------------------------

export async function writeLocal(project: TempProject, relPath: string, content: string): Promise<void> {
  const full = path.join(project.scriptRoot, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

export async function readLocal(project: TempProject, relPath: string): Promise<string> {
  return fs.readFile(path.join(project.scriptRoot, relPath), 'utf8');
}

export async function localExists(project: TempProject, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(project.scriptRoot, relPath));
    return true;
  } catch {
    return false;
  }
}

function manifestPath(root: string): string {
  return path.join(root, STATE_DIR, MANIFEST_FILENAME);
}

export async function writeManifest(root: string, entries: ManifestEntry[]): Promise<void> {
  const manifest: Manifest = { version: 1, entries: {} };
  for (const e of entries) {
    manifest.entries[e.id] = e;
  }
  await fs.mkdir(path.dirname(manifestPath(root)), { recursive: true });
  await fs.writeFile(manifestPath(root), JSON.stringify(manifest, null, 2), 'utf8');
}

export async function readManifest(root: string): Promise<Manifest> {
  try {
    return JSON.parse(await fs.readFile(manifestPath(root), 'utf8')) as Manifest;
  } catch {
    return { version: 1, entries: {} };
  }
}

/** Builds a manifest entry whose baseHash matches `source` — i.e. a clean, in-sync baseline. */
export function entryFor(
  id: string,
  relPath: string,
  engineType: string,
  source: string,
  overrides: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    id,
    path: relPath,
    engineType,
    baseHash: hashSource(source),
    lastSync: new Date().toISOString(),
    ...overrides,
  };
}

/** Lists the backup files written to `.iobroker-sync/trash/`. */
export async function listTrash(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(root, STATE_DIR, 'trash'))).sort();
  } catch {
    return [];
  }
}

export async function readTrashFile(root: string, name: string): Promise<unknown> {
  const raw = await fs.readFile(path.join(root, STATE_DIR, 'trash', name), 'utf8');
  return JSON.parse(raw);
}
