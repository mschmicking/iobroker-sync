import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CommandContext, ScriptObject, STATE_DIR, TRASH_DIRNAME, UserError } from '../types';
import { loadManifest, saveManifest, removeEntry } from '../sync/manifest';

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
  const manifest = await loadManifest(ctx.root);
  const entry = manifest.entries[id];
  const localPath = entry ? path.join(ctx.scriptRoot, entry.path) : undefined;

  if (!opts.yes) {
    ctx.log.info(`Would delete from ioBroker:  ${id}`);
    if (!scriptObj) {
      ctx.log.info('  (not found on the server — nothing to delete there)');
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
    throw new UserError(
      `Script "${id}" was not found on the server.`,
      'Run `iob-sync list` to see the available script ids.',
    );
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
