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
import { CONFIG_FILENAME, Logger, STATE_DIR, UserError } from '../types';
import { isInteractive, promptText, promptYesNo } from '../prompt';
import { setupTypes } from './types';

export interface InitOptions {
  /** Optional: when absent and a TTY is attached, the user is asked for it. */
  url?: string;
  scriptRoot?: string;
  types?: boolean;
  force?: boolean;
  username?: string;
  allowSelfSigned?: boolean;
  /** Set false to never prompt, whatever stdin is. Tests and CI rely on this. */
  interactive?: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read-only probe: confirms the config actually works and reports what it finds. */
async function probeConnection(
  url: string,
  username: string | null,
  allowSelfSigned: boolean,
  log: Logger,
  interactive?: boolean,
): Promise<void> {
  try {
    const cookie = await getAuthCookie(url, username, allowSelfSigned, {
      allowPrompt: interactive ?? true,
      warn: (msg) => log.warn(msg),
      info: (msg) => log.info(msg),
    });
    const socket = new AdminSocketClient({ url, cookie, allowSelfSigned });
    await socket.connect();
    try {
      const objects = new AdminObjectsApi(socket);
      const [scripts, folders] = await Promise.all([objects.listScripts(), objects.listFolders()]);
      log.info(
        `Connected to ${url}: found ${scripts.length} script(s) in ${folders.length} folder(s).`,
      );
    } finally {
      await socket.close();
    }
  } catch (err) {
    log.warn(`Could not verify the connection to ${url}: ${(err as Error).message}`);
    log.warn('The config was still written; fix connectivity/auth and re-run a command to verify.');
  }
}

/**
 * Adds `.iobroker-sync/` to the project's `.gitignore`.
 *
 * Snapshots written by `backup` contain whatever secrets the live scripts hold, and
 * `init` is frequently run inside a git repo. Leaving this to the user is how those
 * end up committed, so it is done for them.
 */
async function ensureGitignored(root: string, log: Logger): Promise<void> {
  const gitignorePath = path.join(root, '.gitignore');
  const entry = `${STATE_DIR}/`;

  let existing = '';
  if (await pathExists(gitignorePath)) {
    existing = await fs.readFile(gitignorePath, 'utf8');
    const alreadyListed = existing
      .split('\n')
      .map((line) => line.trim())
      .some((line) => line === entry || line === STATE_DIR);
    if (alreadyListed) return;
  } else if (!(await pathExists(path.join(root, '.git')))) {
    // Not a git repo and no .gitignore: nothing to protect against yet.
    return;
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.appendFile(
    gitignorePath,
    `${prefix}\n# iobroker-sync state and backups — may contain secrets from live scripts\n${entry}\n`,
    'utf8',
  );
  log.info(`Added ${entry} to .gitignore`);
}

/**
 * Fills in whatever the flags did not supply by asking, when a TTY is attached.
 *
 * Nothing here ever asks for a password: that is resolved by `getAuthCookie` during
 * the connection probe, so it can be verified before being offered for saving, and
 * so it never passes through the config-writing path at all.
 */
async function resolveInteractively(
  opts: InitOptions,
  log: Logger,
): Promise<InitOptions & { url: string }> {
  const mayPrompt = (opts.interactive ?? true) && isInteractive();

  if (!mayPrompt) {
    if (!opts.url) {
      throw new UserError(
        'No --url given and not running interactively.',
        'Pass --url http://<host>:8081, or run in a terminal to be asked for it.',
      );
    }
    return { ...opts, url: opts.url };
  }

  const filled: InitOptions = { ...opts };

  if (!filled.url) {
    log.info('Setting up iobroker-sync. Press enter to accept the default in brackets.');
    filled.url = await promptText('ioBroker Admin URL', 'http://127.0.0.1:8081');
  }

  if (filled.url.startsWith('https://') && filled.allowSelfSigned === undefined) {
    filled.allowSelfSigned = await promptYesNo(
      'Accept a self-signed certificate? (usual for a local instance)',
      true,
    );
  }

  if (!filled.scriptRoot) {
    filled.scriptRoot = await promptText('Folder for synced scripts', 'scripts');
  }

  if (filled.username === undefined) {
    const entered = await promptText('Admin username (leave empty if auth is disabled)', '');
    filled.username = entered.length > 0 ? entered : undefined;
  }

  return { ...filled, url: filled.url };
}

/**
 * Creates `.iobroker-sync.json` and the script root directory, probes the
 * connection, and optionally scaffolds TypeScript intellisense support.
 */
export async function runInit(cwd: string, rawOpts: InitOptions, log: Logger): Promise<void> {
  const root = path.resolve(cwd);
  const configPath = path.join(root, CONFIG_FILENAME);

  if ((await pathExists(configPath)) && !rawOpts.force) {
    throw new UserError(
      `${CONFIG_FILENAME} already exists at "${configPath}".`,
      'Re-run with --force to overwrite it.',
    );
  }

  const opts = await resolveInteractively(rawOpts, log);

  const config = defaultConfig(opts.url);
  if (opts.scriptRoot) {
    config.scriptRoot = opts.scriptRoot;
  }
  if (opts.username) {
    config.username = opts.username;
  }
  if (opts.allowSelfSigned !== undefined) {
    config.allowSelfSigned = opts.allowSelfSigned;
  }

  await fs.mkdir(path.join(root, config.scriptRoot), { recursive: true });
  // The config is written to the repo, so it deliberately carries no password —
  // only the username. See src/credentials.ts.
  await writeConfig(root, config);
  log.info(`Wrote ${configPath}`);
  log.info(`Script root: ${path.join(root, config.scriptRoot)}`);

  await ensureGitignored(root, log);
  await probeConnection(config.url, config.username, config.allowSelfSigned, log, opts.interactive);

  if (opts.types) {
    await setupTypes(root, config.scriptRoot, { force: opts.force }, log);
  }
}
