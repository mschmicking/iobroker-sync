import * as path from 'node:path';
import { CommandContext, UserError, ManifestEntry, ENGINE_TYPES } from '../types';
import { relPathToId, extensionToEngineType, hashSource } from '../sync/mapping';
import { loadManifest, saveManifest, upsertEntry } from '../sync/manifest';
import { safeWriteFile } from '../sync/safe-path';

export async function createNew(
  ctx: CommandContext,
  relPath: string,
  opts: { instance?: string },
): Promise<void> {
  // Derive engineType from extension
  const engineType = extensionToEngineType(relPath);
  if (!engineType) {
    const validExts = Object.values(ENGINE_TYPES)
      .map((et) => {
        if (et === ENGINE_TYPES.javascript) return '.js';
        if (et === ENGINE_TYPES.typescript) return '.ts';
        if (et === ENGINE_TYPES.blockly) return '.block';
        if (et === ENGINE_TYPES.rules) return '.rules';
        return '';
      })
      .filter((e) => e.length > 0)
      .join(', ');
    throw new UserError(`Unknown file extension in "${relPath}". Expected one of: ${validExts}`);
  }

  // Derive ioBroker id from relPath
  const id = relPathToId(relPath);

  // Check if script already exists remotely
  const existingScript = await ctx.objects.getScript(id);
  if (existingScript) {
    throw new UserError(
      `Script "${id}" already exists on the remote server. Use "pull" to sync it locally.`,
    );
  }

  // Resolve instance parameter
  let instanceId = opts.instance;
  if (!instanceId) {
    instanceId = ctx.config.defaultInstance;
  } else if (/^\d+$/.test(instanceId)) {
    // Bare number like "2" -> expand to full instance id
    instanceId = `system.adapter.javascript.${instanceId}`;
  }

  // Create folders
  if (!ctx.dryRun) {
    await ctx.objects.ensureFolders(id);
  }

  // Create script object
  const scriptName = path.basename(relPath);
  // Remove extension from name if present
  const displayName = scriptName.includes('.')
    ? scriptName.substring(0, scriptName.lastIndexOf('.'))
    : scriptName;

  const scriptObj = {
    _id: id,
    type: 'script' as const,
    common: {
      name: displayName,
      source: '',
      engineType,
      engine: instanceId,
      enabled: false, // MUST be false
      debug: false,
      verbose: false,
      expert: true,
    },
    native: {},
  };

  if (!ctx.dryRun) {
    await ctx.objects.createScript(scriptObj);
  }

  // Create local file, refusing anything that escapes the script root or is a symlink.
  const localFilePath = path.join(ctx.scriptRoot, relPath);
  if (!ctx.dryRun) {
    await safeWriteFile(ctx.scriptRoot, relPath, '');
  }

  // Add manifest entry
  if (!ctx.dryRun) {
    const manifest = await loadManifest(ctx.root, (m) => {
      ctx.log.warn(m);
    });
    const entry: ManifestEntry = {
      id,
      path: relPath,
      engineType,
      engine: instanceId,
      enabled: false,
      baseHash: hashSource(''),
      lastSync: new Date().toISOString(),
    };
    upsertEntry(manifest, entry);
    await saveManifest(ctx.root, manifest);
  }

  ctx.log.result(`new    ${id}`);
  ctx.log.info(`Created script at ${localFilePath}`);
}
