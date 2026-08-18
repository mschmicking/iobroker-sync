/**
 * `iob-sync doctor` — check that this tool can reach, authenticate to and read from
 * the configured instance, and say so in words.
 *
 * It exists because of how the two most confusing failure modes present themselves.
 * A self-signed certificate that expired months ago is *fine* here — identity comes
 * from the pinned fingerprint, not the CA chain — but every other client on that port
 * rejects it, so the instance looks broken from the outside. And an unauthenticated
 * socket does not report an auth error at all: it connects, says `___ready___`, then
 * ignores commands until they time out. Both look like a broken instance and neither
 * is. Someone who only has the binary in front of them — no repository, no docs — has
 * nowhere to learn that, so the binary has to be the thing that says it.
 *
 * Deliberately not routed through `withContext`: that aborts at the first failing
 * step, and which step fails is the entire answer this command exists to give. It
 * runs the checks itself, keeps going while the next one is still knowable, and
 * reports the rest as skipped when it is not.
 *
 * Strictly read-only. It never prompts, never writes the config — in particular it
 * will not pin a certificate on first use, because a diagnostic that changes what it
 * diagnoses is worthless — and never writes to the server.
 */

import { AdminObjectsApi } from '../client/objects';
import { AdminSocketClient } from '../client/socket';
import { getAuthCookie } from '../client/auth';
import { CertificateInfo, pinningApplies, probeCertificateInfo } from '../client/tls';
import { loadManifest } from '../sync/manifest';
import { scanLocal, scanRemote } from '../sync/scan';
import { Config, Logger, ObjectsApi, UserError } from '../types';
import * as path from 'node:path';

export interface DoctorOptions {
  /**
   * Budget for the connect and round-trip probes. Deliberately shorter than the
   * client's 20s default: a diagnostic that takes half a minute to tell you the
   * session is dead is one people stop running.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  name: string;
  status: CheckStatus;
  /** One line, shown next to the name. */
  detail: string;
  /** Printed in full under the table. For things that look wrong but are not. */
  note?: string;
  /** What to do about it. Only meaningful for `fail`. */
  hint?: string;
}

const EXPIRED_CERT_NOTE =
  'iob-sync is unaffected by this: with allowSelfSigned the identity check is the ' +
  'pinned SHA-256 fingerprint, not the certificate chain, and an expired certificate ' +
  'signs exactly as well as a fresh one. Other clients talking to this instance will ' +
  'reject it until it is renewed.';

const SILENT_AUTH_NOTE =
  'The socket is open but the instance is ignoring commands. That is what an ' +
  'unauthenticated or expired session looks like — Admin sends no auth error, it ' +
  'simply stops answering.';

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `config` — nothing is checked here; `loadConfig` already failed loudly if it could not. */
function checkConfig(root: string, config: Config): Check {
  const who = config.username ? `as ${config.username}` : 'no username configured';
  return {
    name: 'config',
    status: 'ok',
    detail: `${root} (${config.url}, ${config.scriptRoot}/, ${who})`,
  };
}

/**
 * The verdict on a certificate, given what it says about itself.
 *
 * Separated from the probe so the interesting combinations — expired but pinned,
 * expired without a pin to fall back on — can be exercised without asking openssl to
 * mint a certificate that is already out of date.
 */
export function describeCertificate(config: Config, info: CertificateInfo): Check {
  const expired = info.validTo !== undefined && info.validTo.getTime() < Date.now();
  const pinned = config.certFingerprint;
  const applies = pinningApplies(config.url, config.allowSelfSigned);

  let check: Check;
  if (!applies) {
    check = {
      name: 'tls',
      status: 'ok',
      detail: `${info.subject || 'certificate'} validated against the system CA store`,
    };
  } else if (!pinned) {
    check = {
      name: 'tls',
      status: 'warn',
      detail: `no fingerprint pinned yet (${info.fingerprint}) — the next ordinary command records one`,
    };
  } else if (pinned === info.fingerprint) {
    check = { name: 'tls', status: 'ok', detail: 'pinned fingerprint matches' };
  } else {
    return {
      name: 'tls',
      status: 'fail',
      detail: `the certificate does not match the pinned fingerprint\n    pinned: ${pinned}\n       now: ${info.fingerprint}`,
      hint:
        'If you reinstalled ioBroker or regenerated its certificate, run `iob-sync trust` ' +
        'to accept the new one. If you did not, do not — something is answering in its place.',
    };
  }

  if (!expired || !info.validTo) {
    return check;
  }

  // Expired without a pin to fall back on is a real outage, and the probe above will
  // usually have failed already. With a pin it is cosmetic, and saying so is the point.
  if (!config.allowSelfSigned) {
    return {
      name: 'tls',
      status: 'fail',
      detail: `the certificate expired on ${isoDay(info.validTo)}`,
      hint: 'Renew the certificate on the instance, or set "allowSelfSigned": true and pin it.',
    };
  }

  return {
    ...check,
    detail: `${check.detail} — certificate expired ${isoDay(info.validTo)}, see note`,
    note: `The instance's TLS certificate (${info.subject || 'unknown subject'}) expired on ${isoDay(
      info.validTo,
    )}. ${EXPIRED_CERT_NOTE}`,
  };
}

async function checkTls(config: Config): Promise<Check> {
  let protocol: string;
  try {
    protocol = new URL(config.url).protocol;
  } catch {
    return { name: 'tls', status: 'fail', detail: `"${config.url}" is not a valid URL` };
  }
  if (protocol !== 'https:') {
    return { name: 'tls', status: 'ok', detail: 'plain http — no certificate involved' };
  }

  try {
    return describeCertificate(
      config,
      await probeCertificateInfo(config.url, config.allowSelfSigned),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'tls',
      status: 'fail',
      detail: message,
      hint: err instanceof UserError ? err.hint : undefined,
    };
  }
}

interface AuthResult {
  check: Check;
  cookie?: string;
}

async function checkAuth(config: Config, log: Logger): Promise<AuthResult> {
  // getAuthCookie reports which of the two login paths worked only on its debug
  // channel, and that is exactly the fact worth surfacing when a login is refused.
  let how: string | undefined;
  try {
    const cookie = await getAuthCookie(
      config.url,
      config.username,
      { allowSelfSigned: config.allowSelfSigned, certFingerprint: config.certFingerprint },
      {
        // Never prompt: doctor has to behave identically in a terminal and in a script.
        allowPrompt: false,
        warn: (msg) => log.warn(msg),
        debug: (msg) => {
          how = msg;
          log.debug(msg);
        },
      },
    );

    if (!cookie) {
      return {
        check: {
          name: 'auth',
          status: 'ok',
          detail: 'authentication is disabled on this instance — no cookie needed',
        },
      };
    }
    return {
      cookie,
      check: { name: 'auth', status: 'ok', detail: how ?? 'authenticated' },
    };
  } catch (err) {
    return {
      check: {
        name: 'auth',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        hint: err instanceof UserError ? err.hint : undefined,
      },
    };
  }
}

function skipped(name: string, why: string): Check {
  return { name, status: 'skip', detail: why };
}

/**
 * `markers` — `scriptEnabled` / `scriptProblem` states left behind by scripts that no
 * longer exist.
 *
 * Worth a check of its own because nothing else on the system will ever tell you. Every
 * javascript instance creates both markers for every non-global script — `load()` makes
 * them before `prepareScript` checks who owns the script — but only the owning instance
 * deletes them again. So each delete strands a pair on every other instance, and they do
 * nothing afterwards except make js-controller warn, forever, which is precisely the kind
 * of noise that trains people to ignore their logs.
 *
 * Counts both kinds. Reporting only `scriptEnabled` would have called a live instance
 * with eight orphaned `scriptProblem` states clean — it did, before this was fixed.
 *
 * A warning rather than a failure: nothing is broken, and this is a read-only command.
 */
async function checkScriptMarkers(objects: ObjectsApi, remoteIds: Set<string>): Promise<Check> {
  let entries;
  try {
    entries = await objects.listScriptMarkers();
  } catch (err) {
    return {
      name: 'markers',
      status: 'warn',
      detail: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const orphans = entries.filter((entry) => !remoteIds.has(entry.scriptId));
  const detail = `${entries.length} scriptEnabled/scriptProblem state(s) across all javascript instances, ${orphans.length} orphaned`;

  if (orphans.length === 0) {
    return { name: 'markers', status: 'ok', detail };
  }

  const halved = orphans.filter((entry) => entry.hasValue && !entry.hasObject).length;
  const scripts = Array.from(new Set(orphans.map((entry) => entry.scriptId))).sort();

  // The note, not the hint: report() only prints hints for failed checks, and this is
  // the one line someone reading a warning actually needs.
  return {
    name: 'markers',
    status: 'warn',
    detail,
    note:
      `${orphans.length} state(s) belong to scripts that no longer exist:\n` +
      orphans.map((entry) => `      ${entry.id}`).join('\n') +
      (halved > 0
        ? `\n    ${halved} of them ${halved === 1 ? 'is a value' : 'are values'} with no object ` +
          'behind them — that is what js-controller warns about.'
        : '') +
      '\n    Nothing is broken, and ioBroker never collects these itself. To clear them: ' +
      `${scripts.map((id) => `iob-sync remove ${id} --yes`).join(', ')} — ` +
      'remove sweeps the markers even when the script itself is already gone.',
  };
}

function statusLabel(status: CheckStatus): string {
  return status.toUpperCase().padEnd(4);
}

export async function doctor(
  root: string,
  config: Config,
  opts: DoctorOptions,
  log: Logger,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checks: Check[] = [checkConfig(root, config)];

  const tls = await checkTls(config);
  checks.push(tls);

  if (tls.status === 'fail') {
    const why = 'not attempted — the certificate check failed';
    checks.push(skipped('auth', why), skipped('socket', why), skipped('round-trip', why));
    checks.push(skipped('scripts', why), skipped('markers', why));
    return report(checks, log);
  }

  const auth = await checkAuth(config, log);
  checks.push(auth.check);

  if (auth.check.status === 'fail') {
    const why = 'not attempted — authentication failed';
    checks.push(
      skipped('socket', why),
      skipped('round-trip', why),
      skipped('scripts', why),
      skipped('markers', why),
    );
    return report(checks, log);
  }

  const socket = new AdminSocketClient({
    url: config.url,
    cookie: auth.cookie,
    allowSelfSigned: config.allowSelfSigned,
    certFingerprint: config.certFingerprint,
    connectTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs,
  });

  try {
    try {
      await socket.connect();
      checks.push({
        name: 'socket',
        status: 'ok',
        detail: 'connected, ___ready___ received',
      });
    } catch (err) {
      checks.push({
        name: 'socket',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        hint: err instanceof UserError ? err.hint : undefined,
      });
      const why = 'not attempted — the socket never became ready';
      checks.push(skipped('round-trip', why), skipped('scripts', why), skipped('markers', why));
      return report(checks, log);
    }

    // The check that actually distinguishes "connected" from "authenticated". Everything
    // above this line succeeds just as happily without a session cookie.
    const startedAt = Date.now();
    try {
      await socket.emit('getObject', [config.defaultInstance]);
      checks.push({
        name: 'round-trip',
        status: 'ok',
        detail: `getObject answered in ${Date.now() - startedAt}ms — the session is authenticated`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        name: 'round-trip',
        status: 'fail',
        detail: message,
        note: /timed out/i.test(message) ? SILENT_AUTH_NOTE : undefined,
        hint: /timed out/i.test(message)
          ? 'Run `iob-sync login` to refresh the stored password, then try again.'
          : undefined,
      });
      const why = 'not attempted — the instance did not answer';
      checks.push(skipped('scripts', why), skipped('markers', why));
      return report(checks, log);
    }

    const objects = new AdminObjectsApi(socket);
    let remoteIds: Set<string> | undefined;

    try {
      const [remote, local, manifest] = await Promise.all([
        scanRemote(objects),
        scanLocal(path.resolve(root, config.scriptRoot)),
        loadManifest(root, (msg) => log.warn(msg)),
      ]);
      remoteIds = new Set(remote.info.keys());
      const tracked = Object.keys(manifest.entries).length;
      checks.push({
        name: 'scripts',
        status: 'ok',
        detail: `${remote.info.size} remote, ${local.size} local, ${
          tracked > 0 ? `${tracked} tracked in the manifest` : 'no manifest yet'
        }`,
      });
    } catch (err) {
      checks.push({
        name: 'scripts',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        hint: err instanceof UserError ? err.hint : undefined,
      });
    }

    checks.push(
      remoteIds
        ? await checkScriptMarkers(objects, remoteIds)
        : skipped('markers', 'not attempted — the script list could not be read'),
    );
  } finally {
    await socket.close().catch(() => undefined);
  }

  return report(checks, log);
}

/**
 * Prints the table, then the notes, then a verdict on its own line.
 *
 * The verdict is deliberately one of three fixed words, so it can be grepped by
 * someone who did not read this file.
 */
function report(checks: Check[], log: Logger): void {
  const width = Math.max(...checks.map((c) => c.name.length));

  for (const check of checks) {
    log.result(`${check.name.padEnd(width)}  ${statusLabel(check.status)}  ${check.detail}`);
    log.data({
      type: 'check',
      name: check.name,
      status: check.status,
      detail: check.detail,
      ...(check.note ? { note: check.note } : {}),
      ...(check.hint ? { hint: check.hint } : {}),
    });
  }

  const failures = checks.filter((c) => c.status === 'fail');
  const notes = checks.filter((c) => c.note).map((c) => `${c.name}: ${c.note}`);

  if (notes.length > 0) {
    log.info('');
    for (const note of notes) {
      log.info(`  - ${note}`);
    }
  }

  log.data({
    type: 'doctor',
    ok: failures.length === 0,
    failed: failures.length,
    notes,
  });

  if (failures.length === 0) {
    log.info('');
    log.result(notes.length > 0 ? 'OK with notes.' : 'OK.');
    return;
  }

  // Thrown rather than printed, so the exit code says the same thing the last line does.
  throw new UserError(
    `FAILED: ${failures.length} check(s) did not pass (${failures.map((c) => c.name).join(', ')}).`,
    failures.find((c) => c.hint)?.hint,
  );
}
