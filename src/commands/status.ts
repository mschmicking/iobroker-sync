/**
 * `iob-sync status` — grouped, human-readable sync status report.
 */

import { CommandContext, SyncState, SyncStatus } from '../types';
import { loadManifest } from '../sync/manifest';
import { computeStatus } from '../sync/compare';
import { scanLocal, scanRemote, matchesPattern } from '../sync/scan';

export interface StatusOptions {
  pattern?: string;
  /** Also list `in-sync` entries individually instead of just a count. */
  verbose?: boolean;
}

const GROUP_ORDER: SyncState[] = [
  'conflict',
  'local-modified',
  'remote-modified',
  'local-only',
  'remote-only',
  'remote-missing',
  'in-sync',
];

const GROUP_LABELS: Record<SyncState, string> = {
  conflict: 'CONFLICT',
  'local-modified': 'LOCAL-MODIFIED',
  'remote-modified': 'REMOTE-MODIFIED',
  'local-only': 'LOCAL-ONLY',
  'remote-only': 'REMOTE-ONLY',
  'remote-missing': 'REMOTE-MISSING',
  'in-sync': 'IN-SYNC',
};

function matches(status: SyncStatus, pattern?: string): boolean {
  return matchesPattern(status.path, pattern) || matchesPattern(status.id, pattern);
}

function formatEntry(status: SyncStatus): string {
  const pathCol = status.path.padEnd(48);
  return `  ${pathCol} ${status.id}`;
}

export async function status(ctx: CommandContext, opts: StatusOptions): Promise<void> {
  const manifest = await loadManifest(ctx.root, (m) => {
    ctx.log.warn(m);
  });
  const [local, remoteScan] = await Promise.all([
    scanLocal(ctx.scriptRoot),
    scanRemote(ctx.objects),
  ]);
  const statuses = computeStatus({ manifest, remote: remoteScan.info, local }).filter((s) =>
    matches(s, opts.pattern),
  );

  const groups = new Map<SyncState, SyncStatus[]>();
  for (const state of GROUP_ORDER) groups.set(state, []);
  for (const s of statuses) {
    groups.get(s.state)?.push(s);
  }

  if (statuses.length === 0) {
    ctx.log.info('No scripts found (matching filter).');
    return;
  }

  // Every script, including in-sync ones that the human view collapses to a count:
  // a consumer filters for itself and should not have to re-run with --verbose.
  for (const s of statuses) {
    ctx.log.data({ type: 'status', id: s.id, path: s.path, state: s.state });
  }

  for (const state of GROUP_ORDER) {
    const entries = groups.get(state) ?? [];
    if (entries.length === 0) continue;

    if (state === 'in-sync' && !opts.verbose) {
      ctx.log.result(`${GROUP_LABELS[state]}: ${entries.length}`);
      continue;
    }

    ctx.log.result(`${GROUP_LABELS[state]} (${entries.length})`);
    for (const entry of entries) {
      ctx.log.result(formatEntry(entry));
    }
  }

  const total = statuses.length;
  ctx.log.info(`Total: ${total} script(s).`);
}
