/**
 * id <-> path and engineType <-> extension mapping.
 *
 * Pure logic only: no filesystem or network access here.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { ENGINE_TYPES, EngineType, MultilingualName } from '../types';

const ID_PREFIX = 'script.js.';

/** Canonical extension for each known engine type, keyed by lower-cased engine type. */
const ENGINE_TYPE_TO_EXTENSION: Record<string, string> = {
  [ENGINE_TYPES.javascript.toLowerCase()]: '.js',
  [ENGINE_TYPES.typescript.toLowerCase()]: '.ts',
  [ENGINE_TYPES.blockly.toLowerCase()]: '.block',
  [ENGINE_TYPES.rules.toLowerCase()]: '.rules',
};

/** Inverse of the above, keyed by lower-cased extension. */
const EXTENSION_TO_ENGINE_TYPE: Record<string, EngineType> = {
  '.js': ENGINE_TYPES.javascript,
  '.ts': ENGINE_TYPES.typescript,
  '.block': ENGINE_TYPES.blockly,
  '.rules': ENGINE_TYPES.rules,
};

/**
 * `common.engineType` -> file extension (including the leading dot).
 * Real data has inconsistent casing (e.g. "javascript/js"), so the comparison is
 * case-insensitive. Unknown engine types fall back to ".txt".
 */
export function engineTypeToExtension(engineType: string): string {
  return ENGINE_TYPE_TO_EXTENSION[engineType.toLowerCase()] ?? '.txt';
}

/**
 * File extension (taken from `path`) -> canonical `EngineType`.
 * Returns `undefined` for extensions that don't correspond to a known script engine
 * (e.g. ".txt", or a path with no extension at all).
 */
export function extensionToEngineType(filePath: string): EngineType | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_ENGINE_TYPE[ext];
}

/**
 * ioBroker script id -> relative path (POSIX separators), e.g.
 *   "script.js.common.garage" + "TypeScript/ts" -> "common/garage.ts"
 *   "script.js.Rollos.astroControl_sun_temp_tracker" + "TypeScript/ts"
 *     -> "Rollos/astroControl_sun_temp_tracker.ts"
 */
export function idToRelPath(id: string, engineType: string): string {
  const withoutPrefix = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
  const relNoExt = withoutPrefix.split('.').join('/');
  return relNoExt + engineTypeToExtension(engineType);
}

/**
 * Sanitises a single id segment: space, any remaining `.`, and the characters
 * `* , ; ' " \ & # < > ?` are replaced with `_` because they are not safe (or not
 * unambiguous) inside an ioBroker object id segment.
 */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[ .*,;'"\\&#<>?]/g, '_');
}

/**
 * relPath -> ioBroker id (inverse of idToRelPath).
 *
 * IMPORTANT: this derivation is lossy. Sanitising strips/replaces characters that are
 * valid in a filename but not in an id segment, so `relPathToId(idToRelPath(id, et))`
 * is not guaranteed to reproduce `id` for ids that already contain those characters.
 * It is therefore ONLY safe to use for brand-new local files that have no manifest
 * entry yet (i.e. `local-only` files in compare.ts). For anything that has already
 * been synced, the manifest entry's `id` field is authoritative and must be used
 * instead of re-deriving it from the path.
 */
export function relPathToId(relPath: string): string {
  const posixPath = relPath.split(path.sep).join('/');
  const ext = path.extname(posixPath);
  const withoutExt = ext ? posixPath.slice(0, -ext.length) : posixPath;
  const segments = withoutExt
    .split('/')
    .filter((s) => s.length > 0)
    .map(sanitizeSegment);
  return ID_PREFIX + segments.join('.');
}

/**
 * Folder/script names are sometimes a plain string and sometimes a translation map
 * (`{en, de, ru, ...}`). Prefer `en`, fall back to the first defined value, else `''`.
 */
export function resolveName(name: MultilingualName | undefined): string {
  if (name === undefined || name === null) return '';
  if (typeof name === 'string') return name;
  if (typeof name.en === 'string') return name.en;
  for (const key of Object.keys(name)) {
    const value = name[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** CRLF -> LF. Must be applied before hashing and before uploading source. */
export function normalizeSource(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** sha256 hex digest of the normalised source. */
export function hashSource(text: string): string {
  return crypto.createHash('sha256').update(normalizeSource(text), 'utf8').digest('hex');
}

/** Blockly and Rules scripts are generated XML/JSON, not hand-edited source. */
export function isEditableEngineType(engineType: string): boolean {
  const lower = engineType.toLowerCase();
  return lower !== ENGINE_TYPES.blockly.toLowerCase() && lower !== ENGINE_TYPES.rules.toLowerCase();
}
