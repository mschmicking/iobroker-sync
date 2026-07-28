#!/usr/bin/env node
/**
 * iobroker-sync CLI entry point.
 *
 * Builds a CommandContext (config + connected socket + objects API) once, hands it
 * to the requested command, and guarantees the socket is closed afterwards.
 */

import * as path from 'node:path';
import { Command } from 'commander';

import { CommandContext, Config, Logger, UserError } from './types';
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
import { start } from './commands/start';
import { stop, restart } from './commands/stop';
import { createNew } from './commands/new';
import { rename } from './commands/rename';
import { move } from './commands/move';
import { remove } from './commands/remove';

const program = new Command();

let verbose = false;

const colors = {
  enabled: process.stdout.isTTY && !process.env.NO_COLOR,
  dim: (s: string) => (colors.enabled ? `\x1b[2m${s}\x1b[0m` : s),
  yellow: (s: string) => (colors.enabled ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (colors.enabled ? `\x1b[31m${s}\x1b[0m` : s),
};

const logger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(colors.yellow(`warning: ${msg}`)),
  error: (msg) => console.error(colors.red(`error: ${msg}`)),
  debug: (msg) => {
    if (verbose) console.error(colors.dim(`debug: ${msg}`));
  },
  result: (msg) => console.log(msg),
};

interface GlobalOptions {
  dryRun?: boolean;
  verbose?: boolean;
  cwd?: string;
}

/**
 * Resolves config, connects, and runs `fn` with a live context. The socket is
 * always closed, including on failure, so the process never hangs on an open handle.
 */
async function withContext(
  globals: GlobalOptions,
  fn: (ctx: CommandContext) => Promise<void>,
): Promise<void> {
  const startDir = globals.cwd ? path.resolve(globals.cwd) : process.cwd();
  const { root, config } = await loadConfig(startDir);

  const cookie = await getAuthCookie(config.url, config.username, config.allowSelfSigned);
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
    } catch (err) {
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
  .version('0.1.0')
  .option('-n, --dry-run', 'show what would happen without changing anything')
  .option('-v, --verbose', 'verbose output')
  .option('-C, --cwd <dir>', 'run as if started in <dir>')
  .hook('preAction', (thisCommand) => {
    verbose = Boolean(thisCommand.opts().verbose);
  });

const globals = (): GlobalOptions => program.opts<GlobalOptions>();

// --------------------------------------------------------------------------
// Sync
// --------------------------------------------------------------------------

program
  .command('init')
  .description('create .iobroker-sync.json and verify the connection')
  .requiredOption('-u, --url <url>', 'ioBroker Admin URL, e.g. http://192.168.1.13:8081')
  .option('-s, --script-root <dir>', 'folder for synced scripts', 'scripts')
  .option('-t, --types', 'also set up tsconfig.json and ioBroker type definitions')
  .option('-f, --force', 'overwrite an existing config')
  .action(function (this: Command) {
    const opts = this.opts();
    return action(async () => {
      const cwd = globals().cwd ? path.resolve(globals().cwd!) : process.cwd();
      await runInit(cwd, { url: opts.url, scriptRoot: opts.scriptRoot, types: opts.types, force: opts.force }, logger);
    })();
  });

program
  .command('pull')
  .description('download scripts from ioBroker (never deletes local files)')
  .argument('[pattern]', 'only scripts matching this glob')
  .option('-f, --force', 'overwrite local changes and conflicts')
  .action(function (this: Command, pattern: string | undefined) {
    const opts = this.opts();
    return action(() => withContext(globals(), (ctx) => pull(ctx, { pattern, force: opts.force })))();
  });

program
  .command('push')
  .description('upload locally modified scripts (never deletes remote objects)')
  .argument('[pattern]', 'only scripts matching this glob')
  .option('-f, --force', 'push even when the server also changed (conflict)')
  .action(function (this: Command, pattern: string | undefined) {
    const opts = this.opts();
    return action(() => withContext(globals(), (ctx) => push(ctx, { pattern, force: opts.force })))();
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
  .action(function (this: Command, pattern: string | undefined) {
    return action(() => withContext(globals(), (ctx) => diff(ctx, { pattern })))();
  });

program
  .command('watch')
  .description('push scripts as you save them')
  .argument('[pattern]', 'only scripts matching this glob')
  .option('-p, --pull', 'also apply remote changes to local files')
  .action(function (this: Command, pattern: string | undefined) {
    const opts = this.opts();
    return action(() => withContext(globals(), (ctx) => watch(ctx, { pattern, pull: opts.pull })))();
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
    return action(() => withContext(globals(), (ctx) => rename(ctx, id, newName, { yes: opts.yes })))();
  });

program
  .command('move')
  .description('move a script to another folder (copy, verify, then delete the original)')
  .argument('<id>', 'ioBroker script id')
  .argument('<folder>', 'target folder relative to the script root, "" for root')
  .option('-y, --yes', 'actually perform the move')
  .action(function (this: Command, id: string, folder: string) {
    const opts = this.opts();
    return action(() => withContext(globals(), (ctx) => move(ctx, id, folder, { yes: opts.yes })))();
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
      withContext(globals(), (ctx) => remove(ctx, id, { yes: opts.yes, deleteLocal: opts.deleteLocal })),
    )();
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
