/**
 * `iob-sync pull` — writes remote script content to local files.
 *
 * Anti-data-loss property: pull never overwrites a local edit and never deletes a
 * local file. `conflict` and `local-modified` are skipped unless `--force`;
 * `remote-missing` is only ever reported, never acted on.
 */

import { CommandContext, Manifest, ScriptObject, SyncStatus } from '../types';
import { loadManifest, saveManifest, upsertEntry } from '../sync/manifest';
import { computeStatus } from '../sync/compare';
import { scanLocal, scanRemote, matchesPattern } from '../sync/scan';
import { hashSource, isEditableEngineType, normalizeSource } from '../sync/mapping';
import { safeWriteFile } from '../sync/safe-path';

export interface PullOptions {
  pattern?: string;
  force?: boolean;
}

function matches(status: SyncStatus, pattern?: string): boolean {
  return matchesPattern(status.path, pattern) || matchesPattern(status.id, pattern);
}

async function writeFromRemote(
  ctx: CommandContext,
  manifest: Manifest,
  status: SyncStatus,
  script: ScriptObject | undefined,
): Promise<boolean> {
  if (!script) {
    ctx.log.warn(`${status.path}: remote script disappeared mid-run, skipping.`);
    return false;
  }

  const engineType = script.common.engineType ?? status.engineType ?? '';
  if (!isEditableEngineType(engineType)) {
    ctx.log.warn(
      `${status.path}: ${engineType} content is generated (Blockly/Rules), not hand-editable source.`,
    );
  }

  const source = normalizeSource(script.common.source ?? '');

  if (ctx.dryRun) {
    ctx.log.result(`pull  ${status.path} (dry-run)`);
    ctx.log.data({ type: 'pull', id: status.id, path: status.path, dryRun: true });
    return true;
  }

  // safeWriteFile enforces that the path stays inside the script root and refuses
  // to follow a symlink out of it — the script id driving this path comes from the server.
  await safeWriteFile(ctx.scriptRoot, status.path, source);

  upsertEntry(manifest, {
    id: status.id,
    path: status.path,
    engineType,
    engine: script.common.engine,
    enabled: script.common.enabled,
    baseHash: hashSource(source),
    lastSync: new Date().toISOString(),
  });

  ctx.log.result(`pull  ${status.path}`);
  ctx.log.data({ type: 'pull', id: status.id, path: status.path, dryRun: false });
  return true;
}

export async function pull(ctx: CommandContext, opts: PullOptions): Promise<void> {
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

  let changed = false;
  let pulled = 0;
  let skipped = 0;

  for (const status of statuses) {
    try {
      const result = await pullOne(ctx, manifest, status, remoteScan, opts);
      pulled += result.pulled;
      skipped += result.skipped;
      if (result.pulled && !ctx.dryRun) changed = true;
    } catch (err) {
      // A single unwritable script — an id that escapes the script root, a path
      // blocked by a symlink, a permissions problem — must not abort the whole
      // pull and strand every other script. Report it and keep going.
      ctx.log.warn(`${status.path}: skipped (${err instanceof Error ? err.message : String(err)})`);
      skipped++;
    }
  }

  if (changed) {
    await saveManifest(ctx.root, manifest);
  }

  ctx.log.info(`Pull complete: ${pulled} pulled, ${skipped} skipped.`);
}

/** Handles one script. Throws only for genuinely exceptional write failures. */
async function pullOne(
  ctx: CommandContext,
  manifest: Manifest,
  status: SyncStatus,
  remoteScan: { scripts: Map<string, ScriptObject> },
  opts: PullOptions,
): Promise<{ pulled: number; skipped: number }> {
  switch (status.state) {
    case 'remote-only':
    case 'remote-modified': {
      const ok = await writeFromRemote(ctx, manifest, status, remoteScan.scripts.get(status.id));
      return ok ? { pulled: 1, skipped: 0 } : { pulled: 0, skipped: 0 };
    }

    case 'conflict':
    case 'local-modified': {
      if (opts.force) {
        const ok = await writeFromRemote(ctx, manifest, status, remoteScan.scripts.get(status.id));
        return ok ? { pulled: 1, skipped: 0 } : { pulled: 0, skipped: 0 };
      }
      ctx.log.warn(
        `${status.path}: skipped (${status.state}); local changes would be lost. Use --force to overwrite, or push first.`,
      );
      return { pulled: 0, skipped: 1 };
    }

    case 'remote-missing': {
      ctx.log.warn(
        `${status.path}: no longer exists on the server (tracked locally); leaving local file untouched.`,
      );
      return { pulled: 0, skipped: 0 };
    }

    case 'local-only':
    case 'in-sync':
    default:
      return { pulled: 0, skipped: 0 };
  }
}
