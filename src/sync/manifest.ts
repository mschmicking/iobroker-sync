/**
 * Read/write the sync manifest at `<root>/.iobroker-sync/state.json`.
 *
 * Pure logic + filesystem access only: no network calls here.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Manifest, ManifestEntry, MANIFEST_FILENAME, STATE_DIR } from '../types';

function emptyManifest(): Manifest {
  return { version: 1, entries: {} };
}

function isValidManifestShape(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.entries === 'object' &&
    v.entries !== null &&
    !Array.isArray(v.entries)
  );
}

/**
 * Loads the manifest. A missing file is the normal first-run state and is returned
 * silently as empty. A present-but-corrupt file also degrades to empty (with a
 * warning) rather than throwing — a broken manifest must never block the user; the
 * worst case is that everything looks "new" again.
 */
/**
 * Loads the sync manifest, falling back to an empty one when it is missing,
 * unreadable or malformed.
 *
 * `warn` is threaded in rather than writing to the console directly: only cli.ts
 * owns stdout/stderr, and a warning that bypasses the logger cannot
 * be captured by tests or suppressed under --json.
 */
export async function loadManifest(root: string, warn?: (msg: string) => void): Promise<Manifest> {
  const target = path.join(root, STATE_DIR, MANIFEST_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyManifest();
    }
    warn?.(
      `iob-sync: could not read manifest at "${target}" (${(err as Error).message}); starting fresh.`,
    );
    return emptyManifest();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn?.(
      `iob-sync: manifest at "${target}" is not valid JSON (${(err as Error).message}); starting fresh.`,
    );
    return emptyManifest();
  }

  if (!isValidManifestShape(parsed)) {
    warn?.(`iob-sync: manifest at "${target}" has an unexpected shape; starting fresh.`);
    return emptyManifest();
  }

  return parsed;
}

/**
 * Writes the manifest atomically: write to a temp file in the same directory, then
 * rename over the target, so an interrupted write can never leave a corrupt file.
 */
export async function saveManifest(root: string, m: Manifest): Promise<void> {
  const dir = path.join(root, STATE_DIR);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, MANIFEST_FILENAME);
  const tmp = path.join(dir, `.${MANIFEST_FILENAME}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, target);
}

/** Insert or replace an entry, keyed by ioBroker id. */
export function upsertEntry(m: Manifest, e: ManifestEntry): void {
  m.entries[e.id] = e;
}

/** Remove an entry by ioBroker id. No-op if it doesn't exist. */
export function removeEntry(m: Manifest, id: string): void {
  delete m.entries[id];
}

/** Look up an entry by its relative path (linear scan; manifests are small). */
export function findByPath(m: Manifest, relPath: string): ManifestEntry | undefined {
  for (const entry of Object.values(m.entries)) {
    if (entry.path === relPath) return entry;
  }
  return undefined;
}
