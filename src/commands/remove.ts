import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  CommandContext,
  ScriptMarkerEntry,
  ScriptObject,
  STATE_DIR,
  TRASH_DIRNAME,
  UserError,
} from '../types';
import { loadManifest, saveManifest, removeEntry } from '../sync/manifest';

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Markers left behind for `scriptId`, or an empty list if they cannot be read.
 *
 * Never throws. Every caller is either previewing (where a failed lookup must not
 * turn into a failed command) or has already deleted the script (where it is far
 * too late for this to be the thing that fails).
 */
export async function findScriptMarkers(
  ctx: CommandContext,
  scriptId: string,
): Promise<ScriptMarkerEntry[]> {
  try {
    const all = await ctx.objects.listScriptMarkers();
    return all.filter((entry) => entry.scriptId === scriptId);
  } catch (err) {
    ctx.log.debug(`Could not read script markers: ${reason(err)}`);
    return [];
  }
}

/**
 * Removes the `javascript.<n>.scriptEnabled.<suffix>` and `.scriptProblem.<suffix>`
 * markers a deleted script leaves behind.
 *
 * Every javascript instance creates both markers for every non-global script, not just
 * the ones it runs: `load()` calls `createActiveObject`/`createProblemObject` before
 * `prepareScript` checks `common.engine`, and every instance runs `load()` for every
 * script at startup and again on every source change. Deletion, however, *is* gated on
 * the engine — so a delete cleans up one instance's pair and strands one pair on each of
 * the others. Nothing in ioBroker ever collects them, which is why we do it here.
 *
 * Both kinds or neither: a sweep that took only `scriptEnabled` would leave the
 * `scriptProblem` twin behind and report success, which is exactly the bug a live
 * instance caught after the first version of this function shipped.
 *
 * Best-effort on purpose. The script itself is already gone by the time this runs, so a
 * failure here is untidiness, not data loss, and reporting it as a failed delete would be
 * a lie. It warns and carries on.
 */
export async function cleanUpScriptMarkers(
  ctx: CommandContext,
  scriptId: string,
  entries?: ScriptMarkerEntry[],
): Promise<void> {
  const leftovers = entries ?? (await findScriptMarkers(ctx, scriptId));

  for (const entry of leftovers) {
    try {
      await ctx.objects.deleteScriptMarker(entry);
      ctx.log.result(`cleaned  ${entry.id}`);
    } catch (err) {
      ctx.log.warn(`Could not remove the leftover state ${entry.id}: ${reason(err)}`);
    }
  }
}

/**
 * Backs up a script object to the trash directory before it is destroyed.
 * Returns the path it was written to, and throws if the write fails — callers
 * must treat a failure here as fatal and abort rather than delete unbacked-up data.
 */
export async function backupObject(ctx: CommandContext, obj: ScriptObject): Promise<string> {
  const trashDir = path.join(ctx.root, STATE_DIR, TRASH_DIRNAME);
  await fs.mkdir(trashDir, { recursive: true });

  const sanitizedId = obj._id.replace(/[/\\:*?"<>|]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(trashDir, `${timestamp}-${sanitizedId}.json`);

  await fs.writeFile(backupPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return backupPath;
}

/**
 * Deletes a script object from ioBroker.
 *
 * The local file is KEPT by default: removing a script from the server is not a
 * reason to throw away the source. Pass `deleteLocal` to remove it as well.
 */
export async function remove(
  ctx: CommandContext,
  id: string,
  opts: { yes?: boolean; deleteLocal?: boolean },
): Promise<void> {
  const scriptObj = await ctx.objects.getScript(id);
  const leftovers = await findScriptMarkers(ctx, id);
  const manifest = await loadManifest(ctx.root, (m) => {
    ctx.log.warn(m);
  });
  const entry = manifest.entries[id];
  const localPath = entry ? path.join(ctx.scriptRoot, entry.path) : undefined;

  if (!opts.yes) {
    ctx.log.info(`Would delete from ioBroker:  ${id}`);
    if (!scriptObj) {
      ctx.log.info('  (not found on the server — nothing to delete there)');
    }
    for (const state of leftovers) {
      ctx.log.info(`Would clean up leftover:     ${state.id}`);
    }
    if (opts.deleteLocal && localPath) {
      ctx.log.info(`Would delete local file:     ${localPath}`);
    } else if (localPath) {
      ctx.log.info(`Local file kept:             ${localPath}`);
    }
    ctx.log.info('Nothing has been changed. Re-run with --yes to confirm.');
    return;
  }

  if (!scriptObj) {
    // Already gone from the server, but its markers are not: sweeping them is the
    // whole remaining job. Refusing here would leave the user with a warning they
    // have no way to clear — this is the only command that can.
    if (leftovers.length === 0) {
      throw new UserError(
        `Script "${id}" was not found on the server.`,
        'Run `iob-sync list` to see the available script ids.',
      );
    }

    if (ctx.dryRun) {
      ctx.log.result(`[dry-run] clean ${leftovers.length} leftover state(s) of ${id}`);
      return;
    }

    ctx.log.info(`"${id}" is already gone from the server — cleaning up what it left behind.`);
    await cleanUpScriptMarkers(ctx, id, leftovers);
    if (localPath) {
      // No object means no backup, and a delete without a backup is not something
      // this command does — invariant or not, the file is the last copy.
      ctx.log.info(`kept     ${localPath} (the server had nothing left to back up)`);
    }
    return;
  }

  if (ctx.dryRun) {
    ctx.log.result(`[dry-run] remove ${id}`);
    return;
  }

  // Back up first. A failed backup must abort the delete, never proceed past it.
  let backupPath: string;
  try {
    backupPath = await backupObject(ctx, scriptObj);
  } catch (err) {
    throw new UserError(
      `Could not write a backup for "${id}": ${err instanceof Error ? err.message : String(err)}`,
      'Nothing was deleted. Fix the backup location and try again.',
    );
  }
  ctx.log.info(`backup   ${backupPath}`);

  await ctx.objects.deleteObject(id);
  ctx.log.result(`remove   ${id}`);

  // Re-read rather than reusing the list from before the delete: the owning instance
  // reacts to the object disappearing by removing its own marker, and whichever of us
  // gets there first, what is left afterwards is exactly what nobody is coming back for.
  await cleanUpScriptMarkers(ctx, id);

  if (opts.deleteLocal && localPath) {
    try {
      await fs.unlink(localPath);
      ctx.log.result(`deleted  ${localPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        ctx.log.warn(`Could not delete local file ${localPath}: ${(err as Error).message}`);
      }
    }
  } else if (localPath) {
    ctx.log.info(`kept     ${localPath} (pass --delete-local to remove it too)`);
  }

  removeEntry(manifest, id);
  await saveManifest(ctx.root, manifest);
}
