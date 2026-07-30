/**
 * `iob-sync login` / `iob-sync logout` — manage the stored password for the
 * instance named in the project config.
 *
 * `login` verifies the password against the live instance *before* saving it, so a
 * typo is reported now rather than as a confusing failure on the next command.
 *
 * Like every other path that touches a password, nothing here accepts one as a CLI
 * argument: argv is world-readable via `ps` and lands in shell history.
 */

import { getAuthCookie } from '../client/auth';
import { deleteStoredPassword, credentialsPath, saveStoredPassword } from '../credentials';
import { Config, Logger, UserError } from '../types';
import { isInteractive, promptPassword, readPasswordFromStdin } from '../prompt';

export interface LoginOptions {
  passwordStdin?: boolean;
}

export async function login(config: Config, opts: LoginOptions, log: Logger): Promise<void> {
  let password: string;

  if (opts.passwordStdin) {
    password = await readPasswordFromStdin();
    if (!password) {
      throw new UserError('--password-stdin was given but nothing was read from stdin.');
    }
  } else if (isInteractive()) {
    password = await promptPassword(
      `Password for ${config.username ?? 'ioBroker'} at ${config.url}`,
    );
    if (!password) throw new UserError('No password entered.');
  } else {
    throw new UserError(
      'No terminal available to prompt for a password.',
      'Pipe it in with --password-stdin instead.',
    );
  }

  // Verify before storing. `allowPrompt: false` keeps getAuthCookie from asking
  // again; the password we just collected is supplied via the environment for the
  // duration of this call only, never written to argv.
  const previous = process.env.IOBROKER_PASSWORD;
  process.env.IOBROKER_PASSWORD = password;
  try {
    const cookie = await getAuthCookie(config.url, config.username, config.allowSelfSigned, {
      allowPrompt: false,
      warn: (msg) => log.warn(msg),
    });
    if (!cookie) {
      log.warn(`${config.url} does not require authentication; nothing was saved.`);
      return;
    }
  } finally {
    if (previous === undefined) delete process.env.IOBROKER_PASSWORD;
    else process.env.IOBROKER_PASSWORD = previous;
  }

  const file = await saveStoredPassword(config.url, config.username, password);
  log.result(`Password verified and saved to ${file} (owner-readable only).`);
}

export async function logout(config: Config, log: Logger): Promise<void> {
  const removed = await deleteStoredPassword(config.url, config.username);
  if (removed) {
    log.result(`Removed the stored password for ${config.url}.`);
  } else {
    log.info(`No stored password for ${config.url} (looked in ${credentialsPath()}).`);
  }
}
