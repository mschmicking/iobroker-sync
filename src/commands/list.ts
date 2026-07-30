import { CommandContext, ScriptObject } from '../types';
import { idToRelPath } from '../sync/mapping';
import { matchesPattern } from '../sync/scan';

/**
 * Resolves the scripts a lifecycle command should act on.
 *
 * Uses the same matcher as the sync commands (see `matchesPattern`) so that a
 * pattern selects the same scripts whether you `status` it or `stop` it.
 */
export async function resolveTargets(
  ctx: CommandContext,
  pattern?: string,
): Promise<ScriptObject[]> {
  const allScripts = await ctx.objects.listScripts();

  if (!pattern) {
    return allScripts;
  }

  return allScripts.filter((script) => {
    const relPath = idToRelPath(script._id, script.common.engineType || '');
    return matchesPattern(script._id, pattern) || matchesPattern(relPath, pattern);
  });
}

export async function list(ctx: CommandContext, opts: { pattern?: string }): Promise<void> {
  const scripts = await resolveTargets(ctx, opts.pattern);

  if (scripts.length === 0) {
    ctx.log.info('No scripts found.');
    return;
  }

  // Build table rows
  interface Row {
    enabled: string;
    id: string;
    engine: string;
    engineType: string;
    path: string;
  }

  const rows: Row[] = scripts.map((script) => {
    const relPath = idToRelPath(script._id, script.common.engineType || '');
    const engineInstance = script.common.engine
      ? script.common.engine.split('.').slice(-1)[0]
      : '?';

    return {
      enabled: script.common.enabled ? '✓' : '',
      id: script._id,
      engine: `js.${engineInstance}`,
      engineType: script.common.engineType || '?',
      path: relPath,
    };
  });

  // One record per script, with the real values rather than the display strings:
  // `enabled` as a boolean and the full engine id, so a consumer never has to parse
  // the human table back apart.
  for (const script of scripts) {
    ctx.log.data({
      type: 'script',
      id: script._id,
      path: idToRelPath(script._id, script.common.engineType || ''),
      engine: script.common.engine ?? null,
      engineType: script.common.engineType || null,
      enabled: Boolean(script.common.enabled),
    });
  }

  // Calculate column widths
  const widths = {
    enabled: 1,
    id: Math.max(4, ...rows.map((r) => r.id.length)),
    engine: Math.max(6, ...rows.map((r) => r.engine.length)),
    engineType: Math.max(10, ...rows.map((r) => r.engineType.length)),
    path: Math.max(4, ...rows.map((r) => r.path.length)),
  };

  // Print header
  const header = [
    ' '.repeat(widths.enabled),
    'ID'.padEnd(widths.id),
    'ENGINE'.padEnd(widths.engine),
    'TYPE'.padEnd(widths.engineType),
    'PATH'.padEnd(widths.path),
  ]
    .join('  ')
    .trimEnd();

  ctx.log.info(header);
  ctx.log.info('-'.repeat(header.length));

  // Print rows
  for (const row of rows) {
    const line = [
      row.enabled.padEnd(widths.enabled),
      row.id.padEnd(widths.id),
      row.engine.padEnd(widths.engine),
      row.engineType.padEnd(widths.engineType),
      row.path.padEnd(widths.path),
    ]
      .join('  ')
      .trimEnd();
    ctx.log.info(line);
  }

  // Summary
  const enabledCount = rows.filter((r) => r.enabled === '✓').length;
  ctx.log.info('');
  ctx.log.result(
    `${scripts.length} script${scripts.length === 1 ? '' : 's'}, ${enabledCount} enabled`,
  );
}
