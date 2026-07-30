/**
 * `iob-sync backup` — snapshots the live server state to a local directory.
 *
 * This is the "I am about to change scripts that run someone's house" safety net.
 * It is strictly read-only against ioBroker: it fetches objects and writes files,
 * and never mutates anything remote.
 *
 * Two copies are kept per script because they answer different questions:
 *
 *   sources/<rel-path>       the source text, ready to be copied back over a
 *                            working file and pushed
 *   objects/<id>.json        the *whole* object, including `common.enabled` and
 *                            `common.engine` — the fields `push` deliberately
 *                            never writes (see AGENTS.md invariant 2), so this is
 *                            the only record of which instance a script ran on and
 *                            whether it was enabled
 *
 * Snapshots land under `.iobroker-sync/`, which is gitignored — pristine copies
 * still contain whatever secrets the live scripts hold, and must not reach git.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandContext, STATE_DIR, ScriptObject, UserError } from '../types';
import { hashSource, idToRelPath, normalizeSource } from '../sync/mapping';
import { resolveTargets } from './list';

export const BACKUP_DIRNAME = 'backup';

/** One script's entry in a snapshot manifest. */
export interface BackupManifestEntry {
  id: string;
  path: string;
  engineType: string;
  /** Which javascript instance ran it — `push` cannot restore this, so record it. */
  engine: string;
  enabled: boolean;
  /** sha256 of the normalised source, so a restore can be verified. */
  sourceHash: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  url: string;
  entries: BackupManifestEntry[];
}

/** Filesystem-safe form of an ioBroker id. Ids contain dots, never slashes, but be strict. */
function sanitizeId(id: string): string {
  return id.replace(/[/\\:*?"<>|]/g, '_');
}

/** Directory name for a snapshot: an ISO timestamp with the colons/dots flattened. */
export function snapshotDirName(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Writes a full object to `objects/`. Kept separate from the source write so a
 * caller can tell which of the two failed.
 */
async function writeObject(objectsDir: string, obj: ScriptObject): Promise<void> {
  const target = path.join(objectsDir, `${sanitizeId(obj._id)}.json`);
  await fs.writeFile(target, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Snapshots every script (or those matching `pattern`) to
 * `.iobroker-sync/backup/<timestamp>/`.
 *
 * A partial snapshot is worse than none, because it looks like a safety net and
 * is not — so any failure aborts with the directory left in place for inspection.
 */
export async function backup(
  ctx: CommandContext,
  opts: { pattern?: string } = {},
): Promise<string> {
  const scripts = await resolveTargets(ctx, opts.pattern);

  if (scripts.length === 0) {
    throw new UserError(
      opts.pattern ? `No scripts matched "${opts.pattern}".` : 'No scripts found on the server.',
      'Run `iob-sync list` to see what is there.',
    );
  }

  const now = new Date();
  const snapshotDir = path.join(ctx.root, STATE_DIR, BACKUP_DIRNAME, snapshotDirName(now));

  if (ctx.dryRun) {
    ctx.log.result(`[dry-run] would back up ${scripts.length} script(s) to ${snapshotDir}`);
    return snapshotDir;
  }

  const objectsDir = path.join(snapshotDir, 'objects');
  const sourcesDir = path.join(snapshotDir, 'sources');
  await fs.mkdir(objectsDir, { recursive: true });
  await fs.mkdir(sourcesDir, { recursive: true });

  const entries: BackupManifestEntry[] = [];

  for (const script of scripts) {
    const engineType = script.common.engineType || '';
    const relPath = idToRelPath(script._id, engineType);
    const source = script.common.source ?? '';

    try {
      await writeObject(objectsDir, script);

      const target = path.join(sourcesDir, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source, 'utf8');
    } catch (err) {
      throw new UserError(
        `Backup failed while writing "${script._id}": ${err instanceof Error ? err.message : String(err)}`,
        `The partial snapshot is at ${snapshotDir}. Nothing on the server was touched.`,
      );
    }

    entries.push({
      id: script._id,
      path: relPath,
      engineType,
      engine: script.common.engine || '',
      enabled: Boolean(script.common.enabled),
      sourceHash: hashSource(normalizeSource(source)),
    });

    ctx.log.debug(`backed up ${script._id}`);
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: now.toISOString(),
    url: ctx.config.url,
    entries,
  };
  await fs.writeFile(
    path.join(snapshotDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  // The snapshot path is the one thing a caller needs afterwards, so it leads.
  ctx.log.data({
    type: 'backup',
    snapshot: snapshotDir,
    createdAt: manifest.createdAt,
    scripts: entries.length,
    entries,
  });

  const enabledCount = entries.filter((e) => e.enabled).length;
  ctx.log.info(`Snapshot: ${snapshotDir}`);
  ctx.log.result(
    `backed up ${entries.length} script(s), ${enabledCount} enabled, to ${path.relative(ctx.root, snapshotDir)}`,
  );

  return snapshotDir;
}
