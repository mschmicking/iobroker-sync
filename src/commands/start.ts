import { CommandContext } from '../types';
import { resolveTargets } from './list';

export async function start(ctx: CommandContext, opts: { pattern?: string }): Promise<void> {
  const scripts = await resolveTargets(ctx, opts.pattern);

  if (scripts.length === 0) {
    ctx.log.warn('No scripts found to start.');
    return;
  }

  let skipped = 0;
  let started = 0;

  for (const script of scripts) {
    if (script.common.enabled) {
      ctx.log.debug(`Skipping ${script._id} (already enabled)`);
      skipped++;
      continue;
    }

    if (!ctx.dryRun) {
      await ctx.objects.setEnabled(script._id, true);
    }
    ctx.log.result(`start  ${script._id}`);
    started++;
  }

  if (skipped > 0) {
    ctx.log.info(`Skipped ${skipped} already running.`);
  }

  ctx.log.result(`Started ${started} script${started === 1 ? '' : 's'}.`);
}
