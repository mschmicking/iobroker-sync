/**
 * Shared scan helpers: build the local (`Map<relPath, LocalFileInfo>`) and remote
 * (`Map<id, RemoteScriptInfo>`) sides that `computeStatus` consumes.
 *
 * Local filesystem walk + remote listing only: no manifest/compare logic here.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ObjectsApi, ScriptObject } from '../types';
import { extensionToEngineType, hashSource } from './mapping';
import { LocalFileInfo, RemoteScriptInfo } from './compare';

const SKIP_DIR_NAMES = new Set(['node_modules', '.iobroker-sync', '.iobroker']);

function isDotEntry(name: string): boolean {
  return name.startsWith('.');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(
  dir: string,
  scriptRoot: string,
  out: Map<string, LocalFileInfo>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (isDotEntry(entry.name)) continue;

    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walk(abs, scriptRoot, out);
      continue;
    }

    if (!entry.isFile()) continue;

    const engineType = extensionToEngineType(entry.name);
    if (!engineType) continue;

    const relPath = path.relative(scriptRoot, abs).split(path.sep).join('/');

    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }

    out.set(relPath, { relPath, hash: hashSource(content) });
  }
}

/**
 * Recursively walks `scriptRoot`, returning every file whose extension maps to a
 * known engine type, keyed by POSIX-style relative path. Skips dotfiles/dirs,
 * `node_modules`, `.iobroker-sync`, `.iobroker`.
 */
export async function scanLocal(scriptRoot: string): Promise<Map<string, LocalFileInfo>> {
  const out = new Map<string, LocalFileInfo>();
  if (!(await pathExists(scriptRoot))) {
    return out;
  }
  await walk(scriptRoot, scriptRoot, out);
  return out;
}

/**
 * Lists remote scripts and returns both the lightweight comparison info
 * (keyed by id) and the raw script objects (also keyed by id) for callers that
 * need more than the hash, e.g. `pull` writing file contents.
 */
export async function scanRemote(
  objects: ObjectsApi,
): Promise<{ info: Map<string, RemoteScriptInfo>; scripts: Map<string, ScriptObject> }> {
  const list = await objects.listScripts();
  const info = new Map<string, RemoteScriptInfo>();
  const scripts = new Map<string, ScriptObject>();

  for (const script of list) {
    const source = script.common?.source ?? '';
    info.set(script._id, {
      id: script._id,
      engineType: script.common?.engineType ?? '',
      engine: script.common?.engine,
      enabled: script.common?.enabled,
      sourceHash: hashSource(source),
    });
    scripts.set(script._id, script);
  }

  return { info, scripts };
}

/**
 * Case-insensitive pattern match against a single candidate string (callers match
 * both the relPath and the id by calling this twice). Empty pattern matches everything.
 *
 * A pattern containing `*` is treated as an anchored glob (`common/*.ts`).
 * A pattern without `*` is treated as a substring match, so `iob-sync diff garage`
 * does what you would expect rather than silently matching nothing — an exact-match-only
 * rule makes the common case look like "no differences", which is actively misleading.
 */
export function matchesPattern(value: string, pattern?: string): boolean {
  if (!pattern) return true;

  if (!pattern.includes('*')) {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }

  // Collapse runs of `*` first. Without this, a pattern like `***…*x` compiles to
  // `.*.*.*…x`, whose overlapping quantifiers backtrack catastrophically — 30 stars
  // against a 60-character id does not terminate in any practical time. Collapsing
  // makes the compiled regex linear, and costs nothing since `**` means `*` anyway.
  const collapsed = pattern.replace(/\*{2,}/g, '*');
  const escaped = collapsed.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}
