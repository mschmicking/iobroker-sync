/**
 * `iob-sync types` — sets up editor intellisense for pulled scripts.
 *
 * ioBroker scripts call globals that exist only inside the javascript adapter's
 * sandbox — `log`, `schedule`, `on`, `getState`. Nothing in a plain checkout tells an
 * editor those exist, so every script lights up red in neovim, VS Code, or any other
 * LSP client. This writes the two pieces that fix it:
 *
 *   .iobroker/types/javascript.d.ts   the adapter's own typings, downloaded
 *   <scriptRoot>/tsconfig.json        a config that picks them up
 *
 * Also reachable as `init --types`, but it exists separately because wanting types
 * later — or refreshing them after the adapter adds a function — is the common case,
 * and re-running `init` to get them would mean `--force`-overwriting a working config.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Logger } from '../types';

const JAVASCRIPT_DTS_URL =
  'https://raw.githubusercontent.com/ioBroker/ioBroker.javascript/refs/heads/master/src/lib/javascript.d.ts';

/**
 * Upper bound for the download. The real declaration file is well under 200 KB;
 * anything past this is not it, and an unbounded response body has no business
 * being buffered and then written into someone's project.
 */
const MAX_DTS_BYTES = 2 * 1024 * 1024;

/**
 * A captive portal, a corporate proxy, or a GitHub error page answers 200 with HTML,
 * and `res.ok` cannot tell that from the real file. Writing a login page over a
 * working javascript.d.ts breaks every script in the editor and presents as a
 * TypeScript problem, so check what arrived before it goes near the disk.
 */
function looksLikeDeclarationFile(text: string): boolean {
  return /^\s*declare\s/m.test(text);
}

const GLOBAL_DTS_CONTENT = `export {};
declare global {
  function require(library: string): any;
}
`;

export interface TypesOptions {
  /** Replace an existing `<scriptRoot>/tsconfig.json` instead of leaving it alone. */
  force?: boolean;
  /** Skip the download and only write the local files. */
  offline?: boolean;
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
 * The tsconfig that gives the *scripts* intellisense.
 *
 * It lives inside the script root rather than merging into a `tsconfig.json` at the
 * project root: the project root may already hold a build config that owns
 * `rootDir`/`outDir`, and injecting `scripts/**` into it produces TS6059 and breaks
 * that build. Scripts are only ever type-*checked*, never emitted, hence `noEmit`.
 *
 * `typesPrefix` is the relative hop from the script root back to the project root, so
 * the downloaded `.iobroker/types` are found from wherever the scripts live.
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
      // `moduleDetection: force` is what makes a folder of scripts checkable at all.
      // Each ioBroker script runs in its own sandbox scope, but to TypeScript they
      // are plain scripts sharing one global scope, so two files each declaring
      // `const helper` collide with TS2451 — a phantom error about code that is
      // fine at runtime. Forcing module semantics gives every file its own scope,
      // matching how the adapter actually runs them. Globals from javascript.d.ts
      // are declared with `declare global` and stay visible.
      moduleDetection: 'force',
      // es2022 (not commonjs) because scripts may use top-level `await`, which the
      // adapter supports and which TS1378 rejects under commonjs.
      module: 'es2022',
      target: 'es2022',
      lib: ['ES2022'],
      moduleResolution: 'node',
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['**/*.ts', '**/*.js', `${typesPrefix}.iobroker/types/**/*.d.ts`],
  };
}

export async function setupTypes(
  root: string,
  scriptRoot: string,
  opts: TypesOptions,
  log: Logger,
): Promise<void> {
  const scriptRootDir = path.join(root, scriptRoot);
  const tsconfigPath = path.join(scriptRootDir, 'tsconfig.json');

  // path.relative gives '..' / '../..'; normalise to a POSIX prefix for tsconfig globs.
  const rel = path.relative(scriptRootDir, root).split(path.sep).join('/');
  const typesPrefix = rel === '' ? '' : `${rel}/`;

  if ((await pathExists(tsconfigPath)) && !opts.force) {
    log.info(`${tsconfigPath} already exists; keeping it. Use --force to replace it.`);
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

  const dtsPath = path.join(typesDir, 'javascript.d.ts');
  if (opts.offline) {
    log.info('Skipping the javascript.d.ts download (--offline).');
  } else {
    try {
      const res = await fetch(JAVASCRIPT_DTS_URL);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_DTS_BYTES) {
        throw new Error(`the response announces ${Math.round(declared / 1024)} KB`);
      }
      const text = await res.text();
      if (text.length > MAX_DTS_BYTES) {
        throw new Error(`the response is ${Math.round(text.length / 1024)} KB`);
      }
      if (!looksLikeDeclarationFile(text)) {
        throw new Error('the response is not a TypeScript declaration file');
      }
      await fs.writeFile(dtsPath, text, 'utf8');
      log.info(`Downloaded javascript.d.ts (${Math.round(text.length / 1024)} KB)`);
    } catch (err) {
      // Not fatal: the tsconfig and global.d.ts are still worth writing, and a
      // previously downloaded copy may already be sitting there.
      log.warn(`Could not download javascript.d.ts (${(err as Error).message}).`);
      log.warn(
        (await pathExists(dtsPath))
          ? 'Keeping the copy already in .iobroker/types/.'
          : `Scripts will still show "Cannot find name 'log'" until it is fetched. Re-run \`iob-sync types\` when online.`,
      );
    }
  }

  await fs.writeFile(path.join(typesDir, 'global.d.ts'), GLOBAL_DTS_CONTENT, 'utf8');
  log.info(`Wrote ${path.join(typesDir, 'global.d.ts')}`);

  // javascript.d.ts refers to NodeJS.Timeout, NodeJS.ErrnoException and friends
  // throughout, so without @types/node the scripts light up with "Cannot find
  // namespace 'NodeJS'". Nothing here can install it, so say so plainly.
  if (!(await pathExists(path.join(root, 'node_modules', '@types', 'node')))) {
    log.warn('@types/node is not installed; javascript.d.ts needs it for NodeJS.* types.');
    log.warn(`Run this in ${root}:  npm install --save-dev @types/node`);
  }

  log.result(`Types ready. Restart your editor's language server to pick them up.`);
}
