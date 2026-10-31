import { describe, expect, it } from 'vitest'
import type { RawJob, SubmitResult } from '@shared/types'
import type { DiscoveryTask } from '../sources'
import { type TestEnv, makeProfile, makeRaw, makeTestEnv } from '../testing'
import { Pipeline, ingestJob } from './orchestrator'

const TS_DESCRIPTION = 'Build web apps in TypeScript and React with a small team.'

function fakeTask(jobs: () => RawJob[], extra: Partial<DiscoveryTask> = {}): DiscoveryTask {
  return { name: 'Fake source', run: async () => ({ jobs: jobs() }), ...extra }
}

async function setup(jobs: () => RawJob[], options: Parameters<typeof makeTestEnv>[0] = {}) {
  const env = await makeTestEnv(options)
  env.ctx.profile.save(makeProfile({ skills: ['TypeScript', 'React'] }))
  env.ctx.settings.update({
    preferences: { targetTitles: ['Software Engineer'], excludeTitleKeywords: ['intern'], remote: ['remote'] },
    thresholds: { prescoreMin: 30 }
  })
  const pipeline = new Pipeline(env.ctx, {}, () => [fakeTask(jobs)])
  return { ...env, pipeline }
}

function stage(env: TestEnv, id: string) {
  return env.ctx.jobs.listByStage(['new', 'filtered_out', 'prescored_out', 'duplicate', 'scored', 'shortlisted', 'closed', 'applied', 'ready', 'preparing']).find((j) => j.externalId === id)
}

const sample = (): RawJob[] => [
  makeRaw({ externalId: 'good', title: 'Senior Software Engineer', description: TS_DESCRIPTION }),
  makeRaw({ externalId: 'intern', title: 'Software Engineering Intern', description: TS_DESCRIPTION }),
  makeRaw({ externalId: 'onsite', title: 'Software Engineer', remote: 'onsite', location: 'Austin, TX', description: TS_DESCRIPTION }),
  makeRaw({ externalId: 'sales', title: 'Sales Engineer', description: 'Sell cloud contracts to buyers.' }),
  makeRaw({ externalId: 'weak', title: 'Software Engineer', description: `${TS_DESCRIPTION} Low fit marker.` }),
  makeRaw({ source: 'remoteok', externalId: 'copy', title: 'Senior Software Engineer', description: TS_DESCRIPTION })
]

describe('Pipeline', () => {
  it('moves jobs through filters, pre-score and scoring', async () => {
    const env = await setup(sample, { score: (prompt) => (prompt.includes('Low fit marker') ? 40 : 88) })
    const stats = await env.pipeline.run({ trigger: 'manual' })

    expect(stats).toMatchObject({
      discovered: 6,
      newJobs: 5,
      duplicates: 1,
      filteredOut: 2,
      prescoredOut: 1,
      scored: 2,
      shortlisted: 1,
      errors: 0,
      stoppedForBudget: false
    })
    expect(stats.costUsd).toBeGreaterThan(0)
    expect(stats.tokens).toBeGreaterThan(0)

    expect(stage(env, 'good')).toMatchObject({ stage: 'shortlisted', fitScore: 88, fitBucket: 'perfect' })
    expect(stage(env, 'weak')).toMatchObject({ stage: 'scored', fitScore: 40 })
    expect(stage(env, 'intern')).toMatchObject({ stage: 'filtered_out', filterReason: 'excluded title word: intern' })
    expect(stage(env, 'onsite')).toMatchObject({ stage: 'filtered_out', filterReason: 'on-site, you want remote' })
    expect(stage(env, 'sales')?.stage).toBe('prescored_out')
    expect(stage(env, 'sales')?.filterReason).toMatch(/^keyword match too low/)
    expect(stage(env, 'copy')).toMatchObject({ stage: 'duplicate', dupOf: stage(env, 'good')!.id })

    // Only the two jobs that passed the free rules reached the model.
    expect(env.llmCalls).toHaveLength(2)

    const types = env.ctx.events.list({ limit: 50 }).map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(['run_started', 'run_finished', 'discovered', 'filtered', 'shortlisted', 'scored']))
    const runs = env.ctx.runs.list(5)
    expect(runs).toHaveLength(1)
    expect(runs[0].finishedAt).not.toBeNull()
    expect(runs[0].stats.scored).toBe(2)
    expect(env.pushed.some((p) => p.channel === 'jobs:changed')).toBe(true)
    const phases = env.pushed.filter((p) => p.channel === 'pipeline:progress').map((p) => (p.payload as { phase: string }).phase)
    expect(phases).toEqual(expect.arrayContaining(['discovering', 'filtering', 'scoring', 'idle']))
    expect(env.pipeline.status().phase).toBe('idle')
  })

  it('never scores a job twice', async () => {
    const env = await setup(sample)
    await env.pipeline.run({})
    const callsAfterFirst = env.llmCalls.length
    const second = await env.pipeline.run({})
    expect(second).toMatchObject({ newJobs: 0, duplicates: 0, scored: 0, filteredOut: 0, prescoredOut: 0 })
    expect(second.discovered).toBe(6)
    expect(env.llmCalls).toHaveLength(callsAfterFirst)
  })

  it('scores the highest pre-score first, up to the per-run limit, and finishes the rest next run', async () => {
    const jobs = () => [
      makeRaw({ externalId: 'low', title: 'Software Engineer', description: 'Some TypeScript here.' }),
      makeRaw({ externalId: 'high', title: 'Software Engineer', description: 'TypeScript and React everywhere.' }),
      makeRaw({ externalId: 'mid', title: 'Software Engineer', description: 'Plenty of React.' })
    ]
    const env = await setup(jobs)
    env.ctx.settings.update({ budget: { maxTriagePerRun: 2 } })
    const first = await env.pipeline.run({})
    expect(first.scored).toBe(2)
    expect(stage(env, 'high')?.stage).toBe('shortlisted')
    expect(stage(env, 'low')?.stage).toBe('new')
    const second = await env.pipeline.run({})
    expect(second.scored).toBe(1)
    expect(stage(env, 'low')?.stage).toBe('shortlisted')
    expect(env.llmCalls).toHaveLength(3)
  })

  it('stops cleanly when the budget runs out and says so', async () => {
    const jobs = () => Array.from({ length: 10 }, (_, i) => makeRaw({ externalId: `j${i}`, title: 'Software Engineer', description: `${TS_DESCRIPTION} Variant ${i}.` }))
    const env = await setup(jobs)
    env.ctx.settings.update({ budget: { dailyUsd: 0.0004 } })
    const stats = await env.pipeline.run({})
    expect(stats.stoppedForBudget).toBe(true)
    expect(stats.scored).toBeGreaterThan(0)
    expect(stats.scored).toBeLessThan(10)
    expect(stats.errors).toBe(0)
    const stop = env.ctx.events.list({ limit: 50, types: ['budget_stop'] })
    expect(stop).toHaveLength(1)
    expect(stop[0].message).toMatch(/budget/i)
    expect(env.ctx.runs.list(1)[0].finishedAt).not.toBeNull()
    // A second run does not call the model at all.
    const calls = env.llmCalls.length
    const again = await env.pipeline.run({})
    expect(again.stoppedForBudget).toBe(true)
    expect(env.llmCalls).toHaveLength(calls)
  })

  it('reports a missing AI model instead of failing', async () => {
    const env = await setup(sample, { provider: false })
    const stats = await env.pipeline.run({})
    expect(stats.scored).toBe(0)
    expect(stats.errors).toBe(1)
    expect(stage(env, 'good')?.stage).toBe('new')
    expect(env.ctx.events.list({ limit: 20, types: ['error'] })[0].message).toMatch(/No AI model/)
  })

  it('closes jobs that left a watched board but keeps applied ones', async () => {
    let board: RawJob[] = []
    const mk = (id: string) => makeRaw({ source: 'greenhouse', ats: 'greenhouse', atsToken: 'acme', externalId: id, title: 'Software Engineer', description: `${TS_DESCRIPTION} ${id}` })
    const env = await makeTestEnv()
    env.ctx.profile.save(makeProfile({ skills: ['TypeScript'] }))
    const company = env.ctx.companies.save({ name: 'Acme', ats: 'greenhouse', atsToken: 'acme', watch: true })
    const task: DiscoveryTask = { name: 'Acme', board: { source: 'greenhouse', atsToken: 'acme', companyId: company.id }, run: async () => ({ jobs: board }) }
    const pipeline = new Pipeline(env.ctx, {}, () => [task])
    board = [mk('a'), mk('b'), mk('c')]
    await pipeline.run({ triage: false })
    env.ctx.jobs.setStage(stage(env, 'c')!.id, 'applied')
    board = [mk('a')]
    await pipeline.run({ triage: false })
    expect(stage(env, 'a')?.stage).toBe('new')
    expect(stage(env, 'b')?.stage).toBe('closed')
    expect(stage(env, 'c')?.stage).toBe('applied')
    // An empty answer is treated as a bad read, not an empty board.
    board = []
    await pipeline.run({ triage: false })
    expect(stage(env, 'a')?.stage).toBe('new')
    // A posting that comes back is reopened.
    board = [mk('a'), mk('b')]
    await pipeline.run({ triage: false })
    expect(stage(env, 'b')?.stage).not.toBe('closed')
  })

  it('logs a failing source and carries on with the others', async () => {
    const env = await makeTestEnv()
    env.ctx.profile.save(makeProfile())
    const bad: DiscoveryTask = { name: 'Broken board', run: async () => { throw new Error('503 from the server') } }
    const pipeline = new Pipeline(env.ctx, {}, () => [bad, fakeTask(() => [makeRaw({ externalId: 'x' })])])
    const stats = await pipeline.run({ triage: false })
    expect(stats).toMatchObject({ errors: 1, newJobs: 1 })
    expect(env.ctx.events.list({ limit: 20, types: ['error'] })[0].message).toContain('Broken board')
  })

  it('re-checks dropped jobs when the filters change', async () => {
    const env = await setup(sample)
    await env.pipeline.run({ triage: false })
    expect(stage(env, 'onsite')?.stage).toBe('filtered_out')
    env.ctx.settings.update({ preferences: { remote: ['remote', 'onsite'] } })
    await env.pipeline.run({ discover: false, triage: false })
    expect(stage(env, 'onsite')?.stage).toBe('new')
    expect(stage(env, 'intern')?.stage).toBe('filtered_out')
  })

  it('refuses a second run while one is going and can be cancelled', async () => {
    const env = await makeTestEnv()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow: DiscoveryTask = { name: 'Slow', run: async () => (await gate, { jobs: [makeRaw({ externalId: 'x' })] }) }
    const pipeline = new Pipeline(env.ctx, {}, () => [slow])
    const first = pipeline.run({})
    await expect(pipeline.run({})).rejects.toThrow(/already in progress/)
    expect(pipeline.isRunning()).toBe(true)
    pipeline.cancel()
    release()
    const stats = await first
    expect(stats.scored).toBe(0)
    expect(pipeline.isRunning()).toBe(false)
    expect(env.ctx.events.list({ limit: 10, types: ['run_finished'] })[0].message).toMatch(/stopped/)
  })

  describe('prepare and submit hooks', () => {
    async function withHooks() {
      const jobs = () => [
        makeRaw({ externalId: 'p1', title: 'Software Engineer', description: `${TS_DESCRIPTION} one` }),
        makeRaw({ externalId: 'p2', title: 'Software Engineer', description: `${TS_DESCRIPTION} two` }),
        makeRaw({ externalId: 'p3', title: 'Software Engineer', description: `${TS_DESCRIPTION} three Low fit marker` })
      ]
      const env = await setup(jobs, { score: (prompt) => (prompt.includes('Low fit marker') ? 65 : prompt.includes(' two') ? 80 : 92) })
      const prepared: string[] = []
      const submitted: string[] = []
      env.pipeline.setHooks({
        prepare: async (jobId) => {
          prepared.push(jobId)
          const app = env.ctx.applications.create(jobId)
          env.ctx.applications.update(app.id, { status: 'ready' })
        },
        submit: async (applicationId): Promise<SubmitResult> => {
          submitted.push(applicationId)
          env.ctx.applications.update(applicationId, { status: 'submitted' })
          return { ok: true, status: 'submitted', message: 'Sent.', screenshotPath: null }
        }
      })
      return { ...env, prepared, submitted }
    }

    it('does nothing unless the run and the setting both ask for it', async () => {
      const env = await withHooks()
      env.ctx.settings.update({ autopilot: { autoPrepare: false, autoSubmit: false } })
      await env.pipeline.run({ prepare: true, submit: true })
      expect(env.prepared).toHaveLength(0)
      await env.pipeline.run({ prepare: false, submit: false })
      env.ctx.settings.update({ autopilot: { autoPrepare: true, autoSubmit: true } })
      await env.pipeline.run({})
      expect(env.prepared).toHaveLength(0)
      expect(env.submitted).toHaveLength(0)
    })

    it('prepares shortlisted jobs at or above the auto-prepare score, best first, up to the limit', async () => {
      const env = await withHooks()
      env.ctx.settings.update({ autopilot: { autoPrepare: true, autoSubmit: false }, budget: { maxPreparePerRun: 1 } })
      const stats = await env.pipeline.run({ prepare: true })
      // p3 scored 65, below the default auto-prepare score of 75. p1 (92) goes before p2 (80).
      expect(stats.prepared).toBe(1)
      expect(env.prepared).toEqual([stage(env, 'p1')!.id])
      const next = await env.pipeline.run({ prepare: true })
      expect(next.prepared).toBe(1)
      expect(env.prepared).toEqual([stage(env, 'p1')!.id, stage(env, 'p2')!.id])
    })

    it('submits ready applications at or above the auto-submit score, within the daily cap and with no flagged answers', async () => {
      const env = await withHooks()
      env.ctx.settings.update({ autopilot: { autoPrepare: true, autoSubmit: true, dailySubmitCap: 5 }, thresholds: { autoSubmitScore: 85 } })
      // A flagged application with a high score must be skipped.
      await env.pipeline.run({ prepare: true })
      const p1 = env.ctx.applications.getByJob(stage(env, 'p1')!.id)!
      env.ctx.applications.update(p1.id, {
        answers: [{ fieldKey: 'q', label: 'Q', type: 'text', required: true, options: [], value: '', source: 'ai', confidence: 0.2, needsUser: true, note: null, lint: null }]
      })
      const first = await env.pipeline.run({ discover: false, submit: true })
      // p2 scored 80, p1 is flagged, so nothing is sent.
      expect(first.submitted).toBe(0)
      env.ctx.applications.update(p1.id, { answers: [] })
      const second = await env.pipeline.run({ discover: false, submit: true })
      expect(second.submitted).toBe(1)
      expect(env.submitted).toEqual([p1.id])
      expect(env.ctx.jobs.get(stage(env, 'p1')!.id)?.stage).toBe('applied')
    })

    it('honors the daily submit cap, counting what was already sent today', async () => {
      const env = await withHooks()
      env.ctx.settings.update({ autopilot: { autoPrepare: true, autoSubmit: true, dailySubmitCap: 1 }, thresholds: { autoSubmitScore: 70 } })
      await env.pipeline.run({ prepare: true, submit: true })
      expect(env.submitted).toHaveLength(1)
      const again = await env.pipeline.run({ discover: false, submit: true })
      expect(again.submitted).toBe(0)
      expect(env.submitted).toHaveLength(1)
    })
  })
})

describe('ingestJob', () => {
  it('stores a pasted posting, runs the free rules and calls no AI', async () => {
    const env = await makeTestEnv()
    env.ctx.profile.save(makeProfile())
    env.ctx.settings.update({ preferences: { excludeTitleKeywords: ['intern'] } })
    const kept = ingestJob(env.ctx, makeRaw({ externalId: 'k', title: 'Software Engineer', description: TS_DESCRIPTION }))
    expect(kept.stage).toBe('new')
    expect(kept.prescore).toBeGreaterThan(0)
    const dropped = ingestJob(env.ctx, makeRaw({ externalId: 'd', title: 'Engineering Intern', description: TS_DESCRIPTION }))
    expect(dropped).toMatchObject({ stage: 'filtered_out', filterReason: 'excluded title word: intern' })
    expect(env.llmCalls).toHaveLength(0)
    expect(env.ctx.events.list({ limit: 10, types: ['discovered'] })).toHaveLength(2)
    // Pasting the same link again returns the stored job.
    expect(ingestJob(env.ctx, makeRaw({ externalId: 'k', title: 'Software Engineer', description: TS_DESCRIPTION })).id).toBe(kept.id)
    expect(env.ctx.jobs.list({}).total).toBe(2)
  })

  it('gives a pasted board link the stored company name so it matches watched-board jobs', async () => {
    const env = await makeTestEnv()
    env.ctx.companies.save({ name: 'Ramp Business Corporation', ats: 'ashby', atsToken: 'ramp', watch: true })
    const job = ingestJob(env.ctx, makeRaw({ source: 'ashby', ats: 'ashby', atsToken: 'ramp', company: 'Ramp', externalId: 'abc' }))
    expect(job.company).toBe('Ramp Business Corporation')
    const again = ingestJob(env.ctx, makeRaw({ source: 'ashby', ats: 'ashby', atsToken: 'ramp', company: 'Ramp Business Corporation', externalId: 'abc' }))
    expect(again.id).toBe(job.id)
  })
})
