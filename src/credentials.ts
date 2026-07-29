/**
 * Password storage for authenticated ioBroker instances.
 *
 * The password must never end up anywhere the user might share:
 *
 * - **not** in `.iobroker-sync.json`, which lives inside the user's git repo
 * - **not** in a CLI flag, because argv is visible to every other process on the
 *   box via `ps` and is recorded in shell history — this is why there is no
 *   `--password <value>` option, only `--password-stdin` and an interactive prompt
 * - **not** in log output, including `--verbose`
 *
 * What is left is a file outside the project, owner-readable only. It is stored
 * per `url` + `username`, so several instances can be used from one machine.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { UserError } from './types';

/** Owner read/write only. Anything wider means another local user could read it. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

interface CredentialEntry {
  url: string;
  username: string | null;
  password: string;
}

interface CredentialsFile {
  version: 1;
  credentials: Record<string, CredentialEntry>;
}

/**
 * Location of the credentials file. `IOBROKER_SYNC_CREDENTIALS` overrides it, which
 * is what the tests use so they never touch the real one.
 */
export function credentialsPath(): string {
  const override = process.env.IOBROKER_SYNC_CREDENTIALS;
  if (override) return path.resolve(override);

  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');

  return path.join(configHome, 'iobroker-sync', 'credentials.json');
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Same instance reached via a trailing slash is the same credential. */
function keyFor(url: string, username: string | null): string {
  return `${trimTrailingSlash(url)}|${username ?? ''}`;
}

async function readFileIfPresent(file: string): Promise<CredentialsFile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as CredentialsFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.credentials !== 'object') {
      return undefined;
    }
    return parsed;
  } catch {
    // A corrupt store must not block every command; treat it as empty and let a
    // later save overwrite it.
    return undefined;
  }
}

/**
 * Warns when the store is readable by anyone but its owner. Not fatal — refusing to
 * run would be worse than proceeding — but the user should know.
 */
async function checkPermissions(file: string, warn?: (msg: string) => void): Promise<void> {
  if (!warn) return;
  try {
    const stat = await fs.stat(file);
    if ((stat.mode & 0o077) !== 0) {
      warn(
        `${file} is readable by other users; run \`chmod 600 ${file}\` to restrict it.`,
      );
    }
  } catch {
    // Nothing to check.
  }
}

/** Returns the stored password for this instance, or undefined if there is none. */
export async function readStoredPassword(
  url: string,
  username: string | null,
  warn?: (msg: string) => void,
): Promise<string | undefined> {
  const file = credentialsPath();
  const store = await readFileIfPresent(file);
  if (!store) return undefined;

  await checkPermissions(file, warn);

  return store.credentials[keyFor(url, username)]?.password;
}

/**
 * Stores a password, creating the directory and file with restrictive permissions.
 *
 * Written via a temporary file in the same directory and then renamed, so an
 * interrupted write cannot truncate an existing store. The temporary file is created
 * with the final mode, never a wider one.
 */
export async function saveStoredPassword(
  url: string,
  username: string | null,
  password: string,
): Promise<string> {
  const file = credentialsPath();
  const dir = path.dirname(file);

  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });

  const store: CredentialsFile = (await readFileIfPresent(file)) ?? { version: 1, credentials: {} };
  store.credentials[keyFor(url, username)] = {
    url: trimTrailingSlash(url),
    username,
    password,
  };

  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new UserError(
      `Could not save credentials to ${file}: ${(err as Error).message}`,
      'Check that the directory is writable.',
    );
  }

  // rename preserves the temp file's mode, but an existing file replaced by a
  // previous version of this tool might have had a wider one.
  await fs.chmod(file, FILE_MODE).catch(() => undefined);

  return file;
}

/** Removes a stored password. Returns true if there was one. */
export async function deleteStoredPassword(url: string, username: string | null): Promise<boolean> {
  const file = credentialsPath();
  const store = await readFileIfPresent(file);
  if (!store) return false;

  const key = keyFor(url, username);
  if (!(key in store.credentials)) return false;

  delete store.credentials[key];
  await fs.writeFile(file, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE });
  return true;
}
