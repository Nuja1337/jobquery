import { describe, expect, it } from 'vitest'
import { BudgetExceededError } from '../llm/errors'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { renderProfile } from '../writing/prompts'
import { ingestRaw } from './ingest'
import { scoreJobWithAi, toAssessment, triageJobs } from './triage'

async function setup(options: Parameters<typeof makeTestEnv>[0] = {}) {
  const env = await makeTestEnv(options)
  env.ctx.profile.save(makeProfile())
  return env
}

function add(env: Awaited<ReturnType<typeof setup>>, id: string, extra: Record<string, unknown> = {}) {
  return ingestRaw(env.ctx, makeRaw({ externalId: id, title: `Engineer ${id}`, ...extra })).job
}

describe('scoreJobWithAi', () => {
  it('stores the score, bucket, summary and profile version and shortlists the job', async () => {
    const env = await setup({ score: () => 82 })
    const job = add(env, 'a')
    const result = await scoreJobWithAi(env.ctx, job)
    expect(result.called).toBe(true)
    expect(result.costUsd).toBeGreaterThan(0)
    const stored = env.ctx.jobs.get(job.id)!
    expect(stored).toMatchObject({ stage: 'shortlisted', fitScore: 82, fitBucket: 'great', fitSummary: 'Fit is 82.' })
    expect(stored.fit).toMatchObject({ score: 82, bucket: 'great', matches: ['TypeScript'], seniorityFit: 'match' })
    expect(env.ctx.jobs.scoredProfileVersion(job.id)).toBe(env.ctx.profile.get().version)
  })

  it('archives a job below the shortlist line as scored', async () => {
    const env = await setup({ score: () => 45 })
    const job = add(env, 'a')
    await scoreJobWithAi(env.ctx, job)
    expect(env.ctx.jobs.get(job.id)).toMatchObject({ stage: 'scored', fitBucket: 'weak' })
  })

  it('never sends a job again for the same profile version unless forced', async () => {
    const env = await setup()
    const job = add(env, 'a')
    await scoreJobWithAi(env.ctx, job)
    expect(env.llmCalls).toHaveLength(1)
    const again = await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!)
    expect(again.called).toBe(false)
    expect(env.llmCalls).toHaveLength(1)
    // Forcing asks again. The identical request comes back from the local cache, so it is still free.
    const forced = await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!, { force: true })
    expect(forced).toMatchObject({ called: true, cached: true, costUsd: 0 })
    expect(env.llmCalls).toHaveLength(1)
  })

  it('scores again after a change that affects fit, but not after notes or links change', async () => {
    const env = await setup()
    const job = add(env, 'a')
    await scoreJobWithAi(env.ctx, job)
    const current = env.ctx.profile.get().profile
    env.ctx.profile.save({ ...current, notesForAi: 'Prefers small teams.', links: { ...current.links, github: 'https://github.com/sam' } })
    expect((await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!)).called).toBe(false)
    env.ctx.profile.save({ ...current, skills: [...current.skills, 'Rust'] })
    expect((await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!)).called).toBe(true)
    expect(env.llmCalls).toHaveLength(2)
  })

  it('keeps the rubric and profile text identical across jobs so provider caching works', async () => {
    const env = await setup()
    await scoreJobWithAi(env.ctx, add(env, 'a', { description: 'First posting.' }))
    await scoreJobWithAi(env.ctx, add(env, 'b', { description: 'A different posting.' }))
    const [first, second] = env.llmCalls
    expect(first.system).toBe(second.system)
    expect(first.context).toBe(second.context)
    expect(first.prompt).not.toBe(second.prompt)
    expect(first.context).toContain(renderProfile(env.ctx.profile.get().profile))
    expect(first.system).toMatch(/85 to 100/)
    expect(first.system).toMatch(/clearance/i)
    expect(first.prompt).toContain('Engineer a')
    expect(first.prompt).not.toContain('Sam Rivera')
  })

  it('shortens long descriptions in the prompt', async () => {
    const env = await setup()
    await scoreJobWithAi(env.ctx, add(env, 'a', { description: 'Useful sentence. '.repeat(1000) }))
    expect(env.llmCalls[0].prompt.length).toBeLessThan(4600)
    expect(env.llmCalls[0].prompt).toContain('[posting shortened]')
  })

  it('clamps scores to 0-100', () => {
    const base = { summary: 's', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }
    expect(toAssessment({ ...base, score: 140 }, 60).score).toBe(100)
    expect(toAssessment({ ...base, score: -3 }, 60)).toMatchObject({ score: 0, bucket: 'weak' })
    expect(toAssessment({ ...base, score: 71.6 }, 60)).toMatchObject({ score: 72, bucket: 'great' })
    expect(toAssessment({ ...base, score: 86 }, 60).bucket).toBe('perfect')
  })

  it('lets a forced score keep the stage of a job already past scoring', async () => {
    const env = await setup({ score: () => 90 })
    const job = add(env, 'a')
    env.ctx.jobs.dismiss(job.id, null, [])
    await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!, { force: true })
    expect(env.ctx.jobs.get(job.id)).toMatchObject({ stage: 'dismissed', fitScore: 90 })
  })
})

describe('triageJobs', () => {
  it('runs four at a time', async () => {
    const env = await setup({ delayMs: 15 })
    const jobs = Array.from({ length: 10 }, (_, i) => add(env, `j${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(summary.scored).toBe(10)
    expect(env.model.maxInflight).toBe(4)
  })

  it('stops cleanly when the budget runs out', async () => {
    const env = await setup()
    const jobs = Array.from({ length: 6 }, (_, i) => add(env, `j${i}`))
    // Each call costs about $0.00035 on the default Haiku price.
    env.ctx.settings.update({ budget: { dailyUsd: 0.0004 } })
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary.stoppedForBudget).toBe(true)
    expect(summary.budgetMessage).toMatch(/budget/)
    expect(summary.scored).toBe(2)
    expect(summary.errors).toBe(0)
    expect(env.ctx.jobs.listByStage('new')).toHaveLength(4)
  })

  it('counts a failed job as an error and keeps going', async () => {
    const env = await setup({ fail: (prompt) => (prompt.includes('Engineer bad') ? new Error('model said no') : null) })
    const jobs = [add(env, 'ok1'), add(env, 'bad'), add(env, 'ok2')]
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary).toMatchObject({ scored: 2, errors: 1 })
    expect(summary.errorMessages[0]).toContain('model said no')
    expect(env.ctx.jobs.get(jobs[1].id)!.stage).toBe('new')
  })

  it('throws budget errors from a single score so the caller can show them', async () => {
    const env = await setup()
    env.ctx.settings.update({ budget: { dailyUsd: 0.0001 } })
    const first = add(env, 'a')
    await scoreJobWithAi(env.ctx, first)
    await expect(scoreJobWithAi(env.ctx, add(env, 'b'))).rejects.toBeInstanceOf(BudgetExceededError)
  })
})
