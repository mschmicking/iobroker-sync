import { CommandContext } from '../types';
import { resolveTargets } from './list';

export async function stop(ctx: CommandContext, opts: { pattern?: string }): Promise<void> {
  const scripts = await resolveTargets(ctx, opts.pattern);

  if (scripts.length === 0) {
    ctx.log.warn('No scripts found to stop.');
    return;
  }

  let skipped = 0;
  let stopped = 0;

  for (const script of scripts) {
    if (!script.common.enabled) {
      ctx.log.debug(`Skipping ${script._id} (already disabled)`);
      skipped++;
      continue;
    }

    if (!ctx.dryRun) {
      await ctx.objects.setEnabled(script._id, false);
    }
    ctx.log.result(`stop   ${script._id}`);
    stopped++;
  }

  if (skipped > 0) {
    ctx.log.info(`Skipped ${skipped} already stopped.`);
  }

  ctx.log.result(
    `Stopped ${stopped} script${stopped === 1 ? '' : 's'}.`,
  );
}

export async function restart(ctx: CommandContext, opts: { pattern?: string }): Promise<void> {
  const scripts = await resolveTargets(ctx, opts.pattern);

  if (scripts.length === 0) {
    ctx.log.warn('No scripts found to restart.');
    return;
  }

  for (const script of scripts) {
    if (!ctx.dryRun) {
      await ctx.objects.setEnabled(script._id, false);
      // ~300ms pause between disable and enable
      await new Promise((resolve) => setTimeout(resolve, 300));
      await ctx.objects.setEnabled(script._id, true);
    }
    ctx.log.result(`restart ${script._id}`);
  }

  ctx.log.result(
    `Restarted ${scripts.length} script${scripts.length === 1 ? '' : 's'}.`,
  );
}
