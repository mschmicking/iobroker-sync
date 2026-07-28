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

/**
 * Builds the tsconfig that gives the *scripts* intellisense.
 *
 * This deliberately lives inside the script root rather than merging into a
 * `tsconfig.json` at the project root: the project root may already hold a build
 * config that owns `rootDir`/`outDir`, and injecting `scripts/**` into it produces
 * TS6059 ("not under rootDir") and breaks that build. Scripts are only ever
 * type-*checked*, never emitted, hence `noEmit`.
 *
 * `typesPrefix` is the relative hop from the script root back to the project root,
 * so the downloaded `.iobroker/types` are picked up from wherever the scripts live.
 *
 * `types` is intentionally left unset: naming `["node"]` hard-fails when `@types/node`
 * is absent, whereas the default (auto-include every visible `@types`) degrades to
 * merely missing the `NodeJS.*` names that `javascript.d.ts` refers to.
 */
function scriptsTsconfig(typesPrefix: string): Record<string, unknown> {
  return {
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      target: 'es2018',
      lib: ['ES2022'],
      module: 'commonjs',
      moduleResolution: 'node',
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['**/*.ts', '**/*.js', `${typesPrefix}.iobroker/types/**/*.d.ts`],
  };
}

async function writeTypesScaffolding(
  root: string,
  scriptRoot: string,
  force: boolean,
  log: Logger,
): Promise<void> {
  const scriptRootDir = path.join(root, scriptRoot);
  const tsconfigPath = path.join(scriptRootDir, 'tsconfig.json');

  // path.relative gives '..' / '../..'; normalise to a POSIX prefix for tsconfig globs.
  const rel = path.relative(scriptRootDir, root).split(path.sep).join('/');
  const typesPrefix = rel === '' ? '' : `${rel}/`;

  if ((await pathExists(tsconfigPath)) && !force) {
    log.warn(`${tsconfigPath} already exists; leaving it alone. Re-run with --force to replace it.`);
  } else {
    await fs.mkdir(scriptRootDir, { recursive: true });
    await fs.writeFile(
      tsconfigPath,
      JSON.stringify(scriptsTsconfig(typesPrefix), null, 2) + '\n',
      'utf8',
    );
    log.info(`Wrote ${tsconfigPath}`);
  }

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

  // javascript.d.ts refers to NodeJS.Timeout, NodeJS.ErrnoException and friends
  // throughout, so without @types/node the scripts light up with "Cannot find
  // namespace 'NodeJS'". Nothing here can install it, so say so plainly.
  if (!(await pathExists(path.join(root, 'node_modules', '@types', 'node')))) {
    log.warn('@types/node is not installed; javascript.d.ts needs it for NodeJS.* types.');
    log.warn('Run: npm install --save-dev @types/node');
  }
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
    await writeTypesScaffolding(root, config.scriptRoot, opts.force ?? false, log);
  }
}
