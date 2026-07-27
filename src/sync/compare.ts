/**
 * Three-way status computation (manifest baseline vs local vs remote).
 *
 * Pure logic only: no filesystem or network access here.
 */

import { Manifest, SyncStatus } from '../types';
import { idToRelPath, relPathToId } from './mapping';

export interface RemoteScriptInfo {
  id: string;
  engineType: string;
  engine?: string;
  enabled?: boolean;
  sourceHash: string;
}

export interface LocalFileInfo {
  relPath: string;
  hash: string;
}

export interface ComputeStatusInput {
  manifest: Manifest;
  /** Keyed by ioBroker id. */
  remote: Map<string, RemoteScriptInfo>;
  /** Keyed by relPath. */
  local: Map<string, LocalFileInfo>;
}

/**
 * Resolves the three-way sync state for every script known to the manifest, the
 * remote, and/or the local filesystem. See the module doc / spec for the full
 * state matrix; the short version:
 *
 *  - known to manifest + remote + local: compare local/remote against the manifest's
 *    baseHash to get in-sync / local-modified / remote-modified / conflict, except
 *    that local and remote agreeing with each other (even if both differ from base)
 *    is treated as in-sync — converging edits are not a conflict.
 *  - known to manifest + remote, missing locally: remote-only (nothing to lose by pulling).
 *  - known to manifest + local, missing on remote: remote-missing.
 *  - known to manifest only (missing everywhere else): remote-missing, so a stale
 *    manifest entry stays visible instead of silently disappearing.
 *  - unknown to manifest, present on remote only: remote-only.
 *  - unknown to manifest, present locally only: local-only.
 */
export function computeStatus(input: ComputeStatusInput): SyncStatus[] {
  const { manifest, remote, local } = input;
  const results: SyncStatus[] = [];
  const consumedLocalPaths = new Set<string>();

  const allIds = new Set<string>([...Object.keys(manifest.entries), ...remote.keys()]);

  for (const id of allIds) {
    const entry = manifest.entries[id];
    const remoteInfo = remote.get(id);
    const localInfo = entry ? local.get(entry.path) : undefined;

    if (entry && localInfo) {
      consumedLocalPaths.add(entry.path);
    }

    if (entry && remoteInfo) {
      if (!localInfo) {
        // Tracked and still on the server, but the local file is gone: user deleted
        // it locally (or never pulled it).
        results.push({
          id,
          path: entry.path,
          state: 'remote-only',
          engineType: remoteInfo.engineType,
          engine: remoteInfo.engine,
          enabled: remoteInfo.enabled,
          remoteHash: remoteInfo.sourceHash,
          baseHash: entry.baseHash,
        });
        continue;
      }

      const localChanged = localInfo.hash !== entry.baseHash;
      const remoteChanged = remoteInfo.sourceHash !== entry.baseHash;

      let state: SyncStatus['state'];
      if (!localChanged && !remoteChanged) {
        state = 'in-sync';
      } else if (localChanged && !remoteChanged) {
        state = 'local-modified';
      } else if (!localChanged && remoteChanged) {
        state = 'remote-modified';
      } else if (localInfo.hash === remoteInfo.sourceHash) {
        // Both changed, but converged on the same content: not a conflict.
        state = 'in-sync';
      } else {
        state = 'conflict';
      }

      results.push({
        id,
        path: entry.path,
        state,
        engineType: remoteInfo.engineType,
        engine: remoteInfo.engine,
        enabled: remoteInfo.enabled,
        localHash: localInfo.hash,
        remoteHash: remoteInfo.sourceHash,
        baseHash: entry.baseHash,
      });
      continue;
    }

    if (entry && !remoteInfo) {
      // Gone from the server.
      results.push({
        id,
        path: entry.path,
        state: 'remote-missing',
        engineType: entry.engineType,
        engine: entry.engine,
        enabled: entry.enabled,
        localHash: localInfo?.hash,
        baseHash: entry.baseHash,
      });
      continue;
    }

    if (!entry && remoteInfo) {
      // Never synced, exists on the server only. There's no manifest path to trust
      // yet, so derive the path the same way `pull` would place it.
      results.push({
        id,
        path: idToRelPath(id, remoteInfo.engineType),
        state: 'remote-only',
        engineType: remoteInfo.engineType,
        engine: remoteInfo.engine,
        enabled: remoteInfo.enabled,
        remoteHash: remoteInfo.sourceHash,
      });
      continue;
    }
  }

  // Anything left in `local` that wasn't claimed by a manifest entry is untracked.
  for (const [relPath, localInfo] of local) {
    if (consumedLocalPaths.has(relPath)) continue;
    results.push({
      // Lossy, but this is exactly the "brand-new local file" case relPathToId exists for.
      id: relPathToId(relPath),
      path: relPath,
      state: 'local-only',
      localHash: localInfo.hash,
    });
  }

  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results;
}
