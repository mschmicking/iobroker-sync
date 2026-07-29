/**
 * Tests for the CLI surface itself, by spawning `dist/cli.js`.
 *
 * These exist because of a real bug that every other kind of test missed:
 * `--password-stdin` was declared both globally and on the `login` subcommand, and
 * commander lets the parent shadow the child — so the subcommand's copy was silently
 * never set and `login --password-stdin` reported "no terminal available". Nothing
 * short of real argv parsing catches that.
 *
 * They spawn the built CLI, so `npm run build` (or the tsc equivalent) must have run.
 * Every case is offline: either argv handling, or a failure that happens before any
 * network call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { makeTempProject } from './helpers';

const execFileAsync = promisify(execFile);

const CLI = path.resolve(process.cwd(), 'dist', 'cli.js');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<RunResult> {
  try {
    const child = execFileAsync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30000,
    });
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input);
    }
    const { stdout, stderr } = await child;
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('cli argv handling', () => {
  it('lists every command in --help', async () => {
    const { stdout, code } = await runCli(['--help']);

    assert.equal(code, 0);
    for (const command of [
      'init', 'login', 'logout', 'pull', 'push', 'status', 'diff',
      'watch', 'logs', 'list', 'backup', 'start', 'stop', 'new', 'remove',
    ]) {
      assert.match(stdout, new RegExp(`\\b${command}\\b`), `--help should mention "${command}"`);
    }
  });

  it('exposes the global options', async () => {
    const { stdout } = await runCli(['--help']);

    assert.match(stdout, /--dry-run/);
    assert.match(stdout, /--json/);
    assert.match(stdout, /--password-stdin/);
    assert.match(stdout, /--verbose/);
  });

  it('offers no --password flag, which would leak via ps and shell history', async () => {
    const { stdout } = await runCli(['--help']);
    const loginHelp = await runCli(['login', '--help']);

    assert.doesNotMatch(stdout, /--password[ =]<|--password </);
    assert.doesNotMatch(loginHelp.stdout, /--password[ =]<|--password </);
  });

  it('routes --password-stdin to login rather than shadowing it', async () => {
    // The regression: a duplicate declaration on the subcommand meant the parent
    // consumed the flag and `login` fell through to "no terminal available".
    const project = await makeTempProject();
    try {
      await fs.writeFile(
        path.join(project.root, '.iobroker-sync.json'),
        JSON.stringify({
          url: 'http://127.0.0.1:1',
          scriptRoot: 'scripts',
          allowSelfSigned: false,
          username: 'admin',
          defaultInstance: 'system.adapter.javascript.0',
        }),
        'utf8',
      );

      const { stderr, code } = await runCli(
        ['--password-stdin', '-C', project.root, 'login'],
        { input: 'whatever\n' },
      );

      assert.notEqual(code, 0);
      // It must fail trying to *reach* the instance, proving it read the password,
      // not by claiming it had no way to ask for one.
      assert.doesNotMatch(stderr, /no terminal available/i);
      assert.match(stderr, /could not reach|connect/i);
    } finally {
      await project.cleanup();
    }
  });

  it('reports a missing config as a clean UserError, not a stack trace', async () => {
    const project = await makeTempProject();
    try {
      const { stderr, stdout, code } = await runCli(['-C', project.root, 'list']);

      assert.notEqual(code, 0);
      assert.match(stderr, /Could not find \.iobroker-sync\.json/);
      assert.doesNotMatch(stderr, /at .*\(.*:\d+:\d+\)/, 'no stack frames for expected failures');
      assert.equal(stdout.trim(), '', 'stdout stays clean on failure');
    } finally {
      await project.cleanup();
    }
  });

  it('keeps stdout empty under --json when a command fails', async () => {
    const project = await makeTempProject();
    try {
      const { stdout, stderr, code } = await runCli(['--json', '-C', project.root, 'status']);

      assert.notEqual(code, 0);
      assert.equal(stdout.trim(), '', 'a consumer must never parse an error as a record');
      assert.match(stderr, /Could not find/);
    } finally {
      await project.cleanup();
    }
  });

  it('exits non-zero on an unknown command', async () => {
    const { code } = await runCli(['no-such-command']);

    assert.notEqual(code, 0);
  });

  it('rejects an unknown log level before connecting', async () => {
    const project = await makeTempProject();
    try {
      await fs.writeFile(
        path.join(project.root, '.iobroker-sync.json'),
        JSON.stringify({
          url: 'http://127.0.0.1:1',
          scriptRoot: 'scripts',
          allowSelfSigned: false,
          username: null,
          defaultInstance: 'system.adapter.javascript.0',
        }),
        'utf8',
      );

      const { code } = await runCli(['-C', project.root, 'logs', '--level', 'nonsense']);
      assert.notEqual(code, 0);
    } finally {
      await project.cleanup();
    }
  });

  it('fails init without a url when told not to prompt', async () => {
    const project = await makeTempProject();
    try {
      const { stderr, code } = await runCli(['-C', project.root, 'init', '--no-interactive']);

      assert.notEqual(code, 0);
      assert.match(stderr, /no --url/i);
    } finally {
      await project.cleanup();
    }
  });

  it('prints the version', async () => {
    const { stdout, code } = await runCli(['--version']);

    assert.equal(code, 0);
    assert.match(stdout, /\d+\.\d+\.\d+/);
  });
});
