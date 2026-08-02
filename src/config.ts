/**
 * Load/create/validate the `.iobroker-sync.json` config file.
 *
 * Pure logic + filesystem access only: no network calls here.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CONFIG_FILENAME, Config, UserError } from './types';

const INIT_HINT = 'Run `iob-sync init` to create one.';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserError(
      `Invalid "url" in config: "${url}"`,
      'Use a full URL including scheme, e.g. "https://iobroker.local:8081".',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UserError(
      `Config "url" must use http or https, got "${parsed.protocol.replace(/:$/, '')}".`,
      'Use a full URL including scheme, e.g. "https://iobroker.local:8081".',
    );
  }
}

/**
 * `scriptRoot` names the directory this tool writes into, resolved against the folder
 * holding the config. It therefore may not be absolute or contain `..` — either would
 * let a config file place files anywhere on the filesystem.
 *
 * The hints matter: the natural reaction to "must be relative" is to try `../my-scripts`,
 * which then hits the second rule, and neither message says what to do instead. The
 * answer is always the same — run `init` inside the folder you want the scripts in.
 */
const SCRIPT_ROOT_HINT =
  'scriptRoot is a folder *inside* the project (the directory holding ' +
  `${CONFIG_FILENAME}), e.g. "scripts". To keep scripts somewhere else, run ` +
  '`iob-sync init` in that folder instead, or use `iob-sync -C <dir>` to work there.';

function validateScriptRoot(scriptRoot: string): void {
  if (path.isAbsolute(scriptRoot) || /^[a-zA-Z]:[\\/]/.test(scriptRoot)) {
    throw new UserError(
      `Config "scriptRoot" must be relative, got the absolute path "${scriptRoot}".`,
      SCRIPT_ROOT_HINT,
    );
  }
  const segments = scriptRoot.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    throw new UserError(
      `Config "scriptRoot" must not escape the project root: "${scriptRoot}".`,
      SCRIPT_ROOT_HINT,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SHA-256 as OpenSSL/Node print it: 32 colon-separated hex bytes. */
const FINGERPRINT_PATTERN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i;

/** Validates parsed JSON against the `Config` shape and the extra rules in the spec. */
function assertValidConfig(parsed: unknown, sourcePath: string): Config {
  if (!isPlainObject(parsed)) {
    throw new UserError(`Config file "${sourcePath}" must contain a JSON object.`, INIT_HINT);
  }

  const { url, scriptRoot, allowSelfSigned, certFingerprint, username, defaultInstance } = parsed;

  if (typeof url !== 'string' || url.length === 0) {
    throw new UserError(`Config file "${sourcePath}" is missing a valid "url" string.`, INIT_HINT);
  }
  if (typeof scriptRoot !== 'string' || scriptRoot.length === 0) {
    throw new UserError(
      `Config file "${sourcePath}" is missing a valid "scriptRoot" string.`,
      INIT_HINT,
    );
  }
  if (typeof allowSelfSigned !== 'boolean') {
    throw new UserError(
      `Config file "${sourcePath}" is missing a valid "allowSelfSigned" boolean.`,
      INIT_HINT,
    );
  }
  // Optional: absent in every config written before pinning existed, and a missing
  // pin is the normal state on first run. Only the shape is checked here — whether
  // it matches the live certificate is a question for `src/client/tls.ts`.
  if (certFingerprint !== undefined) {
    if (typeof certFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(certFingerprint)) {
      throw new UserError(
        `Config file "${sourcePath}" has an invalid "certFingerprint".`,
        'It must be a SHA-256 fingerprint, e.g. "A1:B2:...:9F" (32 hex bytes). ' +
          'Delete the field and reconnect to record it again, or run `iob-sync trust`.',
      );
    }
  }
  if (username !== null && typeof username !== 'string') {
    throw new UserError(
      `Config file "${sourcePath}" has an invalid "username" (must be a string or null).`,
      INIT_HINT,
    );
  }
  if (typeof defaultInstance !== 'string' || defaultInstance.length === 0) {
    throw new UserError(
      `Config file "${sourcePath}" is missing a valid "defaultInstance" string.`,
      INIT_HINT,
    );
  }

  validateUrl(url);
  validateScriptRoot(scriptRoot);

  return {
    url,
    scriptRoot,
    allowSelfSigned,
    ...(certFingerprint === undefined ? {} : { certFingerprint: certFingerprint.toUpperCase() }),
    username,
    defaultInstance,
  };
}

/**
 * Walks up from `startDir` looking for `CONFIG_FILENAME`. Returns the directory that
 * contains it (the project root) plus the parsed, validated config.
 */
export async function loadConfig(startDir: string): Promise<{ root: string; config: Config }> {
  let dir = path.resolve(startDir);

  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (await pathExists(candidate)) {
      let raw: string;
      try {
        raw = await fs.readFile(candidate, 'utf8');
      } catch (err) {
        throw new UserError(`Could not read "${candidate}": ${(err as Error).message}`, INIT_HINT);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new UserError(
          `Could not parse "${candidate}" as JSON: ${(err as Error).message}`,
          INIT_HINT,
        );
      }

      const config = assertValidConfig(parsed, candidate);
      return { root: dir, config };
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new UserError(
    `Could not find ${CONFIG_FILENAME} in "${startDir}" or any parent directory.`,
    INIT_HINT,
  );
}

/** Writes the config file at `<root>/.iobroker-sync.json`. */
export async function writeConfig(root: string, config: Config): Promise<void> {
  const target = path.join(root, CONFIG_FILENAME);
  await fs.writeFile(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/** Fresh config for a newly-initialised project. */
export function defaultConfig(url: string): Config {
  validateUrl(url);
  return {
    url,
    scriptRoot: 'scripts',
    allowSelfSigned: false,
    username: null,
    defaultInstance: 'system.adapter.javascript.0',
  };
}
