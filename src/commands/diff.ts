/**
 * `iob-sync diff` — unified diff of local vs remote content per script.
 *
 * With `--against <snapshot>` it diffs the working tree against a `backup` snapshot
 * instead of the server. That is deliberately the whole recovery story: there is no
 * `restore` command, because `cp` + `push` already restores source and a bulk restore
 * is a destructive operation nobody actually wants. What was missing was the ability
 * to *see* what changed since a known-good point — which is this.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { CommandContext, STATE_DIR, SyncStatus, UserError } from '../types';
import { BACKUP_DIRNAME, BackupManifest } from './backup';
import { loadManifest } from '../sync/manifest';
import { computeStatus } from '../sync/compare';
import { scanLocal, scanRemote, matchesPattern } from '../sync/scan';
import { normalizeSource } from '../sync/mapping';

export interface DiffOptions {
  pattern?: string;
  /** A snapshot directory name under `.iobroker-sync/backup/`, or `latest`. */
  against?: string;
}

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_RESET = '\x1b[0m';

function matches(status: SyncStatus, pattern?: string): boolean {
  return matchesPattern(status.path, pattern) || matchesPattern(status.id, pattern);
}

function colorize(patch: string): string {
  if (!process.stdout.isTTY) return patch;
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return `${ANSI_CYAN}${line}${ANSI_RESET}`;
      }
      if (line.startsWith('+')) {
        return `${ANSI_GREEN}${line}${ANSI_RESET}`;
      }
      if (line.startsWith('-')) {
        return `${ANSI_RED}${line}${ANSI_RESET}`;
      }
      return line;
    })
    .join('\n');
}

async function readLocal(scriptRoot: string, relPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(scriptRoot, relPath), 'utf8');
    return normalizeSource(raw);
  } catch {
    return '';
  }
}

/**
 * Resolves `--against` to a snapshot directory.
 *
 * Snapshot names are ISO timestamps with the punctuation flattened, so they sort
 * lexically in chronological order and `latest` is simply the last one.
 */
async function resolveSnapshotDir(root: string, name: string): Promise<string> {
  const backupRoot = path.join(root, STATE_DIR, BACKUP_DIRNAME);

  let available: string[];
  try {
    available = (await fs.readdir(backupRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    throw new UserError(`No snapshots found in ${backupRoot}.`, 'Run `iob-sync backup` first.');
  }

  if (available.length === 0) {
    throw new UserError(`No snapshots found in ${backupRoot}.`, 'Run `iob-sync backup` first.');
  }

  if (name === 'latest') {
    return path.join(backupRoot, available[available.length - 1]);
  }

  if (!available.includes(name)) {
    throw new UserError(`No snapshot named "${name}".`, `Available: ${available.join(', ')}`);
  }
  return path.join(backupRoot, name);
}

/** Diffs the working tree against a snapshot. Never touches the server. */
async function diffAgainstSnapshot(
  ctx: CommandContext,
  opts: DiffOptions & { against: string },
): Promise<void> {
  const snapshotDir = await resolveSnapshotDir(ctx.root, opts.against);

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(snapshotDir, 'manifest.json'), 'utf8'),
    ) as BackupManifest;
  } catch (err) {
    throw new UserError(
      `Could not read the snapshot manifest in ${snapshotDir}: ${(err as Error).message}`,
      'The snapshot may be incomplete; try another one.',
    );
  }

  const entries = manifest.entries.filter(
    (e) => matchesPattern(e.path, opts.pattern) || matchesPattern(e.id, opts.pattern),
  );

  ctx.log.info(`Comparing working tree against ${path.relative(ctx.root, snapshotDir)}`);

  let changed = 0;
  for (const entry of entries) {
    const snapshotSource = normalizeSource(
      await fs.readFile(path.join(snapshotDir, 'sources', entry.path), 'utf8').catch(() => ''),
    );
    const localSource = await readLocal(ctx.scriptRoot, entry.path);

    if (snapshotSource === localSource) continue;
    changed += 1;

    const state = localSource === '' ? 'missing-locally' : 'modified';
    const patch = createTwoFilesPatch(
      `snapshot:${entry.path}`,
      `local:${entry.path}`,
      snapshotSource,
      localSource,
    );
    ctx.log.info(`--- ${state}: ${entry.path} ---`);
    ctx.log.result(colorize(patch));
    ctx.log.data({
      type: 'diff',
      against: snapshotDir,
      id: entry.id,
      path: entry.path,
      state,
    });
  }

  // A snapshot records `enabled` and `engine`, which `push` structurally cannot
  // restore — so they are worth surfacing even though no source changed.
  for (const entry of entries) {
    if (!entry.enabled) {
      ctx.log.info(`note: ${entry.path} was disabled when this snapshot was taken.`);
    }
  }

  if (changed === 0) {
    ctx.log.info('No differences against this snapshot (matching filter).');
  }
}

export async function diff(ctx: CommandContext, opts: DiffOptions): Promise<void> {
  if (opts.against) {
    return diffAgainstSnapshot(ctx, { ...opts, against: opts.against });
  }

  const manifest = await loadManifest(ctx.root, (m) => {
    ctx.log.warn(m);
  });
  const [local, remoteScan] = await Promise.all([
    scanLocal(ctx.scriptRoot),
    scanRemote(ctx.objects),
  ]);
  const statuses = computeStatus({ manifest, remote: remoteScan.info, local })
    .filter((s) => matches(s, opts.pattern))
    .filter((s) => s.state !== 'in-sync');

  if (statuses.length === 0) {
    ctx.log.info('No differences (matching filter).');
    return;
  }

  for (const status of statuses) {
    const remoteScript = remoteScan.scripts.get(status.id);
    const remoteSource = remoteScript ? normalizeSource(remoteScript.common.source ?? '') : '';
    const localSource = await readLocal(ctx.scriptRoot, status.path);

    if (remoteSource === localSource) {
      continue;
    }

    const patch = createTwoFilesPatch(
      `remote:${status.id}`,
      `local:${status.path}`,
      remoteSource,
      localSource,
    );
    ctx.log.info(`--- ${status.state}: ${status.path} ---`);
    ctx.log.result(colorize(patch));
    ctx.log.data({ type: 'diff', id: status.id, path: status.path, state: status.state });
  }
}
