/**
 * `iob-sync logs` — streams the server's log output to the terminal.
 *
 * This closes the edit loop. `pull`/`push` cover editing, but after a push the
 * javascript adapter recompiles the script, and a syntax error or a throw on load
 * produces nothing the CLI can see: `push` reports success either way. Without this
 * the only way to find out is the Admin web UI, which defeats the point of the tool
 * and is invisible to anything driving it headlessly.
 *
 * Read-only: subscribing to logs never mutates the server.
 */

import { CommandContext, LOG_LEVELS, LogLevel, LogMessage, UserError } from '../types';

export interface LogsOptions {
  /** Only lines whose message or source mentions this (case-insensitive). */
  pattern?: string;
  /** Minimum severity to show. Defaults to `info`. */
  level?: string;
  /** Stop after this many lines. Unlimited when absent. */
  limit?: number;
}

/** A running log stream. Mirrors `WatchHandle`; signal handling belongs in cli.ts. */
export interface LogsHandle {
  stop(): Promise<void>;
  /** Resolves when `limit` lines have been seen; never resolves without a limit. */
  readonly finished: Promise<void>;
}

function severityRank(severity: string): number {
  const index = LOG_LEVELS.indexOf(severity as LogLevel);
  // Unknown severities are treated as `info` rather than dropped: an unrecognised
  // level must never silently hide an error.
  return index === -1 ? LOG_LEVELS.indexOf('info') : index;
}

function parseLevel(level: string | undefined): LogLevel {
  if (!level) return 'info';
  const normalized = level.toLowerCase() as LogLevel;
  if (!LOG_LEVELS.includes(normalized)) {
    throw new UserError(`Unknown log level "${level}".`, `Use one of: ${LOG_LEVELS.join(', ')}.`);
  }
  return normalized;
}

/** Local wall-clock time; ioBroker timestamps are epoch milliseconds. */
function formatTime(ts: number): string {
  const d = Number.isFinite(ts) ? new Date(ts) : new Date();
  return d.toTimeString().slice(0, 8);
}

export function formatLogLine(entry: LogMessage): string {
  const severity = (entry.severity || 'info').toUpperCase().padEnd(5);
  return `${formatTime(entry.ts)} ${severity} ${entry.from}  ${entry.message}`;
}

function matches(entry: LogMessage, pattern?: string): boolean {
  if (!pattern) return true;
  const needle = pattern.toLowerCase();
  // The script name is embedded in the message text, not a separate field, so
  // substring matching over message + source is the only thing available.
  return entry.message.toLowerCase().includes(needle) || entry.from.toLowerCase().includes(needle);
}

export async function logs(ctx: CommandContext, opts: LogsOptions = {}): Promise<LogsHandle> {
  const minRank = severityRank(parseLevel(opts.level));

  let seen = 0;
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  // Announced before subscribing, not after: the server logs our own connection, so
  // a line can arrive while `subscribe` is still in flight and print above the banner.
  ctx.log.info(
    `Streaming logs from ${ctx.config.url}${opts.pattern ? ` matching "${opts.pattern}"` : ''} ` +
      `at level ${parseLevel(opts.level)} and above.`,
  );

  await ctx.socket.subscribeLog((entry) => {
    if (severityRank(entry.severity) < minRank) return;
    if (!matches(entry, opts.pattern)) return;

    ctx.log.result(formatLogLine(entry));
    ctx.log.data({ type: 'log', ...entry });

    seen += 1;
    if (opts.limit !== undefined && seen >= opts.limit) {
      resolveFinished();
    }
  });

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    try {
      await ctx.socket.unsubscribeLog();
    } catch {
      // Best-effort: the socket is closed by whoever built the context.
    }
    resolveFinished();
  }

  return { stop, finished };
}
