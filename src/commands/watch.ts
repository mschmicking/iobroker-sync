/**
 * `iob-sync watch` — pushes local edits to the server as they happen, and
 * (with `--pull`) writes remote edits back to disk as they happen.
 *
 * Echo suppression is the crux of this file: pushing a script causes the
 * javascript adapter to write `compiled`/`sourceHash` back onto the same object,
 * which produces a second `objectChange` carrying source we already have. We
 * track the hash of what we last pushed per id (and what we last wrote to disk
 * per path) and ignore any event that merely reflects our own last write —
 * otherwise push and pull echo each other forever.
 */

import chokidar from 'chokidar';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CommandContext, IoBrokerObject, ScriptObject } from '../types';
import { findByPath, loadManifest, saveManifest, upsertEntry } from '../sync/manifest';
import {
  extensionToEngineType,
  hashSource,
  idToRelPath,
  isEditableEngineType,
  normalizeSource,
  relPathToId,
} from '../sync/mapping';
import { matchesPattern } from '../sync/scan';

export interface WatchOptions {
  pattern?: string;
  pull?: boolean;
}

const DEBOUNCE_MS = 300;
const SCRIPT_PATTERN = 'script.js.*';
const SKIP_DIR_NAMES = new Set(['node_modules', '.iobroker-sync', '.iobroker']);

function isIgnoredPath(relPath: string): boolean {
  const segments = relPath.split(path.sep);
  return segments.some((seg) => seg.startsWith('.') || SKIP_DIR_NAMES.has(seg));
}

function matches(value: string, id: string, pattern?: string): boolean {
  return matchesPattern(value, pattern) || matchesPattern(id, pattern);
}

export async function watch(ctx: CommandContext, opts: WatchOptions): Promise<void> {
  const manifest = await loadManifest(ctx.root);

  /** Hash of the source we last successfully pushed for a given id (echo suppression). */
  const lastPushedHash = new Map<string, string>();
  /** Hash of the source we last wrote to disk for a given relPath (echo suppression). */
  const lastWrittenHash = new Map<string, string>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function pushFile(relPath: string): Promise<void> {
    const abs = path.join(ctx.scriptRoot, relPath);
    let raw: string;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch {
      // File was removed or is unreadable; watch never deletes remote scripts.
      return;
    }

    const localSource = normalizeSource(raw);
    const localHash = hashSource(localSource);

    if (lastWrittenHash.get(relPath) === localHash) {
      // This is our own write from applying a remote change; not a real edit.
      return;
    }

    const engineType = extensionToEngineType(relPath);
    if (!engineType) return;
    if (!matches(relPath, relPathToId(relPath), opts.pattern)) return;

    if (!isEditableEngineType(engineType)) {
      ctx.log.warn(`${relPath}: Blockly/Rules content is generated; skipping watch-push.`);
      return;
    }

    const entry = findByPath(manifest, relPath);
    const id = entry ? entry.id : relPathToId(relPath);

    const remoteScript = await ctx.objects.getScript(id);
    const remoteHash = remoteScript ? hashSource(remoteScript.common.source ?? '') : undefined;

    if (entry && remoteScript && remoteHash !== undefined) {
      const baseHash = entry.baseHash;
      const localChanged = localHash !== baseHash;
      const remoteChanged = remoteHash !== baseHash;
      if (localChanged && remoteChanged && localHash !== remoteHash) {
        ctx.log.warn(`${relPath}: conflict with remote changes; not pushing. Resolve with diff/pull --force.`);
        return;
      }
    }

    if (ctx.dryRun) {
      ctx.log.result(`push  ${relPath} (dry-run)`);
      return;
    }

    try {
      if (remoteScript) {
        await ctx.objects.extendScript(id, { source: localSource, engineType });
      } else {
        await ctx.objects.ensureFolders(id);
        const name = path.basename(relPath, path.extname(relPath));
        const obj: ScriptObject = {
          _id: id,
          type: 'script',
          common: {
            name,
            source: localSource,
            engineType,
            engine: ctx.config.defaultInstance,
            enabled: false,
            expert: true,
          },
          native: {},
        };
        await ctx.objects.createScript(obj);
      }
    } catch (err) {
      ctx.log.error(`${relPath}: push failed: ${(err as Error).message}`);
      return;
    }

    lastPushedHash.set(id, localHash);

    upsertEntry(manifest, {
      id,
      path: relPath,
      engineType,
      engine: entry?.engine ?? (remoteScript ? remoteScript.common.engine : ctx.config.defaultInstance),
      enabled: entry?.enabled ?? (remoteScript ? remoteScript.common.enabled : false),
      baseHash: localHash,
      lastSync: new Date().toISOString(),
    });
    await saveManifest(ctx.root, manifest);

    ctx.log.result(`push  ${relPath}`);
  }

  function scheduleFile(absPath: string): void {
    const relPath = path.relative(ctx.scriptRoot, absPath).split(path.sep).join('/');
    if (isIgnoredPath(relPath)) return;
    if (!extensionToEngineType(relPath)) return;

    const existing = debounceTimers.get(relPath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      relPath,
      setTimeout(() => {
        debounceTimers.delete(relPath);
        pushFile(relPath).catch((err) => ctx.log.error(`${relPath}: ${(err as Error).message}`));
      }, DEBOUNCE_MS),
    );
  }

  async function applyRemoteChange(id: string, obj: IoBrokerObject | null): Promise<void> {
    if (!obj || obj.type !== 'script') return;

    const engineType = obj.common.engineType ?? '';
    const source = normalizeSource(obj.common.source ?? '');
    const remoteHash = hashSource(source);

    if (lastPushedHash.get(id) === remoteHash) {
      // Echo of our own push (either the immediate write or the adapter's
      // subsequent compiled/sourceHash update, both carrying the same source).
      return;
    }

    const entry = manifest.entries[id];
    const relPath = entry ? entry.path : idToRelPath(id, engineType);
    if (!matches(relPath, id, opts.pattern)) return;

    if (!isEditableEngineType(engineType)) {
      ctx.log.warn(`${relPath}: Blockly/Rules content changed remotely; skipping auto-pull (generated content).`);
      return;
    }

    const abs = path.join(ctx.scriptRoot, relPath);
    let localHash: string | undefined;
    try {
      const localRaw = await fs.readFile(abs, 'utf8');
      localHash = hashSource(normalizeSource(localRaw));
    } catch {
      localHash = undefined;
    }

    const baseHash = entry?.baseHash;
    if (localHash !== undefined && baseHash !== undefined && localHash !== baseHash && localHash !== remoteHash) {
      ctx.log.warn(`${relPath}: remote changed but local also has unsaved changes; not overwriting (conflict).`);
      return;
    }

    if (ctx.dryRun) {
      ctx.log.result(`pull  ${relPath} (dry-run)`);
      return;
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, source, 'utf8');
    lastWrittenHash.set(relPath, remoteHash);

    upsertEntry(manifest, {
      id,
      path: relPath,
      engineType,
      engine: obj.common.engine,
      enabled: obj.common.enabled,
      baseHash: remoteHash,
      lastSync: new Date().toISOString(),
    });
    await saveManifest(ctx.root, manifest);

    ctx.log.result(`pull  ${relPath}`);
  }

  const watcher = chokidar.watch(ctx.scriptRoot, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const relPath = path.relative(ctx.scriptRoot, p);
      return relPath !== '' && isIgnoredPath(relPath);
    },
  });

  watcher.on('add', scheduleFile);
  watcher.on('change', scheduleFile);
  watcher.on('error', (err) => ctx.log.error(`watcher error: ${(err as Error).message}`));

  let subscribed = false;
  if (opts.pull) {
    await ctx.socket.subscribeObjects(SCRIPT_PATTERN, (id, obj) => {
      applyRemoteChange(id, obj).catch((err) => ctx.log.error(`${id}: ${(err as Error).message}`));
    });
    subscribed = true;
  }

  ctx.log.info(`Watching "${ctx.scriptRoot}" for changes${opts.pull ? ' (pulling remote changes too)' : ''}.`);
  ctx.log.info('Press Ctrl+C to stop.');

  await new Promise<void>((resolve) => {
    const onSigint = (): void => {
      process.off('SIGINT', onSigint);
      ctx.log.info('Stopping watch...');

      void (async () => {
        for (const timer of debounceTimers.values()) clearTimeout(timer);
        debounceTimers.clear();

        try {
          await watcher.close();
        } catch {
          // ignore
        }

        if (subscribed) {
          try {
            await ctx.socket.unsubscribeObjects(SCRIPT_PATTERN);
          } catch {
            // ignore
          }
        }

        try {
          await ctx.socket.close();
        } catch {
          // ignore
        }

        resolve();
        process.exit(0);
      })();
    };

    process.on('SIGINT', onSigint);
  });
}
