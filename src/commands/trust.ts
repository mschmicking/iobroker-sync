/**
 * `iob-sync trust` — record the instance's current TLS certificate as the expected one.
 *
 * Normally the pin is recorded on first connection and never thought about again.
 * This command exists for the case where it changed: ioBroker was reinstalled, or its
 * certificate regenerated. Ordinary commands refuse to continue then, and in a script
 * or CI job there is nobody to ask — so there has to be one deliberate place to say
 * "yes, that new certificate is mine".
 *
 * It is separate from the prompt in `ensureTrustedCertificate` for exactly that
 * reason: accepting a changed certificate should be something the user goes and does,
 * not something a batch job can drift into.
 */

import { probeCertificate, pinningApplies } from '../client/tls';
import { writeConfig } from '../config';
import { isInteractive, promptYesNo } from '../prompt';
import { Config, Logger, UserError } from '../types';

export interface TrustOptions {
  /** Skip the confirmation. For non-interactive use, where there is nobody to ask. */
  yes?: boolean;
}

export async function trust(
  root: string,
  config: Config,
  opts: TrustOptions,
  log: Logger,
): Promise<void> {
  if (!pinningApplies(config.url, config.allowSelfSigned)) {
    throw new UserError(
      `Nothing to pin for ${config.url}.`,
      config.allowSelfSigned
        ? 'Certificate pinning only applies to https:// instances.'
        : 'This instance validates its certificate the normal way, so there is nothing ' +
            'for a pin to add. Pinning applies only when "allowSelfSigned" is true.',
    );
  }

  const actual = await probeCertificate(config.url, config.allowSelfSigned);
  const pinned = config.certFingerprint;

  if (pinned === actual) {
    log.result(`Already trusted: ${config.url} presents the pinned certificate (${actual}).`);
    return;
  }

  if (pinned) {
    log.warn(`The certificate of ${config.url} differs from the pinned one.`);
    log.warn(`  pinned: ${pinned}`);
    log.warn(`     now: ${actual}`);
  } else {
    log.info(`${config.url} presents certificate ${actual}.`);
  }

  if (!opts.yes) {
    if (!isInteractive()) {
      throw new UserError(
        'No terminal available to confirm the new certificate.',
        'Re-run with --yes if you are certain this certificate is genuine.',
      );
    }
    if (!(await promptYesNo('Trust this certificate from now on?', false))) {
      throw new UserError('Not trusted; the configured fingerprint is unchanged.');
    }
  }

  await writeConfig(root, { ...config, certFingerprint: actual });
  log.result(`Pinned ${actual} for ${config.url}.`);
}
