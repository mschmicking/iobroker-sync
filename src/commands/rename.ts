import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CommandContext, UserError, ScriptObject } from '../types';
import { idToRelPath, normalizeSource } from '../sync/mapping';
import { loadManifest, saveManifest, removeEntry, upsertEntry } from '../sync/manifest';
import { backupObject } from './remove';

/**
 * Sanitizes a single id segment: space, any remaining `.`, and the characters
 * `* , ; ' " \ & # < > ?` are replaced with `_`.
 */
export function sanitizeSegment(segment: string): string {
  return segment.replace(/[ .*,;'"\\&#<>?]/g, '_');
}

/**
 * Copies a script to a new id, proving the copy is byte-identical before the
 * original is backed up and deleted.
 *
 * ioBroker has no native rename or move, so both operations are copy-then-delete.
 * The verification below is the only thing preventing a partial copy from turning
 * into lost work, so it compares the actual source rather than merely asserting
 * that *something* now exists at the target id.
 */
export async function copyVerifyAndDelete(
  ctx: CommandContext,
  original: ScriptObject,
  newId: string,
): Promise<void> {
  const copy: ScriptObject = {
    ...original,
    _id: newId,
    common: {
      ...original.common,
      name: newId.slice(newId.lastIndexOf('.') + 1),
    },
  };

  await ctx.objects.createScript(copy);

  const written = await ctx.objects.getScript(newId);
  if (!written) {
    throw new UserError(
      `Copy to "${newId}" could not be read back — the original "${original._id}" was left untouched.`,
    );
  }

  const expected = normalizeSource(original.common.source ?? '');
  const actual = normalizeSource(written.common.source ?? '');
  if (expected !== actual) {
    throw new UserError(
      `Copy to "${newId}" does not match the original source ` +
        `(${expected.length} chars expected, ${actual.length} written). ` +
        `The original "${original._id}" was left untouched.`,
      'Delete the incomplete copy manually once you have checked it, then retry.',
    );
  }

  // Only now is it safe to destroy the original.
  const backupPath = await backupObject(ctx, original);
  ctx.log.info(`backup   ${backupPath}`);
  await ctx.objects.deleteObject(original._id);
}

export async function rename(
  ctx: CommandContext,
  id: string,
  newName: string,
  opts: { yes?: boolean },
): Promise<void> {
  const original = await ctx.objects.getScript(id);
  if (!original) {
    throw new UserError(
      `Script "${id}" was not found.`,
      'Run `iob-sync list` to see available ids.',
    );
  }

  const sanitized = sanitizeSegment(newName);
  if (!sanitized) {
    throw new UserError(`"${newName}" is not a usable script name.`);
  }
  const newId = id.split('.').slice(0, -1).concat(sanitized).join('.');

  if (newId === id) {
    ctx.log.info(`"${id}" already has that name — nothing to do.`);
    return;
  }

  if (await ctx.objects.getScript(newId)) {
    throw new UserError(`Script "${newId}" already exists.`, 'Pick a different name.');
  }

  if (!opts.yes) {
    ctx.log.info(`Would copy   ${id}`);
    ctx.log.info(`         to  ${newId}`);
    ctx.log.info(`Would then delete the original (a backup is written first).`);
    ctx.log.info('Nothing has been changed. Re-run with --yes to confirm.');
    return;
  }

  if (ctx.dryRun) {
    ctx.log.result(`[dry-run] rename ${id} -> ${newId}`);
    return;
  }

  await copyVerifyAndDelete(ctx, original, newId);
  ctx.log.result(`rename   ${id} -> ${newId}`);

  const manifest = await loadManifest(ctx.root, (m) => {
    ctx.log.warn(m);
  });
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
