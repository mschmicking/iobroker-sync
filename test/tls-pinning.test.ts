/**
 * Tests for certificate pinning (`src/client/tls.ts`).
 *
 * `allowSelfSigned` has to exist — ioBroker will not take a password over plain HTTP,
 * so an authenticated instance is on HTTPS with a self-signed certificate. But it
 * removes the only proof that the server is the right one, which left the tool willing
 * to hand its password to anything answering on that address. The pinned fingerprint
 * is what puts that check back.
 *
 * The assertions that matter most are the negative ones: on a mismatch, nothing may
 * reach the server. A check that merely reports the problem afterwards would be
 * worthless, because the password would already be gone.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { FakeAdminServer, tlsFixtureAvailable } from './fake-server';
import { getAuthCookie } from '../src/client/auth';
import { AdminSocketClient } from '../src/client/socket';
import { ensureTrustedCertificate, pinningApplies, probeCertificate } from '../src/client/tls';
import { trust } from '../src/commands/trust';
import { loadConfig, writeConfig } from '../src/config';
import { CONFIG_FILENAME, Config, UserError } from '../src/types';
import { TempProject, makeCapturingLogger, makeTempProject, testConfig } from './helpers';

const NO_PROMPT = { allowPrompt: false } as const;

/** A syntactically valid fingerprint that is definitely not the server's. */
const WRONG_PIN = new Array(32).fill('AA').join(':');

describe(
  'certificate pinning',
  { skip: tlsFixtureAvailable() ? false : 'openssl not available' },
  () => {
    let server: FakeAdminServer;
    let url: string;
    let project: TempProject;
    let realPin: string;

    before(async () => {
      server = new FakeAdminServer();
      url = `https://127.0.0.1:${await server.start(0, { tls: true })}`;
      realPin = await probeCertificate(url, true);
    });

    after(async () => {
      await server.stop();
    });

    beforeEach(async () => {
      server.reset();
      delete process.env.IOBROKER_PASSWORD;
      project = await makeTempProject();
    });

    afterEach(async () => {
      await project.cleanup();
    });

    /** Writes a config into the temp project and returns the loaded copy. */
    async function withConfig(overrides: Partial<Config> = {}): Promise<Config> {
      const config = testConfig({ url, allowSelfSigned: true, ...overrides });
      await writeConfig(project.root, config);
      return config;
    }

    describe('probeCertificate', () => {
      it('reads the fingerprint without sending anything', async () => {
        await probeCertificate(url, true);

        // The whole point of a separate probe: it happens before the mismatch
        // question is asked, so it must not carry a request of its own.
        assert.deepEqual(server.httpRequests, []);
      });

      it('returns a stable SHA-256 fingerprint', async () => {
        const again = await probeCertificate(url, true);

        assert.equal(again, realPin);
        assert.match(realPin, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      });

      it('reports an unreachable instance as a UserError', async () => {
        await assert.rejects(
          () => probeCertificate('https://127.0.0.1:1', true),
          (err: unknown) => {
            assert.ok(err instanceof UserError);
            assert.match(err.message, /certificate/i);
            return true;
          },
        );
      });
    });

    describe('pinningApplies', () => {
      it('applies only when validation has actually been switched off', () => {
        assert.equal(pinningApplies('https://host:8081', true), true);
        // Nothing to pin: the CA chain already establishes identity.
        assert.equal(pinningApplies('https://host:8081', false), false);
        // No certificate at all.
        assert.equal(pinningApplies('http://host:8081', true), false);
      });
    });

    describe('trust on first use', () => {
      it('records the fingerprint on the first connection', async () => {
        const config = await withConfig();
        const { log, captured } = makeCapturingLogger();

        const pin = await ensureTrustedCertificate(project.root, config, { log });

        assert.equal(pin, realPin);
        // Written through, so the next run has something to compare against.
        const { config: reloaded } = await loadConfig(project.root);
        assert.equal(reloaded.certFingerprint, realPin);
        // And said out loud — a silent pin is one the user can never audit.
        assert.ok(captured.all.some((line) => line.includes(realPin)));
      });

      it('stays silent when the fingerprint still matches', async () => {
        const config = await withConfig({ certFingerprint: realPin });
        const { log, captured } = makeCapturingLogger();

        const pin = await ensureTrustedCertificate(project.root, config, { log });

        assert.equal(pin, realPin);
        assert.deepEqual(captured.warn, []);
        assert.deepEqual(captured.info, []);
      });

      it('does nothing at all for a plain http instance', async () => {
        const config = await withConfig({ url: 'http://127.0.0.1:1', allowSelfSigned: false });
        const { log } = makeCapturingLogger();

        assert.equal(await ensureTrustedCertificate(project.root, config, { log }), undefined);
      });
    });

    describe('when the certificate changes', () => {
      it('refuses without a terminal, naming the way out', async () => {
        const config = await withConfig({ certFingerprint: WRONG_PIN });
        const { log } = makeCapturingLogger();

        await assert.rejects(
          () => ensureTrustedCertificate(project.root, config, { log, allowPrompt: false }),
          (err: unknown) => {
            assert.ok(err instanceof UserError);
            assert.match(err.message, /has changed/i);
            // A refusal the user cannot act on is just an outage.
            assert.match(String(err.hint), /iob-sync trust/);
            return true;
          },
        );
      });

      it('leaves the old pin in place when it refuses', async () => {
        const config = await withConfig({ certFingerprint: WRONG_PIN });
        const { log } = makeCapturingLogger();

        await ensureTrustedCertificate(project.root, config, {
          log,
          allowPrompt: false,
        }).catch(() => undefined);

        const { config: reloaded } = await loadConfig(project.root);
        assert.equal(reloaded.certFingerprint, WRONG_PIN);
      });
    });

    describe('the pinned agent', () => {
      it('lets the login through when the certificate matches', async () => {
        server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
        process.env.IOBROKER_PASSWORD = 'secret';

        const cookie = await getAuthCookie(
          url,
          'admin',
          { allowSelfSigned: true, certFingerprint: realPin },
          NO_PROMPT,
        );

        assert.equal(cookie, 'access_token=fake-oauth-token');
      });

      it('never sends the password to a certificate that does not match', async () => {
        server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
        process.env.IOBROKER_PASSWORD = 'secret';

        await assert.rejects(
          () =>
            getAuthCookie(
              url,
              'admin',
              { allowSelfSigned: true, certFingerprint: WRONG_PIN },
              NO_PROMPT,
            ),
          (err: unknown) => {
            assert.ok(err instanceof UserError);
            assert.match(err.message, /does not match the pinned fingerprint/i);
            return true;
          },
        );

        // The socket is destroyed after the handshake but before the request is
        // written, so the impostor learns nothing.
        assert.deepEqual(server.httpRequests, [], 'nothing may reach a mismatched server');
      });

      it('reports a mismatch as a certificate problem, not a network one', async () => {
        server.auth = { mode: 'oauth', username: 'admin', password: 'secret' };
        process.env.IOBROKER_PASSWORD = 'secret';

        const err = (await getAuthCookie(
          url,
          'admin',
          { allowSelfSigned: true, certFingerprint: WRONG_PIN },
          NO_PROMPT,
        ).catch((e: unknown) => e)) as UserError;

        // "Could not reach the instance" would send the user debugging their network
        // for a problem that is not there.
        assert.doesNotMatch(err.message, /could not reach/i);
        assert.match(String(err.hint), /iob-sync trust/);
      });

      it('carries the pin onto the websocket too', async () => {
        const socket = new AdminSocketClient({
          url,
          allowSelfSigned: true,
          certFingerprint: WRONG_PIN,
          connectTimeoutMs: 5000,
        });

        await assert.rejects(
          () => socket.connect(),
          (err: unknown) => {
            assert.ok(err instanceof UserError);
            assert.match(err.message, /does not match the pinned fingerprint/i);
            return true;
          },
        );
        await socket.close();
      });

      it('connects over the websocket when the pin is right', async () => {
        const socket = new AdminSocketClient({
          url,
          allowSelfSigned: true,
          certFingerprint: realPin,
          connectTimeoutMs: 5000,
        });

        await socket.connect();
        assert.equal(socket.connected, true);
        await socket.close();
      });
    });

    describe('iob-sync trust', () => {
      it('adopts the current certificate with --yes', async () => {
        const config = await withConfig({ certFingerprint: WRONG_PIN });
        const { log } = makeCapturingLogger();

        await trust(project.root, config, { yes: true }, log);

        const { config: reloaded } = await loadConfig(project.root);
        assert.equal(reloaded.certFingerprint, realPin);
      });

      it('says so and changes nothing when the pin is already correct', async () => {
        const config = await withConfig({ certFingerprint: realPin });
        const { log, captured } = makeCapturingLogger();

        await trust(project.root, config, { yes: true }, log);

        assert.ok(captured.result.some((line) => /already trusted/i.test(line)));
      });

      it('refuses on an instance where pinning means nothing', async () => {
        const config = await withConfig({ url: 'http://127.0.0.1:1', allowSelfSigned: false });
        const { log } = makeCapturingLogger();

        await assert.rejects(
          () => trust(project.root, config, { yes: true }, log),
          (err: unknown) => {
            assert.ok(err instanceof UserError);
            assert.match(err.message, /nothing to pin/i);
            return true;
          },
        );
      });
    });

    describe('config compatibility', () => {
      it('loads a config written before pinning existed', async () => {
        // Every 1.0.x config looks like this. Refusing them would break upgrades.
        const legacy = {
          url: 'http://127.0.0.1:8081',
          scriptRoot: 'scripts',
          allowSelfSigned: false,
          username: null,
          defaultInstance: 'system.adapter.javascript.0',
        };
        await fs.writeFile(
          path.join(project.root, CONFIG_FILENAME),
          JSON.stringify(legacy, null, 2),
          'utf8',
        );

        const { config } = await loadConfig(project.root);

        assert.equal(config.certFingerprint, undefined);
      });

      it('rejects a fingerprint that is not one', async () => {
        await fs.writeFile(
          path.join(project.root, CONFIG_FILENAME),
          JSON.stringify({ ...testConfig({ url }), certFingerprint: 'nonsense' }, null, 2),
          'utf8',
        );

        await assert.rejects(
          () => loadConfig(project.root),
          (err: unknown) => {
            assert.ok(err instanceof UserError);
            assert.match(err.message, /certFingerprint/);
            return true;
          },
        );
      });
    });
  },
);
