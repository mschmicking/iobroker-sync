/**
 * Certificate pinning for instances that use a self-signed certificate.
 *
 * ioBroker refuses to accept a password over plain HTTP, so an instance with
 * authentication enabled is forced onto HTTPS — and a home instance signs its own
 * certificate. `allowSelfSigned` is what makes that connectable at all, but it also
 * removes the only thing that proves the server is really yours. Without a second
 * check, the tool would hand the password to anything answering on that address.
 *
 * The replacement check is the certificate's own SHA-256 fingerprint, remembered on
 * first use (`certFingerprint` in `.iobroker-sync.json`) and verified afterwards.
 * This is what `ssh` does with `known_hosts`, and it fails the same way: loudly, and
 * before anything secret is sent.
 *
 * Two layers, deliberately:
 *
 * 1. `probeCertificate` opens a bare TLS connection, reads the certificate and hangs
 *    up. No HTTP request, no cookie, no password. It exists so the mismatch question
 *    can be asked at a point where the answer still matters.
 * 2. `createPinnedAgent` re-checks on *every* connection. This is not redundant: an
 *    attacker sitting in the path can relay the probe untouched and interfere only
 *    with the connection that carries the credentials.
 *
 * Note that `rejectUnauthorized` is never assigned a literal `false` anywhere in this
 * file. It is always `!allowSelfSigned` — the value is the user's decision, not a
 * constant, and writing it as one misrepresents what the code does.
 */

import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';

import { writeConfig } from '../config';
import { isInteractive, promptYesNo } from '../prompt';
import { Config, Logger, UserError } from '../types';

/** How long to wait for the probe handshake before giving up. */
const PROBE_TIMEOUT_MS = 10000;

/**
 * Marks the failure as a pin mismatch rather than an ordinary network error.
 *
 * The check happens inside an agent, several layers below the code that can explain
 * it, and the socket error is all that survives the trip back up. A named class beats
 * matching on message text.
 */
export class CertificatePinError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `The server's TLS certificate does not match the pinned fingerprint.\n` +
        `  pinned: ${expected}\n` +
        `     now: ${actual}`,
    );
    this.name = 'CertificatePinError';
  }
}

/** The TLS half of the config, as the client layers need it. */
export interface TlsConfig {
  allowSelfSigned: boolean;
  certFingerprint?: string;
}

/**
 * Whether pinning is the right tool here.
 *
 * Only when certificate validation has actually been switched off. Over `http:` there
 * is no certificate, and with `allowSelfSigned: false` the usual CA chain already
 * establishes identity — pinning on top of that would add nothing but a way to break.
 */
export function pinningApplies(url: string, allowSelfSigned: boolean): boolean {
  if (!allowSelfSigned) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function hostAndPort(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port) || 443 };
}

/**
 * Opens a TLS connection purely to read the certificate, then closes it.
 *
 * Nothing is written to the socket. That is the whole point: this runs before the
 * password is sent, so a certificate the user ends up rejecting never sees it.
 */
export function probeCertificate(url: string, allowSelfSigned: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let target: { host: string; port: number };
    try {
      target = hostAndPort(url);
    } catch {
      reject(new UserError(`Invalid Admin URL: "${url}"`, 'Check the "url" field in your config.'));
      return;
    }

    // The handshake, the timeout and the error handler all race to end this; whichever
    // gets there first closes the socket and the rest become no-ops.
    let settled = false;
    const succeed = (fingerprint: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(fingerprint);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const socket = tls.connect(
      {
        host: target.host,
        port: target.port,
        // SNI is a hostname, and Node rejects an IP outright. Local instances are
        // routinely addressed as 127.0.0.1, so this has to be conditional.
        ...(net.isIP(target.host) ? {} : { servername: target.host }),
        rejectUnauthorized: !allowSelfSigned,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const fingerprint = cert?.fingerprint256;
        if (!fingerprint) {
          fail(
            new UserError(
              `${target.host}:${target.port} did not present a TLS certificate.`,
              'Check that the URL really is an HTTPS endpoint.',
            ),
          );
          return;
        }
        succeed(fingerprint.toUpperCase());
      },
    );

    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      fail(
        new UserError(
          `Timed out reading the TLS certificate of ${target.host}:${target.port}.`,
          'Check that the instance is running and reachable.',
        ),
      );
    });

    socket.on('error', (err: Error) => {
      fail(
        new UserError(
          `Could not read the TLS certificate of ${target.host}:${target.port}: ${err.message}`,
          'Check the URL and port in your config.',
        ),
      );
    });
  });
}

/**
 * An HTTPS agent that refuses any certificate but the pinned one.
 *
 * The check runs in the `secureConnect` callback — after the handshake, before the
 * agent hands the socket to `http.request`, so a mismatched server never receives the
 * request line, let alone the cookie or credentials. Destroying the socket with an
 * error is what surfaces the failure to the caller.
 *
 * `ws` accepts this via its `agent` option, so the websocket and the login requests
 * share one implementation.
 */
class PinnedAgent extends https.Agent {
  constructor(
    private readonly fingerprint: string,
    private readonly allowSelfSigned: boolean,
  ) {
    super();
  }

  createConnection(options: https.RequestOptions): tls.TLSSocket {
    const socket = tls.connect(
      {
        ...(options as tls.ConnectionOptions),
        rejectUnauthorized: !this.allowSelfSigned,
      },
      () => {
        const actual = socket.getPeerCertificate()?.fingerprint256?.toUpperCase() ?? '';
        if (actual !== this.fingerprint) {
          socket.destroy(new CertificatePinError(this.fingerprint, actual || '(none)'));
        }
      },
    );
    return socket;
  }
}

/**
 * Agent enforcing `tlsConfig`, or undefined when there is nothing to pin — in which
 * case callers should fall back to Node's defaults rather than passing an agent.
 */
export function createPinnedAgent(url: string, tlsConfig: TlsConfig): https.Agent | undefined {
  if (!tlsConfig.certFingerprint) return undefined;
  if (!pinningApplies(url, tlsConfig.allowSelfSigned)) return undefined;
  return new PinnedAgent(tlsConfig.certFingerprint, tlsConfig.allowSelfSigned);
}

/** Turns a pin failure from anywhere below into something worth reading. */
export function describePinFailure(err: unknown): UserError | undefined {
  if (!(err instanceof CertificatePinError)) return undefined;
  return new UserError(
    err.message,
    'If you reinstalled ioBroker or regenerated its certificate, run `iob-sync trust` ' +
      'to accept the new one. If you did not, do not — something is answering in its place.',
  );
}

export interface TrustOptions {
  log: Logger;
  /** Set false to never prompt, e.g. in tests. Defaults to whether a TTY is attached. */
  allowPrompt?: boolean;
}

/**
 * Establishes that the certificate is the expected one, before any credentials move.
 *
 * Three outcomes:
 *
 * - **No pin recorded** — trust on first use. The fingerprint is written to the config
 *   and reported. This is the only moment the tool trusts blindly, which is exactly
 *   the compromise `ssh` makes, and the alternative (making everyone read a
 *   fingerprint off their server before the first connection) is the reason nobody
 *   would turn this on.
 * - **Match** — silent. The overwhelmingly common case.
 * - **Mismatch** — ask, and update the pin only if the user says yes. Without a
 *   terminal there is nobody to ask, so it fails instead; continuing anyway would
 *   send the password to whatever is now answering.
 *
 * Returns the fingerprint every later connection must present, or undefined when
 * pinning does not apply to this instance.
 */
export async function ensureTrustedCertificate(
  root: string,
  config: Config,
  opts: TrustOptions,
): Promise<string | undefined> {
  if (!pinningApplies(config.url, config.allowSelfSigned)) return undefined;

  const actual = await probeCertificate(config.url, config.allowSelfSigned);
  const pinned = config.certFingerprint;

  if (!pinned) {
    await writeConfig(root, { ...config, certFingerprint: actual });
    config.certFingerprint = actual;
    opts.log.info(`Pinned the TLS certificate of ${config.url} (${actual}).`);
    return actual;
  }

  if (pinned === actual) {
    opts.log.debug(`certificate fingerprint matches the pinned one (${actual})`);
    return actual;
  }

  const mayPrompt = opts.allowPrompt ?? isInteractive();
  if (!mayPrompt || !isInteractive()) {
    throw new UserError(
      `The TLS certificate of ${config.url} has changed.\n` +
        `  pinned: ${pinned}\n` +
        `     now: ${actual}`,
      'Nothing was sent. If you reinstalled ioBroker or regenerated its certificate, ' +
        'run `iob-sync trust` to accept the new one.',
    );
  }

  opts.log.warn(`The TLS certificate of ${config.url} has changed.`);
  opts.log.warn(`  pinned: ${pinned}`);
  opts.log.warn(`     now: ${actual}`);
  opts.log.warn('This is normal after reinstalling ioBroker. If you did not expect it, answer n.');

  if (!(await promptYesNo('Trust the new certificate?', false))) {
    throw new UserError(
      'The new certificate was not trusted; nothing was sent.',
      'Run `iob-sync trust` once you are sure the certificate is genuine.',
    );
  }

  await writeConfig(root, { ...config, certFingerprint: actual });
  config.certFingerprint = actual;
  opts.log.info(`Pinned the new certificate (${actual}).`);
  return actual;
}
