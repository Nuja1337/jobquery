import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawJob, SubmitResult } from '@shared/types'
import { BudgetExceededError, LlmFormatError, NoModelConfiguredError, OutOfCreditsError, RateLimitedError } from '../llm/errors'
import { type DiscoveryTask, defaultTasks } from '../sources'
import { HttpError, fetchJson, hostPauseUntil, setHttpClock } from '../sources/http'
import { type TestEnv, makeProfile, makeRaw, makeTestEnv } from '../testing'
import { type PipelineHooks, Pipeline, ingestJob, restageForShortlist } from './orchestrator'

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
      // Both skills, so it never ties with 'low' and the order is not left to the discovery time.
      makeRaw({ externalId: 'mid', title: 'Software Engineer', description: 'Plenty of React and some TypeScript.' })
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

  it('stops for a provider rate limit with one calm event and no errors', async () => {
    const jobs = () => Array.from({ length: 8 }, (_, i) => makeRaw({ externalId: `j${i}`, title: 'Software Engineer', description: `${TS_DESCRIPTION} Variant ${i}.` }))
    const env = await setup(jobs, { fail: (prompt) => (prompt.includes('Variant 2.') ? new RateLimitedError('The provider said it received too many requests.') : null) })
    const stats = await env.pipeline.run({})
    expect(stats.stoppedForRateLimit).toBe(true)
    expect(stats.stoppedForBudget).toBe(false)
    expect(stats.errors).toBe(0)
    expect(stats.scored).toBeLessThan(8)
    const stop = env.ctx.events.list({ limit: 50, types: ['rate_limit_stop'] })
    expect(stop).toHaveLength(1)
    expect(stop[0].message).toMatch(/^Your AI provider's limit was reached, so \d+ jobs? waits? for a later run\./)
    expect(env.ctx.events.list({ limit: 50, types: ['error'] })).toHaveLength(0)
    expect(env.ctx.runs.list(1)[0].stats.stoppedForRateLimit).toBe(true)
    // No job was marked as failing, so the next run picks them all up again.
    for (const job of env.ctx.jobs.listByStage('new')) expect(job.triageFailures).toBe(0)
  })

  it('skips a job after three failed scoring attempts', async () => {
    const jobs = () => [
      makeRaw({ externalId: 'bad', title: 'Software Engineer', description: `${TS_DESCRIPTION} Broken marker.` }),
      makeRaw({ externalId: 'fine', title: 'Software Engineer', description: `${TS_DESCRIPTION} Fine.` })
    ]
    const env = await setup(jobs, { fail: (prompt) => (prompt.includes('Broken marker') ? new LlmFormatError('model said no', '') : null) })
    for (let run = 0; run < 3; run++) await env.pipeline.run({})
    expect(stage(env, 'bad')).toMatchObject({ stage: 'new', triageFailures: 3 })
    const calls = env.llmCalls.length
    const fourth = await env.pipeline.run({})
    expect(fourth.errors).toBe(0)
    expect(env.llmCalls).toHaveLength(calls)
  })

  it('keeps scoring on a free provider after the budget is used up', async () => {
    const jobs = () => Array.from({ length: 4 }, (_, i) => makeRaw({ externalId: `j${i}`, title: 'Software Engineer', description: `${TS_DESCRIPTION} Variant ${i}.` }))
    const env = await setup(jobs)
    env.ctx.settings.update({ budget: { dailyUsd: 0.0004 } })
    const free = await env.ctx.providers.save({ kind: 'gemini', label: 'Gemini', apiKey: 'k', billing: 'free' })
    const ref = { providerId: free.id, model: 'gemini-2.5-flash' }
    env.ctx.settings.update({ routing: { triage: ref, writing: ref, extraction: ref } })
    const stats = await env.pipeline.run({})
    expect(stats.stoppedForBudget).toBe(false)
    expect(stats.scored).toBe(4)
    expect(stats.costUsd).toBe(0)
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
      env.ctx.settings.update({ autopilot: { enabled: true, autoPrepare: true, autoSubmit: true } })
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

    it('stops preparing a job after two failed attempts, until a manual prepare works', async () => {
      const env = await withHooks()
      env.ctx.settings.update({ autopilot: { autoPrepare: true, autoSubmit: false }, budget: { maxPreparePerRun: 5 } })
      // Discover and score first, without preparing.
      await env.pipeline.run({})
      const p1 = stage(env, 'p1')!.id
      env.pipeline.setHooks({
        prepare: async (jobId) => {
          env.prepared.push(jobId)
          if (jobId === p1) {
            env.ctx.jobs.recordPrepareFailure(jobId)
            throw new Error('The form could not be read.')
          }
        }
      })
      await env.pipeline.run({ prepare: true })
      await env.pipeline.run({ prepare: true })
      expect(env.prepared.filter((id) => id === p1)).toHaveLength(2)
      await env.pipeline.run({ prepare: true })
      expect(env.prepared.filter((id) => id === p1)).toHaveLength(2)
      // The other jobs were not held back.
      expect(env.prepared.filter((id) => id !== p1).length).toBeGreaterThan(0)
      // A successful manual prepare clears the count, so a later run may try again.
      env.ctx.jobs.resetPrepareFailures(p1)
      await env.pipeline.run({ prepare: true })
      expect(env.prepared.filter((id) => id === p1)).toHaveLength(3)
    })

    it('submits ready applications at or above the auto-submit score, within the daily cap and with no flagged answers', async () => {
      const env = await withHooks()
      env.ctx.settings.update({ autopilot: { enabled: true, autoPrepare: true, autoSubmit: true, dailySubmitCap: 5 }, thresholds: { autoSubmitScore: 85 } })
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
      env.ctx.settings.update({ autopilot: { enabled: true, autoPrepare: true, autoSubmit: true, dailySubmitCap: 1 }, thresholds: { autoSubmitScore: 70 } })
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

describe('Pipeline housekeeping', () => {
  const DAY = 86_400_000
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString()

  it('lets a job back in once the company cooldown ends', async () => {
    const env = await setup(() => [makeRaw({ externalId: 'next', title: 'Software Engineer', description: TS_DESCRIPTION })])
    env.ctx.settings.update({ preferences: { companyCooldownDays: 90 } })
    // The user applied to Acme 89 days ago.
    const past = ingestJob(env.ctx, makeRaw({ externalId: 'past', title: 'Software Engineer', description: `${TS_DESCRIPTION} Past.` }))
    const app = env.ctx.applications.create(past.id)
    env.ctx.applications.update(app.id, { status: 'submitted', submittedAt: daysAgo(89) })

    await env.pipeline.run({ triage: false })
    expect(stage(env, 'next')).toMatchObject({ stage: 'filtered_out', filterReason: 'applied to this company 89 days ago' })

    // No setting or profile changed, only the date moved on.
    env.ctx.db.run('UPDATE applications SET submitted_at = :at WHERE id = :id', { id: app.id, at: daysAgo(91) })
    await env.pipeline.run({ discover: false, triage: false })
    expect(stage(env, 'next')?.stage).toBe('new')
    expect(stage(env, 'next')?.filterReason).toBeNull()
  })

  it('closes search jobs that no search has returned for 30 days, but only after the source answers', async () => {
    const env = await makeTestEnv()
    env.ctx.profile.save(makeProfile({ skills: ['TypeScript'] }))
    let listing: RawJob[] = []
    const search: DiscoveryTask = { name: 'RemoteOK', searchSource: 'remoteok', run: async () => ({ jobs: listing }) }
    const pipeline = new Pipeline(env.ctx, {}, () => [search])
    const mk = (id: string) => makeRaw({ source: 'remoteok', externalId: id, title: 'Software Engineer', description: `${TS_DESCRIPTION} ${id}` })
    listing = [mk('old'), mk('kept')]
    await pipeline.run({ triage: false })
    env.ctx.db.run("UPDATE jobs SET last_seen_at = :at WHERE canonical_key LIKE '%:old'", { at: daysAgo(31) })
    env.ctx.db.run("UPDATE jobs SET last_seen_at = :at WHERE canonical_key LIKE '%:kept'", { at: daysAgo(31) })

    // An empty answer is a bad read. Nothing closes.
    listing = []
    await pipeline.run({ triage: false })
    expect(stage(env, 'old')?.stage).not.toBe('closed')

    listing = [mk('kept')]
    await pipeline.run({ triage: false })
    expect(stage(env, 'old')?.stage).toBe('closed')
    expect(stage(env, 'kept')?.stage).not.toBe('closed')
  })

  it('does not close a search job the user is working on', async () => {
    const env = await makeTestEnv()
    const search: DiscoveryTask = { name: 'RemoteOK', searchSource: 'remoteok', run: async () => ({ jobs: [makeRaw({ source: 'remoteok', externalId: 'other' })] }) }
    const pipeline = new Pipeline(env.ctx, {}, () => [search])
    const job = ingestJob(env.ctx, makeRaw({ source: 'remoteok', externalId: 'mine' }))
    env.ctx.applications.create(job.id)
    env.ctx.db.run('UPDATE jobs SET last_seen_at = :at WHERE id = :id', { id: job.id, at: daysAgo(60) })
    await pipeline.run({ triage: false })
    expect(env.ctx.jobs.get(job.id)?.stage).toBe('preparing')
  })

  it('does not auto-prepare a job no source has listed for more than 30 days', async () => {
    const jobs = () => [
      makeRaw({ externalId: 'fresh', title: 'Software Engineer', description: `${TS_DESCRIPTION} Fresh.` }),
      makeRaw({ externalId: 'stale', title: 'Software Engineer', description: `${TS_DESCRIPTION} Stale.` })
    ]
    const env = await setup(jobs)
    const prepared: string[] = []
    env.pipeline.setHooks({ prepare: async (id) => void prepared.push(id) })
    env.ctx.settings.update({ autopilot: { autoPrepare: true, autoSubmit: false } })
    await env.pipeline.run({})
    expect(stage(env, 'stale')?.stage).toBe('shortlisted')
    // The board still lists it, but no source has seen it for a while, as when a watched company is dropped.
    env.ctx.db.run("UPDATE jobs SET last_seen_at = :at WHERE canonical_key LIKE '%:stale'", { at: daysAgo(40) })
    await env.pipeline.run({ discover: false, prepare: true })
    expect(prepared).toEqual([stage(env, 'fresh')!.id])
  })

  it('restages scored jobs when the shortlist score changes', async () => {
    const env = await setup(() => [makeRaw({ externalId: 'j', title: 'Software Engineer', description: TS_DESCRIPTION })], { score: () => 72 })
    await env.pipeline.run({})
    expect(stage(env, 'j')).toMatchObject({ stage: 'shortlisted', fitScore: 72, fitBucket: 'great' })
    env.pushed.length = 0

    env.ctx.settings.update({ thresholds: { shortlistScore: 75 } })
    expect(restageForShortlist(env.ctx)).toEqual([stage(env, 'j')!.id])
    expect(stage(env, 'j')).toMatchObject({ stage: 'scored', fitBucket: 'weak' })
    expect(env.pushed.some((p) => p.channel === 'jobs:changed')).toBe(true)

    // A run also notices a change that nobody announced.
    env.ctx.settings.update({ thresholds: { shortlistScore: 60 } })
    await env.pipeline.run({ discover: false, triage: false })
    expect(stage(env, 'j')).toMatchObject({ stage: 'shortlisted', fitBucket: 'great' })
    expect(env.llmCalls).toHaveLength(1)
  })

  it('shows a repost under a new id as the live job without another AI call', async () => {
    let board: RawJob[] = []
    const mk = (id: string) =>
      makeRaw({ source: 'greenhouse', ats: 'greenhouse', atsToken: 'acme', externalId: id, title: 'Software Engineer', description: `${TS_DESCRIPTION} Same posting.` })
    const env = await makeTestEnv()
    env.ctx.profile.save(makeProfile({ skills: ['TypeScript', 'React'] }))
    const company = env.ctx.companies.save({ name: 'Acme', ats: 'greenhouse', atsToken: 'acme', watch: true })
    const task: DiscoveryTask = { name: 'Acme', board: { source: 'greenhouse', atsToken: 'acme', companyId: company.id }, run: async () => ({ jobs: board }) }
    const pipeline = new Pipeline(env.ctx, {}, () => [task])

    board = [mk('old')]
    await pipeline.run({})
    expect(stage(env, 'old')?.stage).toBe('shortlisted')
    expect(env.llmCalls).toHaveLength(1)

    // The next run lists the posting under a new id. The new id arrives before the old one is seen to be gone.
    board = [mk('new')]
    const second = await pipeline.run({})
    expect(second.scored).toBe(0)
    expect(env.llmCalls).toHaveLength(1)
    expect(stage(env, 'old')?.stage).toBe('closed')
    expect(stage(env, 'new')).toMatchObject({ stage: 'shortlisted', fitScore: 80, dupOf: null })
  })

  it('does not store a watched board again after its company is renamed', async () => {
    const mk = (company: string) => makeRaw({ source: 'greenhouse', ats: 'greenhouse', atsToken: 'acme', externalId: 'r1', company, title: 'Software Engineer', description: TS_DESCRIPTION })
    let name = 'Acme'
    const env = await makeTestEnv()
    env.ctx.profile.save(makeProfile({ skills: ['TypeScript', 'React'] }))
    const company = env.ctx.companies.save({ name: 'Acme', ats: 'greenhouse', atsToken: 'acme', watch: true })
    const task: DiscoveryTask = { name: 'Acme', board: { source: 'greenhouse', atsToken: 'acme', companyId: company.id }, run: async () => ({ jobs: [mk(name)] }) }
    const pipeline = new Pipeline(env.ctx, {}, () => [task])
    await pipeline.run({})
    expect(env.llmCalls).toHaveLength(1)
    env.ctx.companies.save({ id: company.id, name: 'Acme Robotics', ats: 'greenhouse', atsToken: 'acme', watch: true })
    name = 'Acme Robotics'
    const stats = await pipeline.run({})
    expect(stats).toMatchObject({ newJobs: 0, scored: 0 })
    expect(env.ctx.jobs.list({}).total).toBe(1)
    expect(env.llmCalls).toHaveLength(1)
    expect(stage(env, 'r1')?.company).toBe('Acme Robotics')
  })
})

describe('Pipeline unattended submitting', () => {
  const DAY = 86_400_000
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString()
  const FIT = { score: 95, bucket: 'perfect' as const, summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }
  const ok = (): SubmitResult => ({ ok: true, status: 'submitted', message: 'Sent.', screenshotPath: null })

  async function readyEnv(settings: Parameters<TestEnv['ctx']['settings']['update']>[0] = {}) {
    const env = await makeTestEnv()
    env.ctx.profile.save(makeProfile())
    env.ctx.settings.update({
      preferences: { companyCooldownDays: 90 },
      thresholds: { autoSubmitScore: 85 },
      autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 3 },
      ...settings
    })
    /** A ready application for a new job. */
    const addReady = (raw: Partial<RawJob> = {}) => {
      const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: `r${Math.random().toString(36).slice(2, 8)}`, ...raw }), null)
      env.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
      const app = env.ctx.applications.create(job.id)
      env.ctx.applications.update(app.id, { status: 'ready' })
      return app.id
    }
    return { ...env, addReady }
  }
  const submitRun = (env: TestEnv, hooks: PipelineHooks, limits?: { prepareMs: number; submitMs: number }) =>
    new Pipeline(env.ctx, hooks, () => [], limits).run({ discover: false, triage: false, submit: true })

  it('keeps going past failures until enough applications were sent', async () => {
    const env = await readyEnv({ autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 2 } })
    const ids = ['Co1', 'Co2', 'Co3', 'Co4', 'Co5'].map((company) => env.addReady({ company }))
    const tried: string[] = []
    const stats = await submitRun(env, {
      submit: async (id) => {
        tried.push(id)
        if (tried.length <= 2) {
          // Fails while filling, with no click. It does not use up a send.
          env.ctx.applications.update(id, { status: 'needs_attention' })
          return { ok: false, status: 'needs_attention', message: 'Captcha.', screenshotPath: null }
        }
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    expect(stats.submitted).toBe(2)
    expect(tried).toEqual(ids.slice(0, 4))
    expect(env.ctx.applications.listReady()).toHaveLength(1)
  })

  it('sends nothing once autopilot is paused, even with auto-submit on', async () => {
    const paused = await readyEnv({ autopilot: { enabled: false, autoSubmit: true, dailySubmitCap: 3 } })
    paused.addReady({ company: 'Co1' })
    let calls = 0
    await submitRun(paused, {
      submit: async () => {
        calls += 1
        return ok()
      }
    })
    expect(calls).toBe(0)

    // Paused while the first send is under way: the next application is not tried.
    const env = await readyEnv()
    for (const company of ['Co1', 'Co2', 'Co3']) env.addReady({ company })
    const tried: string[] = []
    await submitRun(env, {
      submit: async (id) => {
        tried.push(id)
        env.ctx.settings.update({ autopilot: { enabled: false } })
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    expect(tried).toHaveLength(1)
  })

  it('stops at the budget and at a provider limit thrown by the hook', async () => {
    const budget = await readyEnv()
    for (const company of ['A', 'B', 'C']) budget.addReady({ company })
    let calls = 0
    const spent = await submitRun(budget, {
      submit: async () => {
        calls += 1
        throw new BudgetExceededError("Today's AI budget of $1.00 is used up.")
      }
    })
    expect(calls).toBe(1)
    expect(spent.stoppedForBudget).toBe(true)
    expect(budget.ctx.events.list({ limit: 20, types: ['budget_stop'] })).toHaveLength(1)

    const limited = await readyEnv()
    for (const company of ['A', 'B', 'C']) limited.addReady({ company })
    calls = 0
    const stats = await submitRun(limited, {
      submit: async () => {
        calls += 1
        throw new RateLimitedError('The provider said it received too many requests.')
      }
    })
    expect(calls).toBe(1)
    expect(stats).toMatchObject({ stoppedForRateLimit: true, errors: 0 })
    expect(limited.ctx.events.list({ limit: 20, types: ['rate_limit_stop'] })).toHaveLength(1)
  })

  it('stops after two failures in a row that threw, and a success in between resets the count', async () => {
    const env = await readyEnv({ autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
    for (let i = 0; i < 6; i++) env.addReady({ company: `Co${i}` })
    let calls = 0
    const stats = await submitRun(env, {
      submit: async () => {
        calls += 1
        throw new Error('Could not open a browser. Install Chrome or Edge.')
      }
    })
    expect(calls).toBe(2)
    expect(stats.errors).toBe(2)
    const stop = env.ctx.events.list({ limit: 20, types: ['error'] })
    expect(stop).toHaveLength(1)
    expect(stop[0].message).toMatch(/^Submitting stopped after 2 failures in a row\./)

    const mixed = await readyEnv({ autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
    for (let i = 0; i < 6; i++) mixed.addReady({ company: `Co${i}` })
    calls = 0
    const after = await submitRun(mixed, {
      submit: async (id) => {
        calls += 1
        if (calls % 2 === 1) throw new Error('The page would not load.')
        mixed.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    expect(calls).toBe(6)
    expect(after.submitted).toBe(3)
  })

  it('sends one application per company inside the cooldown, including clicks and earlier sends', async () => {
    const env = await readyEnv({ autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
    const first = env.addReady({ company: 'Acme', title: 'Engineer', externalId: 'a1' })
    env.addReady({ company: 'Acme, Inc.', title: 'Senior Engineer', externalId: 'a2' })
    env.addReady({ company: 'Globex', title: 'Engineer', externalId: 'g1' })
    const sent: string[] = []
    // The hook records nothing itself, so the run has to remember what it sent.
    const stats = await submitRun(env, {
      submit: async (id) => {
        sent.push(id)
        return ok()
      }
    })
    expect(stats.submitted).toBe(2)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe(first)
    expect(env.ctx.events.list({ limit: 20, types: ['submitted'] }).some((e) => /Left 1 application for later/.test(e.message))).toBe(true)

    // A click with no confirmation 10 days ago counts as much as a confirmed submission.
    const clicked = await readyEnv({ autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
    const old = clicked.addReady({ company: 'Initech', externalId: 'old' })
    clicked.ctx.applications.update(old, { status: 'needs_attention', submitClickedAt: daysAgo(10) })
    clicked.addReady({ company: 'Initech', externalId: 'new' })
    const none = await submitRun(clicked, { submit: async () => ok() })
    expect(none.submitted).toBe(0)

    // Outside the cooldown the company is open again.
    clicked.ctx.settings.update({ preferences: { companyCooldownDays: 5 } })
    const later = await submitRun(clicked, { submit: async () => ok() })
    expect(later.submitted).toBe(1)
  })

  it('lets a company have perCompanyLimit applications inside the cooldown', async () => {
    const env = await readyEnv({ preferences: { companyCooldownDays: 90, perCompanyLimit: 2 }, autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
    // One application went out five days ago, so one more fits and a third does not.
    const old = env.addReady({ company: 'Acme', externalId: 'old' })
    env.ctx.applications.update(old, { status: 'submitted', submittedAt: daysAgo(5) })
    env.addReady({ company: 'Acme', externalId: 'a2', url: 'https://acme.example/jobs/2' })
    env.addReady({ company: 'Acme, Inc.', externalId: 'a3', url: 'https://acme.example/jobs/3' })
    env.addReady({ company: 'Globex', externalId: 'g1' })
    const sent: string[] = []
    const stats = await submitRun(env, {
      submit: async (id) => {
        sent.push(id)
        return ok()
      }
    })
    // Acme: the old one and one new. Globex: one.
    expect(stats.submitted).toBe(2)
    expect(sent).toHaveLength(2)
    expect(env.ctx.events.list({ limit: 20, types: ['submitted'] }).some((e) => /Left 1 application for later/.test(e.message))).toBe(true)
  })

  it('counts a Submit click with no confirmation toward perCompanyLimit', async () => {
    const env = await readyEnv({ preferences: { companyCooldownDays: 90, perCompanyLimit: 2 }, autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
    const a = env.addReady({ company: 'Initech', externalId: 'i1' })
    const b = env.addReady({ company: 'Initech', externalId: 'i2', url: 'https://initech.example/2' })
    env.ctx.applications.update(a, { status: 'needs_attention', submitClickedAt: daysAgo(2) })
    env.ctx.applications.update(b, { status: 'needs_attention', submitClickedAt: daysAgo(1) })
    env.addReady({ company: 'Initech', externalId: 'i3', url: 'https://initech.example/3' })
    const none = await submitRun(env, { submit: async () => ok() })
    expect(none.submitted).toBe(0)
  })

  it('sends a company twice in one run when the cooldown is off, but never one form twice', async () => {
    const env = await readyEnv({ preferences: { companyCooldownDays: 0 }, autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
    env.addReady({ company: 'Acme', externalId: 'a1', url: 'https://acme.example/jobs/1' })
    env.addReady({ company: 'Acme', externalId: 'a2', url: 'https://acme.example/jobs/2' })
    // The same form behind two postings: the address differs by case, query and a trailing slash.
    env.addReady({ company: 'Globex', externalId: 'g1', url: 'https://jobs.example/Apply/7?utm=a' })
    env.addReady({ company: 'Hooli', externalId: 'h1', url: 'https://jobs.example/apply/7/?ref=b' })
    const stats = await submitRun(env, {
      submit: async (id) => {
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    expect(stats.submitted).toBe(3)
  })

  it('skips an application whose form was already sent from another job', async () => {
    const env = await readyEnv()
    const sent = env.addReady({ company: 'Globex', externalId: 'g1', url: 'https://jobs.example/apply/9' })
    env.ctx.applications.update(sent, { status: 'submitted' })
    env.addReady({ company: 'Hooli', externalId: 'h1', url: 'https://jobs.example/apply/9?x=1' })
    const calls: string[] = []
    const stats = await submitRun(env, {
      submit: async (id) => {
        calls.push(id)
        return ok()
      }
    })
    expect(calls).toHaveLength(0)
    expect(stats.submitted).toBe(0)
  })

  it('leaves out applications autopilot already dry-ran while dry run is on, and takes them again when it is off', async () => {
    const env = await readyEnv({ autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10, dryRun: true } })
    const done = env.addReady({ company: 'Done' })
    const fresh = env.addReady({ company: 'Fresh' })
    env.ctx.applications.update(done, { dryRunAt: daysAgo(0) })
    const tried: string[] = []
    const hooks = {
      submit: async (id: string) => {
        tried.push(id)
        return ok()
      }
    }
    await submitRun(env, hooks)
    expect(tried).toEqual([fresh])
    env.ctx.settings.update({ autopilot: { dryRun: false } })
    await submitRun(env, hooks)
    expect(tried).toContain(done)
  })

  it('marks an application that timed out as needs attention and moves on', async () => {
    const env = await readyEnv()
    const slow = env.addReady({ company: 'Slow' })
    env.addReady({ company: 'Quick' })
    const stats = await submitRun(
      env,
      {
        submit: async (id) => {
          // A late Submit click checks for this status, so it would be refused.
          env.ctx.applications.update(id, { status: 'submitting', submitMode: 'auto' })
          if (id === slow) await new Promise(() => {})
          env.ctx.applications.update(id, { status: 'submitted' })
          return ok()
        }
      },
      { prepareMs: 1000, submitMs: 30 }
    )
    expect(env.ctx.applications.get(slow)).toMatchObject({ status: 'needs_attention', error: 'Timed out while filling the form.' })
    expect(stats.submitted).toBe(1)
    expect(stats.errors).toBe(1)
  })
})

describe('Pipeline unattended preparing', () => {
  const FIT = { score: 90, bucket: 'perfect' as const, summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }

  async function shortlistedEnv(count: number) {
    const env = await makeTestEnv()
    env.ctx.settings.update({ autopilot: { autoPrepare: true }, budget: { maxPreparePerRun: 20 } })
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: `s${i}`, company: `Co${i}` }), null)
      env.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
      ids.push(job.id)
    }
    return { ...env, ids }
  }
  const prepareRun = (env: TestEnv, hooks: PipelineHooks, limits?: { prepareMs: number; submitMs: number }) =>
    new Pipeline(env.ctx, hooks, () => [], limits).run({ discover: false, triage: false, prepare: true })

  it('stops after three provider errors in a row with one error event', async () => {
    const env = await shortlistedEnv(6)
    let calls = 0
    const stats = await prepareRun(env, {
      prepare: async () => {
        calls += 1
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      }
    })
    expect(calls).toBe(3)
    expect(stats.errors).toBe(3)
    const stop = env.ctx.events.list({ limit: 20, types: ['error'] }).filter((e) => /^Preparing stopped after 3 errors in a row/.test(e.message))
    expect(stop).toHaveLength(1)
  })

  it('counts only errors in a row, and a refusal from the model breaks the row', async () => {
    const env = await shortlistedEnv(8)
    let calls = 0
    await prepareRun(env, {
      prepare: async () => {
        calls += 1
        // Two provider errors, then an unreadable reply, then two more, then a success. None of this is three in a row.
        if (calls === 3) throw new LlmFormatError('not JSON', '')
        if (calls === 6) return
        throw new Error('HTTP 503')
      }
    })
    expect(calls).toBe(8)
  })

  it('stops preparing for a rate limit without counting errors', async () => {
    const env = await shortlistedEnv(4)
    const stats = await prepareRun(env, { prepare: async () => Promise.reject(new RateLimitedError('Too many requests.')) })
    expect(stats).toMatchObject({ stoppedForRateLimit: true, errors: 0 })
  })

  it('logs a prepare that runs past its limit and carries on', async () => {
    const env = await shortlistedEnv(3)
    const seen: string[] = []
    const stats = await prepareRun(
      env,
      {
        prepare: async (jobId) => {
          seen.push(jobId)
          if (seen.length === 1) await new Promise(() => {})
        }
      },
      { prepareMs: 30, submitMs: 1000 }
    )
    expect(seen).toHaveLength(3)
    expect(stats.prepared).toBe(2)
    expect(stats.errors).toBe(1)
    expect(env.ctx.events.list({ limit: 20, types: ['error'] }).some((e) => /took more than/.test(e.message))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Company boards: checked when due, read only when they changed
// ---------------------------------------------------------------------------

describe('Pipeline board discovery', () => {
  const GH = 'https://boards-api.greenhouse.io/v1/boards'
  const MINUTE = 60_000

  /** A clock that moves when something waits, so request pacing takes no real time. */
  function instantHttp() {
    let time = Date.now()
    setHttpClock({
      now: () => time,
      sleep: async (ms) => {
        time += ms
      }
    })
  }

  afterEach(() => {
    setHttpClock()
    vi.unstubAllGlobals()
  })

  async function boardEnv() {
    instantHttp()
    const env = await makeTestEnv({ provider: false })
    env.ctx.profile.save(makeProfile({ skills: ['TypeScript', 'React'] }))
    return env
  }

  function watchBoard(env: TestEnv, name: string, token = name.toLowerCase()) {
    const company = env.ctx.companies.save({ name, ats: 'greenhouse', atsToken: token, watch: true })
    env.ctx.boards.ensureState(company.id)
    return company
  }

  const makeDue = (env: TestEnv) => env.ctx.db.run("UPDATE board_state SET next_check_at = '2000-01-01T00:00:00.000Z'")

  function ghJob(id: number, title = `Software Engineer ${id}`) {
    return {
      id,
      title,
      absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
      location: { name: 'Remote' },
      updated_at: '2026-10-29T10:42:09-04:00',
      first_published: '2026-10-01T10:42:09-04:00'
    }
  }

  /** Stands in for Greenhouse. The list carries an ETag and a conditional request gets a 304. */
  function fakeGreenhouse(boards: Record<string, number[]>) {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: { headers?: Record<string, string> }) => {
      const url = String(input)
      calls.push(url)
      const match = /\/boards\/([^/]+)\/jobs(?:\/(\d+))?(\?content=true)?$/.exec(url)
      if (!match || !(match[1] in boards)) return new Response('not found', { status: 404 })
      const [, token, jobId] = match
      if (jobId) return new Response(JSON.stringify({ ...ghJob(Number(jobId)), content: `&lt;p&gt;Build web apps in TypeScript and React. Posting ${jobId}.&lt;/p&gt;` }), { status: 200 })
      const etag = `W/"${token}-${boards[token].join(',')}"`
      if (init?.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304 })
      return new Response(JSON.stringify({ jobs: boards[token].map((id) => ghJob(id)) }), { status: 200, headers: { etag } })
    })
    return { calls }
  }

  it('reads a new board with one list and one request for each new posting, then asks again with the ETag', async () => {
    const env = await boardEnv()
    const company = watchBoard(env, 'Acme')
    const gh = fakeGreenhouse({ acme: [1, 2] })
    const pipeline = new Pipeline(env.ctx, {}, defaultTasks)

    const first = await pipeline.run({ triage: false })
    expect(first).toMatchObject({ discovered: 2, newJobs: 2, errors: 0 })
    expect(gh.calls).toEqual([`${GH}/acme/jobs`, `${GH}/acme/jobs/1`, `${GH}/acme/jobs/2`])
    const state = env.ctx.boards.get(company.id)!
    expect(state.etag).toMatch(/^W\//)
    expect(state.lastStatus).toBe(200)
    expect(state.liveJobs).toBe(2)

    gh.calls.length = 0
    makeDue(env)
    const second = await pipeline.run({ triage: false })
    // The list is the same, so the board answers 304 and no posting is read again.
    expect(gh.calls).toEqual([`${GH}/acme/jobs`])
    expect(second).toMatchObject({ discovered: 0, newJobs: 0, errors: 0 })
    expect(env.ctx.boards.get(company.id)).toMatchObject({ lastStatus: 304, failures: 0 })
  })

  it("a 304 closes nothing and counts the board's postings as seen", async () => {
    const env = await boardEnv()
    const company = watchBoard(env, 'Acme')
    const gh = fakeGreenhouse({ acme: [1, 2] })
    const pipeline = new Pipeline(env.ctx, {}, defaultTasks)
    await pipeline.run({ triage: false })
    // Pretend the postings were last seen long ago.
    env.ctx.db.run("UPDATE jobs SET last_seen_at = '2026-01-01T00:00:00.000Z'")
    makeDue(env)
    gh.calls.length = 0
    await pipeline.run({ triage: false })
    const jobs = env.ctx.db.all<{ stage: string; last_seen_at: string }>('SELECT stage, last_seen_at FROM jobs')
    expect(jobs).toHaveLength(2)
    expect(jobs.every((j) => j.stage !== 'closed')).toBe(true)
    expect(jobs.every((j) => j.last_seen_at > '2026-06-01')).toBe(true)
    expect(env.ctx.boards.get(company.id)!.lastStatus).toBe(304)
  })

  it('closes a posting that left the board when the list changed, and keeps the ones that stayed', async () => {
    const env = await boardEnv()
    watchBoard(env, 'Acme')
    const boards: Record<string, number[]> = { acme: [1, 2, 3] }
    const gh = fakeGreenhouse(boards)
    const pipeline = new Pipeline(env.ctx, {}, defaultTasks)
    await pipeline.run({ triage: false })
    boards.acme = [1, 3]
    makeDue(env)
    gh.calls.length = 0
    await pipeline.run({ triage: false })
    // The list changed and nothing new was listed, so there are no detail requests.
    expect(gh.calls).toEqual([`${GH}/acme/jobs`])
    const stages = Object.fromEntries(env.ctx.db.all<{ external_id: string; stage: string }>('SELECT external_id, stage FROM jobs').map((r) => [r.external_id, r.stage]))
    expect(stages['2']).toBe('closed')
    expect(stages['1']).not.toBe('closed')
    expect(stages['3']).not.toBe('closed')
  })

  it('makes one request for each of a thousand unchanged boards', async () => {
    const env = await boardEnv()
    const calls: string[] = []
    for (let i = 0; i < 1000; i++) {
      const company = watchBoard(env, `Board ${i}`, `board${i}`)
      env.ctx.boards.recordCheck(company.id, { status: 200, etag: 'W/"same"' })
    }
    makeDue(env)
    vi.stubGlobal('fetch', async (input: string | URL) => {
      calls.push(String(input))
      return new Response(null, { status: 304 })
    })
    env.ctx.settings.update({ discovery: { boardsPerRun: 5000 } })
    const stats = await new Pipeline(env.ctx, {}, defaultTasks).run({ triage: false })
    expect(calls).toHaveLength(1000)
    expect(calls.every((c) => c.endsWith('/jobs'))).toBe(true)
    expect(stats).toMatchObject({ discovered: 0, errors: 0 })
    expect(env.ctx.boards.due(new Date().toISOString(), 10)).toEqual([])
  })

  it('takes at most boardsPerRun boards, the longest-waiting first, and every board with allBoards', async () => {
    const env = await boardEnv()
    for (const [i, name] of ['A', 'B', 'C'].entries()) {
      const company = watchBoard(env, name)
      env.ctx.db.run('UPDATE board_state SET next_check_at = :at WHERE company_id = :id', { id: company.id, at: `2000-01-0${i + 1}T00:00:00.000Z` })
    }
    const notDue = watchBoard(env, 'D')
    env.ctx.db.run('UPDATE board_state SET next_check_at = :at WHERE company_id = :id', { id: notDue.id, at: '2999-01-01T00:00:00.000Z' })
    env.ctx.settings.update({ discovery: { boardsPerRun: 2 } })
    expect(defaultTasks(env.ctx).map((t) => t.name)).toEqual(['A', 'B'])
    expect(defaultTasks(env.ctx, { allBoards: true }).map((t) => t.name)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('shows how many boards were checked and how many were unchanged', async () => {
    const env = await boardEnv()
    for (const name of ['A', 'B', 'C']) {
      const company = watchBoard(env, name)
      env.ctx.boards.recordCheck(company.id, { status: 200, etag: 'W/"same"' })
    }
    makeDue(env)
    vi.stubGlobal('fetch', async () => new Response(null, { status: 304 }))
    await new Pipeline(env.ctx, {}, defaultTasks).run({ triage: false })
    const messages = env.pushed.filter((p) => p.channel === 'pipeline:progress').map((p) => (p.payload as { message: string }).message)
    expect(messages).toContain('Checking 3 boards')
    expect(messages).toContain('Checked 3 of 3 boards, 3 unchanged')
  })

  /** A task for a watched board that does not touch the network. */
  function boardTask(env: TestEnv, name: string, host: string | undefined, run: DiscoveryTask['run']): DiscoveryTask {
    const company = env.ctx.companies.findByName(name)!
    return { name, host, board: { source: 'greenhouse', atsToken: company.atsToken!, companyId: company.id }, run }
  }

  it('skips a board whose host is paused and leaves it due', async () => {
    const env = await boardEnv()
    const company = watchBoard(env, 'Acme')
    // Two 429s from one host pause it.
    vi.stubGlobal('fetch', async () => new Response('slow down', { status: 429 }))
    await expect(fetchJson('https://slow.example/a')).rejects.toBeInstanceOf(HttpError)
    expect(hostPauseUntil('slow.example')).not.toBeNull()
    let ran = 0
    const free = vi.fn(async () => ({ jobs: [], unchanged: true }))
    const pipeline = new Pipeline(env.ctx, {}, () => [
      boardTask(env, 'Acme', 'slow.example', async () => {
        ran += 1
        return { jobs: [] }
      }),
      { name: 'Other', host: 'fine.example', run: free }
    ])
    const before = env.ctx.boards.get(company.id)!.nextCheckAt
    await pipeline.run({ triage: false })
    expect(ran).toBe(0)
    expect(free).toHaveBeenCalledTimes(1)
    expect(env.ctx.boards.get(company.id)!.nextCheckAt).toBe(before)
    expect(env.ctx.events.list({ limit: 30 }).some((e) => /Left 1 board for a later run/.test(e.message))).toBe(true)
  })

  it('puts a board off without a failure when its host answers 429', async () => {
    const env = await boardEnv()
    const company = watchBoard(env, 'Acme')
    const retryAt = Date.now() + 40 * MINUTE
    const pipeline = new Pipeline(env.ctx, {}, () => [
      boardTask(env, 'Acme', 'x.example', async () => {
        throw new HttpError('x.example answered 429', 429, 'https://x.example/', retryAt)
      })
    ])
    const stats = await pipeline.run({ triage: false })
    expect(stats.errors).toBe(0)
    const state = env.ctx.boards.get(company.id)!
    expect(state).toMatchObject({ failures: 0, lastStatus: 429 })
    expect(Date.parse(state.nextCheckAt)).toBeGreaterThanOrEqual(retryAt - 1000)
    expect(env.ctx.events.list({ limit: 30, types: ['error'] })).toEqual([])
  })

  it('counts failures, and stops watching after five in a row with one note', async () => {
    const env = await boardEnv()
    const company = watchBoard(env, 'Acme')
    const pipeline = new Pipeline(env.ctx, {}, () => [
      boardTask(env, 'Acme', 'x.example', async () => {
        throw new HttpError('x.example answered 404', 404, 'https://x.example/')
      })
    ])
    for (let i = 0; i < 5; i++) {
      await pipeline.run({ triage: false })
      makeDue(env)
    }
    expect(env.ctx.companies.get(company.id)!.watch).toBe(false)
    expect(env.ctx.boards.get(company.id)).toMatchObject({ failures: 5, lastStatus: 404 })
    const notes = env.ctx.events.list({ limit: 50, types: ['error'] }).filter((e) => e.message.startsWith('Stopped watching'))
    expect(notes.map((e) => e.message)).toEqual(['Stopped watching Acme: x.example answered 404'])
  })

  it('runs six tasks at once and one at a time for a host', async () => {
    const env = await boardEnv()
    const names = Array.from({ length: 24 }, (_, i) => `Co${i}`)
    names.forEach((n) => watchBoard(env, n))
    let inflight = 0
    let peak = 0
    const perHost = new Map<string, number>()
    let peakPerHost = 0
    const pipeline = new Pipeline(env.ctx, {}, () =>
      names.map((n, i) => {
        const host = `host${i % 8}.example`
        return boardTask(env, n, host, async () => {
          inflight += 1
          perHost.set(host, (perHost.get(host) ?? 0) + 1)
          peak = Math.max(peak, inflight)
          peakPerHost = Math.max(peakPerHost, perHost.get(host)!)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inflight -= 1
          perHost.set(host, perHost.get(host)! - 1)
          return { jobs: [], unchanged: true }
        })
      })
    )
    await pipeline.run({ triage: false })
    expect(peak).toBe(6)
    expect(peakPerHost).toBe(1)
  })

  it('does not run two tasks for one host together even when the limit allows it', async () => {
    const env = await boardEnv()
    for (const n of ['A', 'B', 'C']) watchBoard(env, n)
    let inflight = 0
    let peak = 0
    const pipeline = new Pipeline(env.ctx, {}, () =>
      ['A', 'B', 'C'].map((n) =>
        boardTask(env, n, 'one.example', async () => {
          inflight += 1
          peak = Math.max(peak, inflight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inflight -= 1
          return { jobs: [], unchanged: true }
        })
      )
    )
    await pipeline.run({ triage: false })
    expect(peak).toBe(1)
  })

  it('starts watching a board a posting links to and says so once', async () => {
    const env = await boardEnv()
    const pipeline = new Pipeline(env.ctx, {}, () => [
      fakeTask(() => [
        makeRaw({ source: 'remotive', externalId: 'r1', company: 'Linked One', ats: 'greenhouse', atsToken: 'linkedone', description: 'Build things. TypeScript.' }),
        makeRaw({ source: 'hn_whoishiring', externalId: 'h1', company: 'Linked Two', ats: 'unknown', description: 'Apply at https://jobs.lever.co/linkedtwo/abc or email us.' }),
        makeRaw({ source: 'remotive', externalId: 'r2', company: 'No Link', description: 'No board here.' })
      ])
    ])
    await pipeline.run({ triage: false })
    expect(env.ctx.companies.list().map((c) => [c.name, c.watch, c.origin])).toEqual([
      ['Linked One', true, 'posting_link'],
      ['Linked Two', true, 'posting_link']
    ])
    const notes = env.ctx.events.list({ limit: 50 }).filter((e) => e.message.startsWith('Started watching'))
    expect(notes.map((e) => e.message)).toEqual(['Started watching 2 new company boards found in postings.'])
    expect(env.ctx.boards.due(new Date().toISOString(), 10).map((d) => d.company.name).sort()).toEqual(['Linked One', 'Linked Two'])
  })
})

// ---------------------------------------------------------------------------
// Steps, as the work loop uses them
// ---------------------------------------------------------------------------

describe('Pipeline steps', () => {
  const FIT = { score: 90, bucket: 'perfect' as const, summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }
  const ctrl = () => new AbortController().signal

  async function shortlisted(count: number) {
    const env = await makeTestEnv()
    env.ctx.settings.update({ autopilot: { autoPrepare: true } })
    for (let i = 0; i < count; i++) {
      const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: `s${i}`, company: `Co${i}` }), null)
      env.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    }
    return env
  }

  it('prepares with the concurrency it is given, and takes no more than the limit', async () => {
    const env = await shortlisted(5)
    let open = 0
    let most = 0
    const calls: string[] = []
    const pipeline = new Pipeline(env.ctx, {
      prepare: async (jobId) => {
        calls.push(jobId)
        open += 1
        most = Math.max(most, open)
        await new Promise((resolve) => setTimeout(resolve, 10))
        open -= 1
      }
    })
    const result = await pipeline.prepareStep(4, 2, ctrl())
    expect(result.did).toBe(4)
    expect(result.stats.prepared).toBe(4)
    expect(calls).toHaveLength(4)
    expect(most).toBe(2)
    expect(result.pause).toBeNull()
  })

  it('returns a pause hint when prepare hits a budget, a rate limit, a missing model or repeated provider errors', async () => {
    const midnight = new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
    const cases: Array<[Error, string, string | null]> = [
      [new BudgetExceededError('Budget used up.'), 'budget', midnight],
      [new OutOfCreditsError(), 'budget', midnight],
      [new RateLimitedError('Too many.'), 'rate_limit', midnight],
      [new NoModelConfiguredError(), 'no_model', null]
    ]
    for (const [error, kind, until] of cases) {
      const env = await shortlisted(3)
      let calls = 0
      const pipeline = new Pipeline(env.ctx, {
        prepare: async () => {
          calls += 1
          throw error
        }
      })
      const result = await pipeline.prepareStep(3, 1, ctrl())
      expect(result.pause?.kind, kind).toBe(kind)
      expect(result.pause?.until ?? null, kind).toBe(until)
      expect(calls, kind).toBe(1)
    }
    const env = await shortlisted(6)
    const pipeline = new Pipeline(env.ctx, { prepare: async () => Promise.reject(new Error('connect ECONNREFUSED')) })
    // Errors are counted across steps, so two small steps still make three in a row.
    expect((await pipeline.prepareStep(2, 1, ctrl())).pause).toBeNull()
    const third = await pipeline.prepareStep(2, 1, ctrl())
    expect(third.pause?.kind).toBe('provider_errors')
    expect(Date.parse(third.pause!.until!) - Date.now()).toBeGreaterThan(14 * 60_000)
  })

  it('asks to wait as long as the provider said when a prepare is rate limited', async () => {
    const env = await shortlisted(2)
    const pipeline = new Pipeline(env.ctx, { prepare: async () => Promise.reject(new RateLimitedError('Slow down.', 120_000)) })
    const result = await pipeline.prepareStep(2, 1, ctrl())
    const wait = Date.parse(result.pause!.until!) - Date.now()
    expect(wait).toBeGreaterThan(110_000)
    expect(wait).toBeLessThanOrEqual(120_000)
  })

  it('returns a budget pause from the score step for a paid model and none for a free one', async () => {
    const jobs = () => Array.from({ length: 3 }, (_, i) => makeRaw({ externalId: `j${i}`, title: 'Software Engineer', description: `${TS_DESCRIPTION} Variant ${i}.` }))
    const env = await setup(jobs)
    await env.pipeline.run({ triage: false })
    env.ctx.settings.update({ budget: { dailyUsd: 0.0004 } })
    env.ctx.db.run("INSERT INTO llm_calls (id, at, task, stage, provider_kind, model, cost_usd) VALUES ('spent', :at, 'x', 'writing', 'anthropic', 'm', 5)", { at: new Date().toISOString() })
    const paid = await env.pipeline.scoreStep(10, ctrl())
    expect(paid.pause?.kind).toBe('budget')
    expect(paid.stats.stoppedForBudget).toBe(true)
    expect(paid.did).toBe(0)

    const free = await env.ctx.providers.save({ kind: 'gemini', label: 'Gemini', apiKey: 'k', billing: 'free' })
    env.ctx.settings.update({ routing: { triage: { providerId: free.id, model: 'gemini-2.5-flash' } } })
    const cheap = await env.pipeline.scoreStep(10, ctrl())
    expect(cheap.pause).toBeNull()
    expect(cheap.did).toBe(3)
  })

  it('returns pause hints from the score step for a rate limit and a missing model', async () => {
    const jobs = () => Array.from({ length: 3 }, (_, i) => makeRaw({ externalId: `j${i}`, title: 'Software Engineer', description: `${TS_DESCRIPTION} Variant ${i}.` }))
    const limited = await setup(jobs, { fail: () => new RateLimitedError('Slow down.', 600_000) })
    await limited.pipeline.run({ triage: false })
    const hit = await limited.pipeline.scoreStep(10, ctrl())
    expect(hit.pause?.kind).toBe('rate_limit')
    expect(Date.parse(hit.pause!.until!) - Date.now()).toBeGreaterThan(590_000)

    const bare = await setup(jobs, { provider: false })
    await bare.pipeline.run({ triage: false })
    const none = await bare.pipeline.scoreStep(10, ctrl())
    expect(none.pause).toMatchObject({ kind: 'no_model', until: null })
  })

  it('returns a provider-errors pause from the score step after three errors', async () => {
    const jobs = () => Array.from({ length: 6 }, (_, i) => makeRaw({ externalId: `j${i}`, title: 'Software Engineer', description: `${TS_DESCRIPTION} Variant ${i}.` }))
    const env = await setup(jobs, { fail: () => new Error('connect ECONNREFUSED 127.0.0.1:11434') })
    await env.pipeline.run({ triage: false })
    const result = await env.pipeline.scoreStep(6, ctrl())
    expect(result.pause?.kind).toBe('provider_errors')
    expect(result.did).toBe(0)
  })

  it('leaves out the form families it is told to skip', async () => {
    const env = await makeTestEnv()
    env.ctx.settings.update({ autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 }, thresholds: { autoSubmitScore: 85 } })
    const ready = (company: string, ats: 'lever' | 'ashby') => {
      const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: company, company, ats, url: `https://${ats}.example/${company}` }), null)
      env.ctx.jobs.saveFit(job.id, { ...FIT, score: 95 }, 1, 'shortlisted')
      const app = env.ctx.applications.create(job.id)
      env.ctx.applications.update(app.id, { status: 'ready' })
      return app.id
    }
    const lever = ready('L', 'lever')
    const ashby = ready('A', 'ashby')
    const tried: string[] = []
    const pipeline = new Pipeline(env.ctx, {
      submit: async (id) => {
        tried.push(id)
        env.ctx.applications.update(id, { status: 'submitted' })
        return { ok: true, status: 'submitted', message: 'Sent.', screenshotPath: null }
      }
    })
    const result = await pipeline.submitStep(5, ctrl(), { skipFamilies: new Set(['lever']), loop: true })
    expect(tried).toEqual([ashby])
    expect(result.attempts).toEqual([{ applicationId: ashby, jobId: expect.any(String), family: 'ashby', result: 'sent' }])
    expect(env.ctx.applications.get(lever)?.status).toBe('ready')
  })
})
