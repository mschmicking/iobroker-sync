/**
 * `iob-sync diff` — unified diff of local vs remote content per script.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { CommandContext, SyncStatus } from '../types';
import { loadManifest } from '../sync/manifest';
import { computeStatus } from '../sync/compare';
import { scanLocal, scanRemote, matchesPattern } from '../sync/scan';
import { normalizeSource } from '../sync/mapping';

export interface DiffOptions {
  pattern?: string;
}

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_RESET = '\x1b[0m';

function matches(status: SyncStatus, pattern?: string): boolean {
  return matchesPattern(status.path, pattern) || matchesPattern(status.id, pattern);
}

function colorize(patch: string): string {
  if (!process.stdout.isTTY) return patch;
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return `${ANSI_CYAN}${line}${ANSI_RESET}`;
      }
      if (line.startsWith('+')) {
        return `${ANSI_GREEN}${line}${ANSI_RESET}`;
      }
      if (line.startsWith('-')) {
        return `${ANSI_RED}${line}${ANSI_RESET}`;
      }
      return line;
    })
    .join('\n');
}

async function readLocal(scriptRoot: string, relPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(scriptRoot, relPath), 'utf8');
    return normalizeSource(raw);
  } catch {
    return '';
  }
}

export async function diff(ctx: CommandContext, opts: DiffOptions): Promise<void> {
  const manifest = await loadManifest(ctx.root);
  const [local, remoteScan] = await Promise.all([scanLocal(ctx.scriptRoot), scanRemote(ctx.objects)]);
  const statuses = computeStatus({ manifest, remote: remoteScan.info, local })
    .filter((s) => matches(s, opts.pattern))
    .filter((s) => s.state !== 'in-sync');

  if (statuses.length === 0) {
    ctx.log.info('No differences (matching filter).');
    return;
  }

  for (const status of statuses) {
    const remoteScript = remoteScan.scripts.get(status.id);
    const remoteSource = remoteScript ? normalizeSource(remoteScript.common.source ?? '') : '';
    const localSource = await readLocal(ctx.scriptRoot, status.path);

    if (remoteSource === localSource) {
      continue;
    }

    const patch = createTwoFilesPatch(`remote:${status.id}`, `local:${status.path}`, remoteSource, localSource);
    ctx.log.info(`--- ${status.state}: ${status.path} ---`);
    ctx.log.result(colorize(patch));
  }
}
