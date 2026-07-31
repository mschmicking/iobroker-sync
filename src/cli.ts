#!/usr/bin/env node
/**
 * iobroker-sync CLI entry point.
 *
 * Builds a CommandContext (config + connected socket + objects API) once, hands it
 * to the requested command, and guarantees the socket is closed afterwards.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { Command } from 'commander';

import { CommandContext, Logger, UserError } from './types';
import { loadConfig } from './config';
import { AdminSocketClient } from './client/socket';
import { AdminObjectsApi } from './client/objects';
import { getAuthCookie } from './client/auth';

import { runInit } from './commands/init';
import { pull } from './commands/pull';
import { push } from './commands/push';
import { status } from './commands/status';
import { diff } from './commands/diff';
import { watch } from './commands/watch';
import { list } from './commands/list';
import { backup } from './commands/backup';
import { logs } from './commands/logs';
import { start } from './commands/start';
import { stop, restart } from './commands/stop';
import { createNew } from './commands/new';
import { rename } from './commands/rename';
import { move } from './commands/move';
import { remove } from './commands/remove';
import { login, logout } from './commands/login';
import { setupTypes } from './commands/types';

/**
 * Read at runtime rather than hardcoded. The literal that used to live here said
 * 0.1.0 while the published package was 1.0.0 — release-please bumps package.json
 * and had no way to reach a string in the source, so `--version` lied to every
 * user. dist/cli.js sits one level below package.json in both the repository and
 * the installed package, so the relative path holds in both.
 */
const { version } = createRequire(__filename)('../package.json') as { version: string };

const program = new Command();

let verbose = false;

const colors = {
  enabled: process.stdout.isTTY && !process.env.NO_COLOR,
  dim: (s: string) => (colors.enabled ? `\x1b[2m${s}\x1b[0m` : s),
  yellow: (s: string) => (colors.enabled ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (colors.enabled ? `\x1b[31m${s}\x1b[0m` : s),
};

/**
 * Under `--json`, stdout carries **only** NDJSON — one JSON object per line.
 *
 * NDJSON rather than one accumulated array because `logs` and `watch` are unbounded
 * streams: an array could never be closed, and a consumer would see nothing until the
 * process ended. Line-at-a-time also means an agent watching stdout sees progress.
 * `jq -s .` slurps it into an array when a single document is wanted.
 *
 * Human chatter is suppressed so it cannot corrupt the stream; warnings and errors
 * still go to stderr, which keeps stdout parseable even when something goes wrong.
 */
let jsonMode = false;

const logger: Logger = {
  info: (msg) => {
    if (!jsonMode) console.log(msg);
  },
  warn: (msg) => console.warn(colors.yellow(`warning: ${msg}`)),
  error: (msg) => console.error(colors.red(`error: ${msg}`)),
  debug: (msg) => {
    if (verbose) console.error(colors.dim(`debug: ${msg}`));
  },
  result: (msg) => {
    if (!jsonMode) console.log(msg);
  },
  data: (payload) => {
    if (jsonMode) process.stdout.write(`${JSON.stringify(payload)}\n`);
  },
};

interface GlobalOptions {
  dryRun?: boolean;
  verbose?: boolean;
  cwd?: string;
  /**
   * Read the password from stdin. There is deliberately no `--password <value>`
   * counterpart: argv is visible to other processes via `ps` and is kept in shell
   * history. See src/credentials.ts.
   */
  passwordStdin?: boolean;
  /** Emit NDJSON on stdout instead of human-readable output. */
  json?: boolean;
}

/**
 * Resolves config, connects, and runs `fn` with a live context. The socket is
 * always closed, including on failure, so the process never hangs on an open handle.
 */
/**
 * Resolves on the first SIGINT. Long-running commands (`watch`) await this and
 * then shut themselves down, so the command itself stays free of signal
 * handling and can be driven directly by tests.
 */
function untilSigint(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSigint = (): void => {
      process.off('SIGINT', onSigint);
      resolve();
    };
    process.on('SIGINT', onSigint);
  });
}

async function withContext(
  globals: GlobalOptions,
  fn: (ctx: CommandContext) => Promise<void>,
): Promise<void> {
  const startDir = globals.cwd ? path.resolve(globals.cwd) : process.cwd();
  const { root, config } = await loadConfig(startDir);

  const cookie = await getAuthCookie(config.url, config.username, config.allowSelfSigned, {
    passwordStdin: globals.passwordStdin,
    warn: (msg) => logger.warn(msg),
    info: (msg) => logger.info(msg),
    debug: (msg) => logger.debug(msg),
  });
  const socket = new AdminSocketClient({
    url: config.url,
    cookie,
    allowSelfSigned: config.allowSelfSigned,
  });

  await socket.connect();
  logger.debug(`connected to ${config.url}`);

  const ctx: CommandContext = {
    root,
    config,
    scriptRoot: path.resolve(root, config.scriptRoot),
    objects: new AdminObjectsApi(socket),
    socket,
    dryRun: Boolean(globals.dryRun),
    log: logger,
  };

  try {
    await fn(ctx);
  } finally {
    await socket.close().catch(() => undefined);
  }
}

/** Wraps a command action so failures are reported consistently and set the exit code. */
function action(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err: unknown) {
      if (err instanceof UserError) {
        logger.error(err.message);
        if (err.hint) {
          console.error(colors.dim(err.hint));
        }
      } else {
        logger.error(err instanceof Error ? err.message : String(err));
        if (verbose && err instanceof Error && err.stack) {
          console.error(colors.dim(err.stack));
        }
      }
      process.exitCode = 1;
    }
  };
}

program
  .name('iob-sync')
  .description('Sync ioBroker scripts with a local folder')
  .version(version)
  .option('-n, --dry-run', 'show what would happen without changing anything')
  .option('-v, --verbose', 'verbose output')
  .option('-C, --cwd <dir>', 'run as if started in <dir>')
  .option('--password-stdin', 'read the ioBroker password from stdin')
  .option('--json', 'machine-readable NDJSON on stdout, one object per line')
  .hook('preAction', (thisCommand) => {
    verbose = Boolean(thisCommand.opts().verbose);
    jsonMode = Boolean(thisCommand.opts().json);
  });

const globals = (): GlobalOptions => program.opts<GlobalOptions>();

/** Working directory for this invocation: `-C <dir>` when given, else the real cwd. */
function resolveCwd(): string {
  const dir = globals().cwd;
  return dir ? path.resolve(dir) : process.cwd();
}

// --------------------------------------------------------------------------
// Sync
// --------------------------------------------------------------------------

program
  .command('init')
  .description('create .iobroker-sync.json and verify the connection (asks if run without flags)')
  .option('-u, --url <url>', 'ioBroker Admin URL, e.g. https://iobroker.local:8081')
  .option('-s, --script-root <dir>', 'folder for synced scripts')
  .option('-U, --username <name>', 'Admin username, when authentication is enabled')
  .option('-k, --allow-self-signed', 'accept a self-signed TLS certificate')
  .option('-t, --types', 'also set up tsconfig.json and ioBroker type definitions')
  .option('-f, --force', 'overwrite an existing config')
  .option('--no-interactive', 'never prompt; fail instead of asking')
  .action(function (this: Command) {
    const opts = this.opts();
    return action(async () => {
      const cwd = resolveCwd();
      await runInit(
        cwd,
        {
          url: opts.url,
          scriptRoot: opts.scriptRoot,
          username: opts.username,
          allowSelfSigned: opts.allowSelfSigned,
          types: opts.types,
          force: opts.force,
          interactive: opts.interactive,
        },
        logger,
      );
    })();
  });

program
  .command('login')
  .description('save the password for this instance (verified first, stored outside the repo)')
  // `--password-stdin` is a program-level option; redeclaring it here would be
  // shadowed by the parent and silently never set.
  .action(function (this: Command) {
    return action(async () => {
      const startDir = resolveCwd();
      const { config } = await loadConfig(startDir);
      await login(config, { passwordStdin: globals().passwordStdin }, logger);
    })();
  });

program
  .command('types')
  .description('set up editor intellisense for the pulled scripts (log, schedule, on, ...)')
  .option('-f, --force', 'replace an existing tsconfig.json in the script root')
  .option('--offline', 'skip downloading javascript.d.ts')
  .action(function (this: Command) {
    const opts = this.opts();
    return action(async () => {
      const { root, config } = await loadConfig(resolveCwd());
      await setupTypes(
        root,
        config.scriptRoot,
        { force: opts.force, offline: opts.offline },
        logger,
      );
    })();
  });

program
  .command('logout')
  .description('remove the stored password for this instance')
  .action(function (this: Command) {
    return action(async () => {
      const startDir = resolveCwd();
      const { config } = await loadConfig(startDir);
      await logout(config, logger);
    })();
  });

program
  .command('pull')
  .description('download scripts from ioBroker (never deletes local files)')
  .argument('[pattern]', 'only scripts matching this glob')
  .option('-f, --force', 'overwrite local changes and conflicts')
  .action(function (this: Command, pattern: string | undefined) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), (ctx) => pull(ctx, { pattern, force: opts.force })),
    )();
  });

program
  .command('push')
  .description('upload locally modified scripts (never deletes remote objects)')
  .argument('[pattern]', 'only scripts matching this glob')
  .option('-f, --force', 'push even when the server also changed (conflict)')
  .action(function (this: Command, pattern: string | undefined) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), (ctx) => push(ctx, { pattern, force: opts.force })),
    )();
  });

program
  .command('status')
  .description('show local vs server differences')
  .argument('[pattern]', 'only scripts matching this glob')
  .action(function (this: Command, pattern: string | undefined) {
    return action(() =>
      withContext(globals(), (ctx) => status(ctx, { pattern, verbose: globals().verbose })),
    )();
  });

program
  .command('diff')
  .description('unified diff of local vs server')
  .argument('[pattern]', 'only scripts matching this glob')
  .option(
    '-a, --against <snapshot>',
    'diff against a backup snapshot instead of the server ("latest" allowed)',
  )
  .action(function (this: Command, pattern: string | undefined) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), (ctx) => diff(ctx, { pattern, against: opts.against })),
    )();
  });

program
  .command('watch')
  .description('push scripts as you save them')
  .argument('[pattern]', 'only scripts matching this glob')
  .option('-p, --pull', 'also apply remote changes to local files')
  .action(function (this: Command, pattern: string | undefined) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), async (ctx) => {
        const handle = await watch(ctx, { pattern, pull: opts.pull });
        ctx.log.info('Press Ctrl+C to stop.');
        await untilSigint();
        ctx.log.info('Stopping watch...');
        await handle.stop();
      }),
    )();
  });

program
  .command('logs')
  .description('stream the server log (read-only); Ctrl+C to stop')
  .argument('[pattern]', 'only lines mentioning this text')
  .option('-l, --level <level>', 'minimum severity: silly, debug, info, warn, error', 'info')
  .option('--limit <n>', 'stop after n lines', (v: string) => Number.parseInt(v, 10))
  .action(function (this: Command, pattern: string | undefined) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), async (ctx) => {
        const handle = await logs(ctx, { pattern, level: opts.level, limit: opts.limit });
        if (opts.limit === undefined) ctx.log.info('Press Ctrl+C to stop.');
        // Whichever comes first: the line limit, or the user interrupting.
        await Promise.race([handle.finished, untilSigint()]);
        await handle.stop();
      }),
    )();
  });

program
  .command('backup')
  .description('snapshot every script (source + full object) to .iobroker-sync/backup/')
  .argument('[pattern]', 'only scripts matching this glob')
  .action(function (this: Command, pattern: string | undefined) {
    return action(() =>
      withContext(globals(), async (ctx) => {
        await backup(ctx, { pattern });
      }),
    )();
  });

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

program
  .command('list')
  .alias('ls')
  .description('list scripts with their instance and enabled state')
  .argument('[pattern]', 'only scripts matching this glob')
  .action(function (this: Command, pattern: string | undefined) {
    return action(() => withContext(globals(), (ctx) => list(ctx, { pattern })))();
  });

program
  .command('start')
  .description('enable scripts')
  .argument('<pattern>', 'scripts to start')
  .action(function (this: Command, pattern: string) {
    return action(() => withContext(globals(), (ctx) => start(ctx, { pattern })))();
  });

program
  .command('stop')
  .description('disable scripts')
  .argument('<pattern>', 'scripts to stop')
  .action(function (this: Command, pattern: string) {
    return action(() => withContext(globals(), (ctx) => stop(ctx, { pattern })))();
  });

program
  .command('restart')
  .description('disable then re-enable scripts')
  .argument('<pattern>', 'scripts to restart')
  .action(function (this: Command, pattern: string) {
    return action(() => withContext(globals(), (ctx) => restart(ctx, { pattern })))();
  });

program
  .command('new')
  .description('create a new, stopped script')
  .argument('<path>', 'path relative to the script root, e.g. common/my-script.ts')
  .option('-i, --instance <n>', 'javascript instance (number or full id)')
  .action(function (this: Command, relPath: string) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), (ctx) => createNew(ctx, relPath, { instance: opts.instance })),
    )();
  });

// --------------------------------------------------------------------------
// Destructive — each requires --yes and writes a backup first
// --------------------------------------------------------------------------

program
  .command('rename')
  .description('rename a script (copy, verify, then delete the original)')
  .argument('<id>', 'ioBroker script id')
  .argument('<newName>', 'new name (last segment only)')
  .option('-y, --yes', 'actually perform the rename')
  .action(function (this: Command, id: string, newName: string) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), (ctx) => rename(ctx, id, newName, { yes: opts.yes })),
    )();
  });

program
  .command('move')
  .description('move a script to another folder (copy, verify, then delete the original)')
  .argument('<id>', 'ioBroker script id')
  .argument('<folder>', 'target folder relative to the script root, "" for root')
  .option('-y, --yes', 'actually perform the move')
  .action(function (this: Command, id: string, folder: string) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), (ctx) => move(ctx, id, folder, { yes: opts.yes })),
    )();
  });

program
  .command('remove')
  .alias('rm')
  .description('delete a script from ioBroker (keeps the local file by default)')
  .argument('<id>', 'ioBroker script id')
  .option('-y, --yes', 'actually perform the deletion')
  .option('--delete-local', 'also delete the local file')
  .action(function (this: Command, id: string) {
    const opts = this.opts();
    return action(() =>
      withContext(globals(), (ctx) =>
        remove(ctx, id, { yes: opts.yes, deleteLocal: opts.deleteLocal }),
      ),
    )();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
