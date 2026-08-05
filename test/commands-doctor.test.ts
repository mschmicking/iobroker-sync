/**
 * Tests for `iob-sync doctor`.
 *
 * The command exists to be believed by someone who has nothing but the binary, so the
 * assertions here are mostly about what it *says*. Two cases carry the weight:
 *
 * - a socket that connected but was never authenticated must be reported as such, not
 *   as a timeout, because the instance gives no other signal that anything is wrong;
 * - an expired self-signed certificate behind a matching pin must be reported as fine,
 *   because it is, and because everything else pointed at that port says otherwise.
 *
 * The certificate verdicts are exercised through `describeCertificate` rather than a
 * real handshake: the interesting combinations involve dates in the past, and minting
 * an already-expired certificate per run buys nothing over passing one in.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeAdminServer, defaultSeed, tlsFixtureAvailable } from './fake-server';
import {
  TempProject,
  makeCapturingLogger,
  makeTempProject,
  testConfig,
  writeLocal,
} from './helpers';
import { describeCertificate, doctor } from '../src/commands/doctor';
import { CertificateInfo, probeCertificate } from '../src/client/tls';
import { loadConfig, writeConfig } from '../src/config';
import { Config, UserError } from '../src/types';

/** Short, because every failing check here is a deliberate timeout. */
const FAST = { timeoutMs: 700 } as const;

/** A syntactically valid fingerprint that is definitely not the server's. */
const WRONG_PIN = new Array(32).fill('AA').join(':');

interface Ran {
  captured: ReturnType<typeof makeCapturingLogger>['captured'];
  error?: UserError;
}

/** Runs doctor, capturing output and the UserError it throws when a check fails. */
async function run(root: string, config: Config, opts = FAST): Promise<Ran> {
  const { log, captured } = makeCapturingLogger();
  try {
    await doctor(root, config, opts, log);
    return { captured };
  } catch (err) {
    assert.ok(err instanceof UserError, `expected a UserError, got ${String(err)}`);
    return { captured, error: err };
  }
}

/** The status doctor reported for one check, read back out of its NDJSON records. */
function statusOf(captured: Ran['captured'], name: string): string | undefined {
  const record = captured.data.find(
    (d) =>
      (d as { type?: string; name?: string }).type === 'check' &&
      (d as { name?: string }).name === name,
  ) as { status?: string } | undefined;
  return record?.status;
}

function detailOf(captured: Ran['captured'], name: string): string {
  const record = captured.data.find(
    (d) =>
      (d as { type?: string; name?: string }).type === 'check' &&
      (d as { name?: string }).name === name,
  ) as { detail?: string; note?: string } | undefined;
  return `${record?.detail ?? ''} ${record?.note ?? ''}`;
}

describe('doctor', () => {
  let server: FakeAdminServer;
  let port: number;
  let project: TempProject;

  before(async () => {
    server = new FakeAdminServer();
    port = await server.start();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    server.seed(defaultSeed());
    delete process.env.IOBROKER_PASSWORD;
    project = await makeTempProject();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  function config(overrides: Partial<Config> = {}): Config {
    return testConfig({ url: `http://127.0.0.1:${port}`, ...overrides });
  }

  describe('a healthy instance', () => {
    it('passes every check and says so in one greppable word', async () => {
      await writeLocal(project, 'common/garage.ts', 'console.log("garage");');

      const { captured, error } = await run(project.root, config());

      assert.equal(error, undefined);
      for (const name of ['config', 'tls', 'auth', 'socket', 'round-trip', 'scripts']) {
        assert.equal(statusOf(captured, name), 'ok', `${name} should have passed`);
      }
      assert.ok(captured.result.includes('OK.'));
    });

    it('counts both sides of the sync', async () => {
      await writeLocal(project, 'common/garage.ts', 'console.log("garage");');

      const { captured } = await run(project.root, config());

      // Four scripts in defaultSeed(), one on disk, nothing pulled yet.
      assert.match(detailOf(captured, 'scripts'), /4 remote, 1 local, no manifest yet/);
    });

    it('emits one record per check plus a verdict under --json', async () => {
      const { captured } = await run(project.root, config());

      const checks = captured.data.filter((d) => (d as { type?: string }).type === 'check');
      const verdicts = captured.data.filter((d) => (d as { type?: string }).type === 'doctor');
      assert.equal(checks.length, 6);
      assert.deepEqual(verdicts, [{ type: 'doctor', ok: true, failed: 0, notes: [] }]);
    });
  });

  describe('a socket that is open but not authenticated', () => {
    it('names the cause instead of reporting a bare timeout', async () => {
      // Auth stays "disabled" over HTTP, so no cookie is fetched — exactly what
      // happens to anyone driving the client without one.
      server.requireCookieOnSocket = true;

      const { captured, error } = await run(project.root, config());

      assert.equal(
        statusOf(captured, 'socket'),
        'ok',
        'the socket does connect — that is the trap',
      );
      assert.equal(statusOf(captured, 'round-trip'), 'fail');
      assert.match(detailOf(captured, 'round-trip'), /unauthenticated or expired session/i);
      assert.match(String(error?.message), /FAILED: 1 check\(s\).*round-trip/);
    });

    it('points at a way out rather than just refusing', async () => {
      server.requireCookieOnSocket = true;

      const { error } = await run(project.root, config());

      assert.match(String(error?.hint), /iob-sync login/);
    });

    it('does not pretend to know anything it never got to check', async () => {
      server.requireCookieOnSocket = true;

      const { captured } = await run(project.root, config());

      assert.equal(statusOf(captured, 'scripts'), 'skip');
    });
  });

  describe('when the password is missing', () => {
    it('fails at auth and skips everything downstream', async () => {
      server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };

      const { captured, error } = await run(project.root, config({ username: 'admin' }));

      assert.equal(statusOf(captured, 'auth'), 'fail');
      for (const name of ['socket', 'round-trip', 'scripts']) {
        assert.equal(statusOf(captured, name), 'skip', `${name} was not knowable`);
      }
      assert.match(String(error?.hint), /iob-sync login/);
    });

    it('never prompts, so it behaves the same in a script as in a terminal', async () => {
      server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };

      // A prompt would hang here forever rather than fail; the timeout is the assertion.
      const { captured } = await run(project.root, config({ username: 'admin' }));

      assert.match(detailOf(captured, 'auth'), /no password was available/i);
    });
  });

  describe('certificate verdicts', () => {
    const base = testConfig({ url: 'https://iobroker.local:8081', allowSelfSigned: true });

    function cert(overrides: Partial<CertificateInfo> = {}): CertificateInfo {
      return {
        fingerprint: WRONG_PIN,
        subject: 'CN=iobroker',
        issuer: 'CN=iobroker',
        validFrom: new Date('2025-01-09T00:00:00Z'),
        validTo: new Date('2027-01-09T00:00:00Z'),
        ...overrides,
      };
    }

    it('passes a pinned certificate that matches', () => {
      const check = describeCertificate({ ...base, certFingerprint: WRONG_PIN }, cert());

      assert.equal(check.status, 'ok');
      assert.equal(check.note, undefined);
    });

    it('calls an expired certificate fine when a matching pin carries the identity', () => {
      const check = describeCertificate(
        { ...base, certFingerprint: WRONG_PIN },
        cert({ validTo: new Date('2026-01-09T00:00:00Z') }),
      );

      // The whole point: this is the state the live instance is in, and it is not a fault.
      assert.equal(check.status, 'ok');
      assert.match(check.detail, /expired 2026-01-09/);
      assert.match(String(check.note), /pinned SHA-256 fingerprint, not the certificate chain/);
      assert.match(String(check.note), /Other clients/);
    });

    it('calls the same certificate a failure when nothing else establishes identity', () => {
      const check = describeCertificate(
        { ...base, allowSelfSigned: false, certFingerprint: undefined },
        cert({ validTo: new Date('2026-01-09T00:00:00Z') }),
      );

      assert.equal(check.status, 'fail');
      assert.match(check.detail, /expired on 2026-01-09/);
    });

    it('warns rather than fails when nothing has been pinned yet', () => {
      const check = describeCertificate({ ...base, certFingerprint: undefined }, cert());

      assert.equal(check.status, 'warn');
      assert.match(check.detail, /no fingerprint pinned yet/);
    });

    it('fails a mismatch and names the command that resolves it', () => {
      const check = describeCertificate(
        { ...base, certFingerprint: new Array(32).fill('BB').join(':') },
        cert(),
      );

      assert.equal(check.status, 'fail');
      assert.match(String(check.hint), /iob-sync trust/);
    });
  });

  describe(
    'against a real TLS handshake',
    {
      skip: tlsFixtureAvailable() ? false : 'openssl not available',
    },
    () => {
      let tlsServer: FakeAdminServer;
      let tlsUrl: string;
      let realPin: string;

      before(async () => {
        tlsServer = new FakeAdminServer();
        tlsUrl = `https://127.0.0.1:${await tlsServer.start(0, { tls: true })}`;
        realPin = await probeCertificate(tlsUrl, true);
      });

      after(async () => {
        await tlsServer.stop();
      });

      beforeEach(() => {
        tlsServer.reset();
        tlsServer.seed(defaultSeed());
      });

      it('passes when the instance presents the pinned certificate', async () => {
        const cfg = testConfig({ url: tlsUrl, allowSelfSigned: true, certFingerprint: realPin });

        const { captured, error } = await run(project.root, cfg);

        assert.equal(error, undefined);
        assert.equal(statusOf(captured, 'tls'), 'ok');
        assert.equal(statusOf(captured, 'round-trip'), 'ok');
      });

      it('stops at the certificate and sends nothing when the pin does not match', async () => {
        const cfg = testConfig({ url: tlsUrl, allowSelfSigned: true, certFingerprint: WRONG_PIN });

        const { captured } = await run(project.root, cfg);

        assert.equal(statusOf(captured, 'tls'), 'fail');
        assert.equal(statusOf(captured, 'auth'), 'skip');
        // A diagnostic must not be the thing that hands credentials to an impostor.
        assert.deepEqual(tlsServer.httpRequests, []);
      });

      it('reports an unpinned instance without quietly pinning it', async () => {
        const cfg = testConfig({ url: tlsUrl, allowSelfSigned: true });
        await writeConfig(project.root, cfg);

        const { captured } = await run(project.root, cfg);

        assert.equal(statusOf(captured, 'tls'), 'warn');
        // Trust on first use belongs to the commands that then send something. A
        // diagnostic that changes what it diagnoses cannot be run to find out where
        // you stand.
        const { config: reloaded } = await loadConfig(project.root);
        assert.equal(reloaded.certFingerprint, undefined);
      });
    },
  );
});
