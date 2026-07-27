/**
 * `iob-sync init` — creates `.iobroker-sync.json`, the script root directory, and
 * (optionally) TypeScript intellisense scaffolding for hand-editing scripts.
 *
 * This runs *before* a config file (and therefore a full `CommandContext`) exists,
 * so it has its own entry point rather than the `(ctx, opts)` shape every other
 * command uses. `cli.ts` calls `runInit` directly with the raw cwd and a `Logger`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AdminObjectsApi } from '../client/objects';
import { getAuthCookie } from '../client/auth';
import { AdminSocketClient } from '../client/socket';
import { defaultConfig, writeConfig } from '../config';
import { CONFIG_FILENAME, Logger, UserError } from '../types';

const JAVASCRIPT_DTS_URL =
  'https://raw.githubusercontent.com/ioBroker/ioBroker.javascript/refs/heads/master/src/lib/javascript.d.ts';

const GLOBAL_DTS_CONTENT = `export {};
declare global {
  function require(library: string): any;
}
`;

export interface InitOptions {
  url: string;
  scriptRoot?: string;
  types?: boolean;
  force?: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges our required TypeScript settings into an existing (or absent) tsconfig.json
 * without clobbering unrelated settings the user already has.
 */
function mergeTsconfig(existing: unknown): Record<string, unknown> {
  const base = isPlainObject(existing) ? { ...existing } : {};
  const existingCompilerOptions = isPlainObject(base.compilerOptions) ? base.compilerOptions : {};
  const existingTypeRoots = Array.isArray(existingCompilerOptions.typeRoots)
    ? (existingCompilerOptions.typeRoots as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const existingInclude = Array.isArray(base.include)
    ? (base.include as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  const typeRoots = Array.from(new Set([...existingTypeRoots, '.iobroker/types', 'node_modules/@types']));
  const include = Array.from(
    new Set([...existingInclude, '**/*.js', '**/*.ts', '.iobroker/types/**/*.d.ts']),
  );

  return {
    ...base,
    compilerOptions: {
      ...existingCompilerOptions,
      allowJs: true,
      checkJs: true,
      target: 'es2018',
      typeRoots,
    },
    include,
  };
}

async function writeTypesScaffolding(root: string, log: Logger): Promise<void> {
  const tsconfigPath = path.join(root, 'tsconfig.json');

  let existing: unknown = undefined;
  if (await pathExists(tsconfigPath)) {
    try {
      const raw = await fs.readFile(tsconfigPath, 'utf8');
      existing = JSON.parse(raw);
    } catch (err) {
      log.warn(`Could not parse existing tsconfig.json (${(err as Error).message}); it will be replaced.`);
    }
  }

  const merged = mergeTsconfig(existing);
  await fs.writeFile(tsconfigPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  log.info(`Wrote ${tsconfigPath}`);

  const typesDir = path.join(root, '.iobroker', 'types');
  await fs.mkdir(typesDir, { recursive: true });

  try {
    const res = await fetch(JAVASCRIPT_DTS_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    await fs.writeFile(path.join(typesDir, 'javascript.d.ts'), text, 'utf8');
    log.info('Downloaded javascript.d.ts');
  } catch (err) {
    log.warn(`Could not download javascript.d.ts (${(err as Error).message}); skipping.`);
  }

  await fs.writeFile(path.join(typesDir, 'global.d.ts'), GLOBAL_DTS_CONTENT, 'utf8');
  log.info(`Wrote ${path.join(typesDir, 'global.d.ts')}`);
}

/** Read-only probe: confirms the config actually works and reports what it finds. */
async function probeConnection(
  url: string,
  username: string | null,
  allowSelfSigned: boolean,
  log: Logger,
): Promise<void> {
  try {
    const cookie = await getAuthCookie(url, username, allowSelfSigned);
    const socket = new AdminSocketClient({ url, cookie, allowSelfSigned });
    await socket.connect();
    try {
      const objects = new AdminObjectsApi(socket);
      const [scripts, folders] = await Promise.all([objects.listScripts(), objects.listFolders()]);
      log.info(`Connected to ${url}: found ${scripts.length} script(s) in ${folders.length} folder(s).`);
    } finally {
      await socket.close();
    }
  } catch (err) {
    log.warn(`Could not verify the connection to ${url}: ${(err as Error).message}`);
    log.warn('The config was still written; fix connectivity/auth and re-run a command to verify.');
  }
}

/**
 * Creates `.iobroker-sync.json` and the script root directory, probes the
 * connection, and optionally scaffolds TypeScript intellisense support.
 */
export async function runInit(cwd: string, opts: InitOptions, log: Logger): Promise<void> {
  const root = path.resolve(cwd);
  const configPath = path.join(root, CONFIG_FILENAME);

  if ((await pathExists(configPath)) && !opts.force) {
    throw new UserError(
      `${CONFIG_FILENAME} already exists at "${configPath}".`,
      'Re-run with --force to overwrite it.',
    );
  }

  const config = defaultConfig(opts.url);
  if (opts.scriptRoot) {
    config.scriptRoot = opts.scriptRoot;
  }

  await fs.mkdir(path.join(root, config.scriptRoot), { recursive: true });
  await writeConfig(root, config);
  log.info(`Wrote ${configPath}`);
  log.info(`Script root: ${path.join(root, config.scriptRoot)}`);

  await probeConnection(config.url, config.username, config.allowSelfSigned, log);

  if (opts.types) {
    await writeTypesScaffolding(root, log);
  }
}
