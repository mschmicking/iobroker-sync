/**
 * Path containment for local file writes.
 *
 * Script ids come from the ioBroker server, and `idToRelPath` turns them into
 * local paths. Today the id -> path mapping happens to be safe (the `.` -> `/`
 * substitution destroys `..` sequences, and `path.join` neutralises a leading
 * slash), but that safety is incidental rather than designed: a future change to
 * the mapping, or a switch from `path.join` to `path.resolve`, would silently
 * reintroduce traversal. These helpers make the containment explicit and enforced.
 *
 * They also close a gap `path.join` cannot: writing *through* a symlink. A repo
 * shared between machines can contain a symlink inside the script root pointing
 * anywhere (`scripts/foo.js -> ~/.bashrc`), and a plain `writeFile` would happily
 * follow it out of the tree.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { UserError } from '../types';

/**
 * Resolves `relPath` against `root` and asserts the result stays inside `root`.
 * Throws `UserError` rather than returning a sentinel: an escaping path always
 * indicates either a hostile server or a bug, never a situation to paper over.
 */
export function resolveWithinRoot(root: string, relPath: string): string {
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, relPath);

  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    throw new UserError(
      `Refusing to touch "${relPath}": it resolves outside the script root.`,
      'This usually means a script id on the server contains unexpected path characters.',
    );
  }
  return resolved;
}

/**
 * True when `absPath` itself is a symlink. Used to refuse writes that would
 * follow a link out of the script root. Note this checks the final component
 * only; intermediate directory symlinks are handled by the realpath check below.
 */
async function isSymlink(absPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(absPath)).isSymbolicLink();
  } catch {
    return false; // missing file is fine — it is about to be created
  }
}

/**
 * Verifies that an existing path does not escape the root once symlinks are
 * resolved. Only meaningful for paths that already exist.
 */
async function assertRealpathWithinRoot(root: string, absPath: string): Promise<void> {
  const absRoot = path.resolve(root);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(absRoot);
  } catch {
    return; // root does not exist yet; nothing to compare against
  }

  let real: string;
  try {
    real = await fs.realpath(absPath);
  } catch {
    return; // does not exist yet
  }

  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new UserError(
      `Refusing to write "${path.relative(absRoot, absPath)}": it is a link pointing outside the script root (${real}).`,
      'Remove the symlink, or move the target inside the script root.',
    );
  }
}

/** Walks up from `dir` to the nearest ancestor that actually exists on disk. */
async function nearestExistingAncestor(dir: string): Promise<string> {
  let current = dir;
  for (;;) {
    try {
      await fs.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current; // reached filesystem root without finding one
      current = parent;
    }
  }
}

/**
 * Catches the case the final-component checks above miss: an *intermediate*
 * directory inside the script root that is itself a symlink to somewhere else
 * (`scripts/linked -> /somewhere/else`). `fs.mkdir(..., {recursive:true})` follows
 * existing directory symlinks rather than refusing them, so without this check
 * `safeWriteFile(root, 'linked/evil.js', ...)` would create `evil.js` outside root.
 * Finds the nearest ancestor of the target that already exists and requires its
 * resolved (symlink-free) location to stay within root.
 */
async function assertParentDirWithinRoot(root: string, absPath: string): Promise<void> {
  const absRoot = path.resolve(root);
  const ancestor = await nearestExistingAncestor(path.dirname(absPath));

  let realAncestor: string;
  let realRoot: string;
  try {
    [realAncestor, realRoot] = await Promise.all([fs.realpath(ancestor), fs.realpath(absRoot)]);
  } catch {
    return; // one side does not exist; nothing meaningful to compare
  }

  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw new UserError(
      `Refusing to write "${path.relative(absRoot, absPath)}": its containing directory is a link pointing outside the script root (${realAncestor}).`,
      'Remove the symlink, or move the target inside the script root.',
    );
  }
}

/**
 * Writes a file inside `root`, refusing anything that escapes the tree either by
 * path traversal or by following a symlink.
 */
export async function safeWriteFile(root: string, relPath: string, content: string): Promise<string> {
  const abs = resolveWithinRoot(root, relPath);

  if (await isSymlink(abs)) {
    throw new UserError(
      `Refusing to write "${relPath}": it is a symlink.`,
      'Writing through a symlink could modify a file outside the script root. Delete the link if this path should be a real file.',
    );
  }
  await assertRealpathWithinRoot(root, abs);
  await assertParentDirWithinRoot(root, abs);

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return abs;
}
