import type { Job } from '@shared/types'
import type { AppContext } from '../context'
import { scoreJobWithAi } from './triage'

// Single-job actions behind the Jobs screen. Each one changes the job, writes an activity entry
// and tells the UI. Errors from the AI (budget, no model) are thrown for the caller to show.

function changed(ctx: AppContext, id: string): void {
  ctx.emit('jobs:changed', { jobIds: [id] })
}

export function dismissJob(ctx: AppContext, id: string, reason: string | null, tags: string[]): void {
  const job = ctx.jobs.get(id)
  if (!job) throw new Error('That job no longer exists.')
  ctx.jobs.dismiss(id, reason?.trim() || null, tags)
  ctx.events.add('dismissed', `Dismissed ${job.title} at ${job.company}${tags.length ? ` (${tags.join(', ')})` : ''}.`, id, { tags, reason })
  changed(ctx, id)
}

export function restoreJob(ctx: AppContext, id: string): void {
  const job = ctx.jobs.get(id)
  if (!job) throw new Error('That job no longer exists.')
  ctx.jobs.restore(id, ctx.settings.get().thresholds.shortlistScore)
  ctx.events.add('restored', `Restored ${job.title} at ${job.company}.`, id)
  changed(ctx, id)
}

/** Scores one job now, even if the free filters dropped it. A fresh AI call is made unless the cache has the answer. */
export async function scoreJobNow(ctx: AppContext, id: string): Promise<Job> {
  const job = ctx.jobs.get(id)
  if (!job) throw new Error('That job no longer exists.')
  const result = await scoreJobWithAi(ctx, job, { force: true })
  const fit = result.job.fit
  if (fit) ctx.events.add('scored', `Scored ${job.title} at ${job.company}: ${fit.score}. ${fit.summary}`, id, { score: fit.score })
  changed(ctx, id)
  return result.job
}
