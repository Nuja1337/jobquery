import { describe, expect, it } from 'vitest'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { dismissJob, restoreJob } from './actions'
import { ingestRaw } from './ingest'
import { scoreJobWithAi, triageJobs } from './triage'

// Background work (scoring, drafting) reads a job, waits on the AI, then writes. A dismissal that
// lands in between must stick, or the job can come back and be prepared and auto-submitted.

async function setup(options: Parameters<typeof makeTestEnv>[0] = {}) {
  const env = await makeTestEnv(options)
  env.ctx.profile.save(makeProfile())
  return env
}

function add(env: Awaited<ReturnType<typeof setup>>, id: string) {
  return ingestRaw(env.ctx, makeRaw({ externalId: id, title: `Engineer ${id}`, description: `Role ${id}. ${'Build things. '.repeat(10)}` })).job
}

describe('a dismissal during background work', () => {
  it('is not undone by a score that arrives afterwards', async () => {
    const env = await setup({ score: () => 90, delayMs: 30 })
    const job = add(env, 'a')
    const scoring = scoreJobWithAi(env.ctx, job)
    dismissJob(env.ctx, job.id, null, [])
    await scoring
    expect(env.ctx.jobs.get(job.id)).toMatchObject({ stage: 'dismissed', fitScore: 90 })
  })

  it('skips queued jobs the user dismissed after triage started', async () => {
    const env = await setup({ score: () => 90, delayMs: 20 })
    const jobs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => add(env, id))
    const run = triageJobs(env.ctx, jobs, { concurrency: 1 })
    dismissJob(env.ctx, jobs[5].id, null, [])
    const summary = await run
    expect(env.ctx.jobs.get(jobs[5].id)?.stage).toBe('dismissed')
    expect(summary.scored).toBe(5)
    expect(env.llmCalls).toHaveLength(5)
  })

  it('keeps a withdrawn application withdrawn when a draft finishes later', async () => {
    const env = await setup()
    const job = add(env, 'a')
    const app = env.ctx.applications.create(job.id)
    dismissJob(env.ctx, job.id, null, [])
    // What the preparer writes when its draft is done.
    env.ctx.applications.update(app.id, { status: 'ready', answers: [] })
    expect(env.ctx.applications.get(app.id)?.status).toBe('withdrawn')
    expect(env.ctx.jobs.get(job.id)?.stage).toBe('dismissed')
    expect(env.ctx.applications.listReady()).toHaveLength(0)
  })

  it('still lets restore reopen the application', async () => {
    const env = await setup()
    const job = add(env, 'a')
    const app = env.ctx.applications.create(job.id)
    env.ctx.applications.update(app.id, { status: 'ready' })
    dismissJob(env.ctx, job.id, null, [])
    restoreJob(env.ctx, job.id)
    expect(env.ctx.applications.get(app.id)?.status).toBe('needs_attention')
    expect(env.ctx.jobs.get(job.id)?.stage).toBe('ready')
  })

  it('records a submission that happened after all, even on a dismissed job', async () => {
    const env = await setup()
    const job = add(env, 'a')
    const app = env.ctx.applications.create(job.id)
    dismissJob(env.ctx, job.id, null, [])
    env.ctx.applications.update(app.id, { status: 'submitted' })
    expect(env.ctx.applications.get(app.id)?.status).toBe('submitted')
    expect(env.ctx.jobs.get(job.id)?.stage).toBe('applied')
  })
})

describe('JobsRepo.moveStage', () => {
  it('moves only from the listed stages', async () => {
    const env = await setup()
    const job = add(env, 'a')
    env.ctx.jobs.setStage(job.id, 'preparing')
    expect(env.ctx.jobs.moveStage(job.id, 'shortlisted', ['preparing'])).toBe(true)
    env.ctx.jobs.dismiss(job.id, null, [])
    expect(env.ctx.jobs.moveStage(job.id, 'shortlisted', ['preparing'])).toBe(false)
    expect(env.ctx.jobs.get(job.id)?.stage).toBe('dismissed')
  })
})
