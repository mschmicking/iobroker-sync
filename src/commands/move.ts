import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CommandContext, UserError } from '../types';
import { idToRelPath } from '../sync/mapping';
import { loadManifest, saveManifest, removeEntry, upsertEntry } from '../sync/manifest';
import { copyVerifyAndDelete, sanitizeSegment } from './rename';

/**
 * Converts a local folder path to an ioBroker id prefix.
 *   "common/sub" -> "script.js.common.sub"
 *   ""           -> "script.js"   (the script root)
 */
function folderPathToIdPrefix(folderPath: string): string {
  if (!folderPath) {
    return 'script.js';
  }
  const segments = folderPath
    .split(path.sep)
    .join('/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    .map(sanitizeSegment);

  return segments.length ? `script.js.${segments.join('.')}` : 'script.js';
}

/**
 * Moves a script to a different folder, keeping its name.
 *
 * Like `rename`, this is a copy-then-delete because ioBroker has no native move.
 * It shares `copyVerifyAndDelete`, which refuses to delete the original unless the
 * copy reads back with matching source.
 */
export async function move(
  ctx: CommandContext,
  id: string,
  targetFolder: string,
  opts: { yes?: boolean },
): Promise<void> {
  const original = await ctx.objects.getScript(id);
  if (!original) {
    throw new UserError(`Script "${id}" was not found.`, 'Run `iob-sync list` to see available ids.');
  }

  const scriptName = id.split('.').pop();
  if (!scriptName) {
    throw new UserError(`Could not determine the script name from id "${id}".`);
  }

  const prefix = folderPathToIdPrefix(targetFolder);
  const newId = `${prefix}.${scriptName}`;

  if (newId === id) {
    ctx.log.info(`"${id}" is already in that folder — nothing to do.`);
    return;
  }

  if (await ctx.objects.getScript(newId)) {
    throw new UserError(`Script "${newId}" already exists.`, 'Move it elsewhere or rename it first.');
  }

  if (!opts.yes) {
    ctx.log.info(`Would copy   ${id}`);
    ctx.log.info(`         to  ${newId}`);
    ctx.log.info('Would then delete the original (a backup is written first).');
    ctx.log.info('Nothing has been changed. Re-run with --yes to confirm.');
    return;
  }

  if (ctx.dryRun) {
    ctx.log.result(`[dry-run] move ${id} -> ${newId}`);
    return;
  }

  const createdFolders = await ctx.objects.ensureFolders(newId);
  for (const folder of createdFolders) {
    ctx.log.result(`folder   ${folder}`);
  }

  await copyVerifyAndDelete(ctx, original, newId);
  ctx.log.result(`move     ${id} -> ${newId}`);

  const manifest = await loadManifest(ctx.root);
  const entry = manifest.entries[id];
  if (entry) {
    const oldLocalPath = path.join(ctx.scriptRoot, entry.path);
    const newRelPath = idToRelPath(newId, entry.engineType);
    const newLocalPath = path.join(ctx.scriptRoot, newRelPath);

    try {
      await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
      await fs.rename(oldLocalPath, newLocalPath);
      ctx.log.result(`moved    ${entry.path} -> ${newRelPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        ctx.log.warn(`Could not move local file: ${(err as Error).message}`);
      }
    }

    removeEntry(manifest, id);
    upsertEntry(manifest, { ...entry, id: newId, path: newRelPath });
    await saveManifest(ctx.root, manifest);
  }
}
