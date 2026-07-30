/**
 * `iob-sync push` — uploads local edits and brand-new local scripts to the server.
 *
 * `conflict` is refused unless `--force`: refusing means reporting it and not
 * uploading it, and the command ends by throwing a `UserError` if anything was
 * refused so the CLI's exit code reflects that something needs attention.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CommandContext, Manifest, ScriptObject, SyncStatus, UserError } from '../types';
import { findByPath, loadManifest, saveManifest, upsertEntry } from '../sync/manifest';
import { computeStatus } from '../sync/compare';
import { scanLocal, scanRemote, matchesPattern } from '../sync/scan';
import {
  extensionToEngineType,
  hashSource,
  isEditableEngineType,
  normalizeSource,
} from '../sync/mapping';

export interface PushOptions {
  pattern?: string;
  force?: boolean;
}

function matches(status: SyncStatus, pattern?: string): boolean {
  return matchesPattern(status.path, pattern) || matchesPattern(status.id, pattern);
}

async function readLocalSource(scriptRoot: string, relPath: string): Promise<string> {
  const abs = path.join(scriptRoot, relPath);
  const raw = await fs.readFile(abs, 'utf8');
  return normalizeSource(raw);
}

/** Pushes an existing (already-synced) script. Uses the manifest's exact id. */
async function pushExisting(
  ctx: CommandContext,
  manifest: Manifest,
  status: SyncStatus,
): Promise<void> {
  const source = await readLocalSource(ctx.scriptRoot, status.path);
  const engineType = extensionToEngineType(status.path) ?? status.engineType ?? '';

  if (!isEditableEngineType(engineType)) {
    ctx.log.warn(
      `${status.path}: ${engineType} content is generated (Blockly/Rules); pushing raw content anyway.`,
    );
  }

  if (ctx.dryRun) {
    ctx.log.result(`push  ${status.path} (dry-run)`);
    ctx.log.data({ type: 'push', id: status.id, path: status.path, created: false, dryRun: true });
    return;
  }

  await ctx.objects.extendScript(status.id, { source, engineType });

  const existing = manifest.entries[status.id];
  upsertEntry(manifest, {
    id: status.id,
    path: status.path,
    engineType,
    engine: existing?.engine ?? status.engine,
    enabled: existing?.enabled ?? status.enabled,
    baseHash: hashSource(source),
    lastSync: new Date().toISOString(),
  });

  ctx.log.result(`push  ${status.path}`);
  ctx.log.data({ type: 'push', id: status.id, path: status.path, created: false, dryRun: false });
}

/** Creates a brand-new script on the server for a `local-only` file. */
async function pushNew(ctx: CommandContext, manifest: Manifest, status: SyncStatus): Promise<void> {
  const source = await readLocalSource(ctx.scriptRoot, status.path);
  const engineType = extensionToEngineType(status.path);
  if (!engineType) {
    ctx.log.warn(`${status.path}: unrecognised extension, skipping.`);
    return;
  }

  if (!isEditableEngineType(engineType)) {
    ctx.log.warn(
      `${status.path}: ${engineType} content is generated (Blockly/Rules); pushing raw content anyway.`,
    );
  }

  if (ctx.dryRun) {
    ctx.log.result(`push  ${status.path} (dry-run, new script)`);
    ctx.log.data({ type: 'push', id: status.id, path: status.path, created: true, dryRun: true });
    return;
  }

  await ctx.objects.ensureFolders(status.id);

  const name = path.basename(status.path, path.extname(status.path));
  const obj: ScriptObject = {
    _id: status.id,
    type: 'script',
    common: {
      name,
      source,
      engineType,
      engine: ctx.config.defaultInstance,
      enabled: false,
      expert: true,
    },
    native: {},
  };
  await ctx.objects.createScript(obj);

  upsertEntry(manifest, {
    id: status.id,
    path: status.path,
    engineType,
    engine: ctx.config.defaultInstance,
    enabled: false,
    baseHash: hashSource(source),
    lastSync: new Date().toISOString(),
  });

  ctx.log.result(`push  ${status.path} (new)`);
  ctx.log.data({ type: 'push', id: status.id, path: status.path, created: true, dryRun: false });
}

export async function push(ctx: CommandContext, opts: PushOptions): Promise<void> {
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
  let pushed = 0;
  const refused: SyncStatus[] = [];

  for (const status of statuses) {
    switch (status.state) {
      case 'local-modified': {
        await pushExisting(ctx, manifest, status);
        pushed++;
        if (!ctx.dryRun) changed = true;
        break;
      }

      case 'local-only': {
        // Known-id lookup by path just in case the manifest already has this path
        // under a different id (shouldn't normally happen, but path is authoritative
        // for "is this really new").
        const existingEntry = findByPath(manifest, status.path);
        if (existingEntry) {
          await pushExisting(ctx, manifest, { ...status, id: existingEntry.id });
        } else {
          await pushNew(ctx, manifest, status);
        }
        pushed++;
        if (!ctx.dryRun) changed = true;
        break;
      }

      case 'conflict': {
        if (opts.force) {
          await pushExisting(ctx, manifest, status);
          pushed++;
          if (!ctx.dryRun) changed = true;
        } else {
          ctx.log.warn(
            `${status.path}: refused (conflict with remote changes). Use --force to overwrite, or pull first.`,
          );
          refused.push(status);
        }
        break;
      }

      case 'remote-only':
      case 'remote-modified':
      case 'remote-missing':
      case 'in-sync':
      default:
        break;
    }
  }

  if (changed) {
    await saveManifest(ctx.root, manifest);
  }

  ctx.log.info(`Push complete: ${pushed} pushed, ${refused.length} refused.`);

  if (refused.length > 0) {
    throw new UserError(
      `push: ${refused.length} script(s) refused due to unresolved conflicts.`,
      'Use --force to overwrite the remote version, or pull first to resolve manually.',
    );
  }
}
