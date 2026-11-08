import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AtsKind, RawJob, SubmitResult } from '@shared/types'
import { BudgetExceededError, RateLimitedError } from '../llm/errors'
import type { DiscoveryTask } from '../sources'
import { type TestEnv, makeProfile, makeRaw, makeTestEnv } from '../testing'
import { WorkLoop } from './loop'
import { type PipelineHooks, Pipeline } from './orchestrator'

const MIN = 60_000
const HOUR = 3_600_000
const TS_DESCRIPTION = 'Build web apps in TypeScript and React with a small team.'
const FIT = { score: 95, bucket: 'perfect' as const, summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }
const ok = (): SubmitResult => ({ ok: true, status: 'submitted', message: 'Sent.', screenshotPath: null })
const captcha = (): SubmitResult => ({ ok: false, status: 'needs_attention', message: 'The site asked for a captcha. Solve it in the browser window and press submit.', screenshotPath: null })
/** 10:00 on a Saturday, local time, so hours and midnight are the same in every test. */
const TEN = () => new Date(2026, 10, 7, 10, 0, 0)

afterEach(() => {
  vi.useRealTimers()
})

async function setup(options: Parameters<typeof makeTestEnv>[0] = {}, jobs: () => RawJob[] = () => []) {
  const env = await makeTestEnv(options)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(TEN())
  env.ctx.profile.save(makeProfile({ skills: ['TypeScript', 'React'] }))
  env.ctx.settings.update({
    preferences: { targetTitles: ['Software Engineer'], remote: ['remote'] },
    thresholds: { prescoreMin: 30 },
    autopilot: { enabled: true, mode: 'continuous', autoPrepare: true, autoSubmit: true },
    budget: { maxTriagePerDay: 1000, maxPreparePerDay: 1000 }
  })
  const task: DiscoveryTask = { name: 'Fake source', run: async () => ({ jobs: jobs() }) }
  const discoveries = { runs: 0 }
  const counted: DiscoveryTask = {
    ...task,
    run: async (signal) => {
      discoveries.runs += 1
      return task.run(signal)
    }
  }
  const make = (hooks: PipelineHooks) => {
    const pipeline = new Pipeline(env.ctx, hooks, () => [counted])
    const loop = new WorkLoop(env.ctx, pipeline)
    return { pipeline, loop }
  }
  /** A shortlisted job with no application yet. */
  const addShortlisted = (company: string, score = 90) => {
    const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: `s-${company}`, company }), null)
    env.ctx.jobs.saveFit(job.id, { ...FIT, score }, 1, 'shortlisted')
    return job.id
  }
  /** A ready application. */
  const addReady = (company: string, ats: AtsKind = 'greenhouse', score = 95) => {
    const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: `r-${company}`, company, ats, url: `https://${ats}.example/${company}` }), null)
    env.ctx.jobs.saveFit(job.id, { ...FIT, score }, 1, 'shortlisted')
    const app = env.ctx.applications.create(job.id)
    env.ctx.applications.update(app.id, { status: 'ready' })
    return app.id
  }
  const prepareHook = (done: string[] = []): NonNullable<PipelineHooks['prepare']> => async (jobId) => {
    done.push(jobId)
    const app = env.ctx.applications.create(jobId)
    env.ctx.applications.update(app.id, { status: 'ready' })
  }
  const submitHook = (sent: string[] = []): NonNullable<PipelineHooks['submit']> => async (id) => {
    sent.push(id)
    env.ctx.applications.update(id, { status: 'submitted' })
    return ok()
  }
  return { ...env, make, addShortlisted, addReady, prepareHook, submitHook, discoveries }
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const loopRuns = (env: TestEnv) => env.ctx.runs.list(20).filter((r) => r.trigger === 'loop')
const sampleJobs = (count: number) => (): RawJob[] =>
  Array.from({ length: count }, (_, i) => makeRaw({ externalId: `j${i}`, title: 'Software Engineer', description: `${TS_DESCRIPTION} Variant ${i}.` }))

describe('WorkLoop', () => {
  it('lets prepare run while a slow submit is still going', async () => {
    const env = await setup()
    const first = env.addReady('Slow Co')
    env.addShortlisted('Alpha')
    env.addShortlisted('Beta')
    const prepared: string[] = []
    const gate = { release: () => {} }
    const submitting: string[] = []
    const { loop } = env.make({
      prepare: env.prepareHook(prepared),
      submit: async (id) => {
        submitting.push(id)
        // Only the first send is slow.
        if (submitting.length === 1) await new Promise<void>((resolve) => (gate.release = resolve))
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    loop.start()
    await advance(5_000)
    // The submit hook has not returned, and both jobs were prepared anyway.
    expect(submitting).toEqual([first])
    expect(prepared).toHaveLength(2)
    expect(loop.status().workers.submit.state).toBe('working')
    expect(loop.status().workers.prepare.state).not.toBe('working')
    gate.release()
    await advance(5_000)
    expect(submitting).toHaveLength(3)
    await loop.stop()
  })

  it('pauses score and prepare for a rate limit, and leaves discover going', async () => {
    let limited = true
    const env = await setup(
      { fail: () => (limited ? new RateLimitedError('The provider said it received too many requests.') : null) },
      sampleJobs(3)
    )
    env.addShortlisted('Alpha')
    const { loop, pipeline } = env.make({
      prepare: async () => {
        throw new RateLimitedError('The provider said it received too many requests.')
      },
      submit: env.submitHook()
    })
    loop.start()
    await advance(3 * MIN)
    expect(pipeline.status().message).toMatch(/scoring paused until Sun 00:00/)
    expect(pipeline.status().message).toMatch(/preparing paused until Sun 00:00/)
    const status = loop.status()
    const midnight = new Date(2026, 10, 8, 0, 0, 0).toISOString()
    expect(status.workers.score).toMatchObject({ state: 'paused', until: midnight })
    expect(status.workers.prepare).toMatchObject({ state: 'paused', until: midnight })
    expect(status.workers.discover.state).not.toBe('paused')
    // Discover keeps reading boards once a minute while the AI workers wait.
    expect(env.discoveries.runs).toBeGreaterThanOrEqual(3)
    expect(env.ctx.events.list({ limit: 50, types: ['rate_limit_stop'] })).toHaveLength(1)

    // The pause ends at midnight, and the workers try again.
    limited = false
    const callsBefore = env.llmCalls.length
    await advance(14 * HOUR + MIN)
    expect(env.llmCalls.length).toBeGreaterThan(callsBefore)
    expect(loop.status().workers.score.state).not.toBe('paused')
    await loop.stop()
  })

  it('waits as long as the provider asked when it said how long', async () => {
    // Longer than the 5 minutes the AI service will sit out itself.
    const env = await setup({ fail: () => new RateLimitedError('Slow down.', 10 * MIN) }, sampleJobs(2))
    const { loop } = env.make({})
    loop.start()
    await advance(5_000)
    const until = loop.status().workers.score.until
    expect(Date.parse(until!) - Date.now()).toBeGreaterThan(9 * MIN)
    expect(Date.parse(until!) - Date.now()).toBeLessThanOrEqual(10 * MIN)
    await loop.stop()
  })

  it('pauses a paid stage for a spent budget while a free stage keeps scoring', async () => {
    const env = await setup({}, sampleJobs(3))
    // Today's budget is used up.
    env.ctx.settings.update({ budget: { dailyUsd: 0.01 } })
    env.ctx.db.run("INSERT INTO llm_calls (id, at, task, stage, provider_kind, model, cost_usd) VALUES ('spent', :at, 'cover_letter', 'writing', 'anthropic', 'm', 5)", { at: new Date().toISOString() })
    // Scoring runs on a free model. Writing stays on the paid one and stops.
    const free = await env.ctx.providers.save({ kind: 'gemini', label: 'Gemini', apiKey: 'k', billing: 'free' })
    env.ctx.settings.update({ routing: { triage: { providerId: free.id, model: 'gemini-2.5-flash' } } })
    env.addShortlisted('Alpha')
    const { loop } = env.make({
      prepare: async () => {
        throw new BudgetExceededError("Today's AI budget of $0.01 is used up.")
      },
      submit: env.submitHook()
    })
    loop.start()
    await advance(2 * MIN)
    const status = loop.status()
    expect(status.workers.prepare.state).toBe('paused')
    expect(status.workers.prepare.until).toBe(new Date(2026, 10, 8, 0, 0, 0).toISOString())
    expect(status.workers.score.state).not.toBe('paused')
    expect(status.today.scored).toBeGreaterThan(0)
    expect(env.ctx.jobs.listByStage(['new'])).toHaveLength(0)
    await loop.stop()
  })

  it('pauses scoring too when the scoring model is paid and the budget is spent', async () => {
    const env = await setup({}, sampleJobs(3))
    env.ctx.settings.update({ budget: { dailyUsd: 0.01 } })
    env.ctx.db.run("INSERT INTO llm_calls (id, at, task, stage, provider_kind, model, cost_usd) VALUES ('spent', :at, 'cover_letter', 'writing', 'anthropic', 'm', 5)", { at: new Date().toISOString() })
    const { loop } = env.make({})
    loop.start()
    await advance(2 * MIN)
    expect(loop.status().workers.score).toMatchObject({ state: 'paused' })
    expect(loop.status().workers.score.reason).toMatch(/budget/i)
    expect(env.llmCalls).toHaveLength(0)
    expect(env.ctx.events.list({ limit: 50, types: ['budget_stop'] })).toHaveLength(1)
    await loop.stop()
  })

  it('stops scoring at the daily scoring cap and waits for midnight', async () => {
    const env = await setup({}, sampleJobs(5))
    env.ctx.settings.update({ budget: { maxTriagePerDay: 2 } })
    const { loop } = env.make({})
    loop.start()
    await advance(3 * MIN)
    expect(env.llmCalls).toHaveLength(2)
    expect(loop.status().workers.score).toMatchObject({ state: 'paused', until: new Date(2026, 10, 8, 0, 0, 0).toISOString() })
    expect(loop.status().workers.score.reason).toMatch(/daily scoring limit of 2/)
    await loop.stop()
  })

  it('waits until settings change when no AI model is set up', async () => {
    const env = await setup({ provider: false }, sampleJobs(2))
    const { loop } = env.make({})
    loop.start()
    await advance(2 * MIN)
    expect(loop.status().workers.score).toMatchObject({ state: 'paused', until: null })
    expect(env.ctx.events.list({ limit: 50, types: ['error'] }).filter((e) => /No AI model/.test(e.message))).toHaveLength(1)
    await env.ctx.providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
    loop.wake()
    await advance(5_000)
    expect(loop.status().workers.score.state).not.toBe('paused')
    expect(env.llmCalls.length).toBeGreaterThan(0)
    await loop.stop()
  })

  it('pauses a worker for 15 minutes after three provider errors in a row', async () => {
    const env = await setup()
    for (const company of ['A', 'B', 'C', 'D', 'E', 'F']) env.addShortlisted(company)
    let calls = 0
    const { loop } = env.make({
      prepare: async () => {
        calls += 1
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      }
    })
    loop.start()
    // Two jobs a step, and a failed step waits 30 seconds, so the third error comes in the second step.
    await advance(45_000)
    expect(calls).toBe(4)
    const status = loop.status().workers.prepare
    expect(status.state).toBe('paused')
    expect(Date.parse(status.until!) - Date.now()).toBeGreaterThan(14 * MIN)
    await advance(16 * MIN)
    expect(calls).toBeGreaterThan(4)
    await loop.stop()
  })

  it('pauses submit when the hourly cap is reached, and the count survives a restart of the loop', async () => {
    const env = await setup()
    env.ctx.settings.update({ autopilot: { hourlySubmitCap: 2, dailySubmitCap: 50 } })
    for (const company of ['A', 'B', 'C', 'D', 'E']) env.addReady(company)
    const sent: string[] = []
    const first = env.make({ submit: env.submitHook(sent) })
    first.loop.start()
    await advance(2 * MIN)
    expect(sent).toHaveLength(2)
    const status = first.loop.status().workers.submit
    expect(status).toMatchObject({ state: 'paused', until: new Date(2026, 10, 7, 11, 0, 0).toISOString() })
    expect(status.reason).toMatch(/hourly limit of 2/)
    await first.loop.stop()

    // A new loop, as after a restart, reads the same count from the database.
    const second = env.make({ submit: env.submitHook(sent) })
    second.loop.start()
    await advance(30 * MIN)
    expect(sent).toHaveLength(2)
    expect(second.loop.status().workers.submit.state).toBe('paused')

    // The hour turns and two more go.
    await advance(31 * MIN)
    expect(sent).toHaveLength(4)
    await second.loop.stop()
  })

  it('stops sending at the daily cap until midnight', async () => {
    const env = await setup()
    env.ctx.settings.update({ autopilot: { dailySubmitCap: 2, hourlySubmitCap: 50 } })
    for (const company of ['A', 'B', 'C']) env.addReady(company)
    const sent: string[] = []
    const { loop } = env.make({ submit: env.submitHook(sent) })
    loop.start()
    await advance(2 * MIN)
    expect(sent).toHaveLength(2)
    expect(loop.status().workers.submit).toMatchObject({ state: 'paused', until: new Date(2026, 10, 8, 0, 0, 0).toISOString() })
    await advance(14 * HOUR + MIN)
    expect(sent).toHaveLength(3)
    await loop.stop()
  })

  it('pauses only lever after three captchas in a row, and ashby still goes', async () => {
    const env = await setup()
    // Lever applications sort first, then ashby.
    const lever = ['L1', 'L2', 'L3', 'L4'].map((c) => env.addReady(c, 'lever', 95))
    const ashby = env.addReady('Ash', 'ashby', 90)
    const tried: string[] = []
    const { loop } = env.make({
      submit: async (id) => {
        tried.push(id)
        if (lever.includes(id)) {
          env.ctx.applications.update(id, { status: 'needs_attention' })
          return captcha()
        }
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    loop.start()
    await advance(5 * MIN)
    expect(tried).toEqual([lever[0], lever[1], lever[2], ashby])
    const events = env.ctx.events.list({ limit: 50, types: ['submit_failed'] }).filter((e) => /paused until/.test(e.message))
    expect(events).toHaveLength(1)
    expect(events[0].message).toMatch(/captcha/)
    expect(loop.status().workers.submit.state).not.toBe('paused')
    expect(loop.status().workers.submit.reason).toMatch(/lever paused until 12:0\d \(captcha\)/)

    // Two hours later the family is open again.
    await advance(2 * HOUR)
    expect(tried).toContain(lever[3])
    await loop.stop()
  })

  it('pauses a family after two sign-in walls in a row', async () => {
    const env = await setup()
    const apps = ['W1', 'W2', 'W3'].map((c) => env.addReady(c, 'workday', 95))
    const tried: string[] = []
    const { loop } = env.make({
      submit: async (id) => {
        tried.push(id)
        env.ctx.applications.update(id, { status: 'needs_attention' })
        return { ok: false, status: 'needs_attention', message: 'This site wants you to sign in first. Sign in in the browser window, then press Fill again.', screenshotPath: null }
      }
    })
    loop.start()
    await advance(5 * MIN)
    expect(tried).toEqual([apps[0], apps[1]])
    expect(env.ctx.events.list({ limit: 50, types: ['submit_failed'] }).filter((e) => /sign in 2 times in a row/.test(e.message))).toHaveLength(1)
    await loop.stop()
  })

  it('holds lever to 15 applications an hour', async () => {
    const env = await setup()
    env.ctx.settings.update({ autopilot: { hourlySubmitCap: 100, dailySubmitCap: 100 } })
    for (let i = 0; i < 20; i++) env.addReady(`Lv${i}`, 'lever', 95)
    env.addReady('Other', 'greenhouse', 90)
    const sent: string[] = []
    const { loop } = env.make({ submit: env.submitHook(sent) })
    loop.start()
    await advance(10 * MIN)
    // 15 lever applications and the one greenhouse application.
    expect(sent).toHaveLength(16)
    await advance(HOUR)
    expect(sent.length).toBeGreaterThan(16)
    await loop.stop()
  })

  it('sends up to the configured number of applications at once', async () => {
    const env = await setup()
    env.ctx.settings.update({ autopilot: { submitConcurrency: 3 } })
    for (const company of ['A', 'B', 'C', 'D']) env.addReady(company)
    let open = 0
    let most = 0
    const releases: Array<() => void> = []
    const { loop } = env.make({
      submit: async (id) => {
        open += 1
        most = Math.max(most, open)
        await new Promise<void>((resolve) => releases.push(resolve))
        open -= 1
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    loop.start()
    await advance(5_000)
    expect(most).toBe(3)
    expect(loop.status().workers.submit.active).toBe(3)
    while (releases.length) releases.shift()!()
    await advance(5_000)
    while (releases.length) releases.shift()!()
    await advance(5_000)
    await loop.stop()
  })

  it('does not send two applications to one company at once', async () => {
    const env = await setup()
    env.ctx.settings.update({ autopilot: { submitConcurrency: 2 } })
    env.addReady('Acme')
    const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: 'r-acme-2', company: 'Acme', url: 'https://greenhouse.example/acme-2' }), null)
    env.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    env.ctx.applications.update(env.ctx.applications.create(job.id).id, { status: 'ready' })
    let open = 0
    let most = 0
    const { loop } = env.make({
      submit: async (id) => {
        open += 1
        most = Math.max(most, open)
        await new Promise((resolve) => setTimeout(resolve, 20_000))
        open -= 1
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    loop.start()
    await advance(2 * MIN)
    expect(most).toBe(1)
    expect(env.ctx.applications.countSubmittedSince(new Date(2026, 10, 7).toISOString())).toBe(1)
    await loop.stop()
  })

  it('ends every worker and leaves no timers when it is stopped', async () => {
    const env = await setup({}, sampleJobs(2))
    env.addReady('A')
    env.addShortlisted('B')
    const calls = { prepare: 0, submit: 0 }
    const { loop, pipeline } = env.make({
      prepare: async (jobId) => {
        calls.prepare += 1
        await env.prepareHook()(jobId)
      },
      submit: async (id) => {
        calls.submit += 1
        return env.submitHook()(id)
      }
    })
    loop.start()
    expect(pipeline.isRunning()).toBe(true)
    await advance(2 * MIN)
    await loop.stop()
    expect(loop.isRunning()).toBe(false)
    expect(pipeline.isRunning()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const before = { ...calls, runs: env.discoveries.runs }
    env.addReady('Later')
    await advance(3 * HOUR)
    expect({ ...calls, runs: env.discoveries.runs }).toEqual(before)
    expect(loop.status()).toMatchObject({ running: false })
    expect(pipeline.status().phase).toBe('idle')
  })

  it('keeps going when a worker fails, and logs the failure once', async () => {
    const env = await setup()
    env.addReady('A')
    const sent: string[] = []
    const { loop, pipeline } = env.make({ submit: env.submitHook(sent) })
    // The discover worker throws on every tick.
    vi.spyOn(pipeline, 'filterStep').mockImplementation(() => {
      throw new Error('The filter blew up.')
    })
    loop.start()
    await advance(8 * MIN)
    expect(loop.isRunning()).toBe(true)
    // One event for the failure, and the other workers did their work.
    expect(env.ctx.events.list({ limit: 50, types: ['error'] }).filter((e) => /blew up/.test(e.message))).toHaveLength(1)
    expect(sent).toHaveLength(1)
    await loop.stop()
  })

  it('writes one run record for each hour with that hour\'s counts', async () => {
    const env = await setup()
    env.ctx.settings.update({ autopilot: { hourlySubmitCap: 1, dailySubmitCap: 50 } })
    for (const company of ['A', 'B', 'C']) env.addReady(company)
    const { loop } = env.make({ submit: env.submitHook() })
    loop.start()
    await advance(5 * MIN)
    let rows = loopRuns(env)
    expect(rows).toHaveLength(1)
    expect(rows[0].stats.submitted).toBe(1)
    expect(rows[0].finishedAt).not.toBeNull()
    await advance(HOUR)
    rows = loopRuns(env)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.stats.submitted)).toEqual([1, 1])
    await loop.stop()
    expect(loopRuns(env)).toHaveLength(2)
  })

  it('pushes the worker status and one progress line for the whole loop', async () => {
    const env = await setup()
    env.addReady('A')
    env.addShortlisted('B')
    const gate = { release: () => {}, first: true }
    const { loop, pipeline } = env.make({
      prepare: env.prepareHook(),
      submit: async (id) => {
        if (gate.first) {
          gate.first = false
          await new Promise<void>((resolve) => (gate.release = resolve))
        }
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    })
    loop.start()
    await advance(5_000)
    expect(pipeline.status().message).toMatch(/^Continuous: .*1 submitting/)
    expect(pipeline.status().phase).not.toBe('idle')
    const pushes = env.pushed.filter((p) => p.channel === 'loop:status')
    expect(pushes.length).toBeGreaterThan(0)
    gate.release()
    await advance(5_000)
    await loop.stop()
    expect(pipeline.status().phase).toBe('idle')
    const last = env.pushed.filter((p) => p.channel === 'loop:status').at(-1)!.payload as { running: boolean }
    expect(last.running).toBe(false)
  })

  it('stops one worker on request and starts it again', async () => {
    const env = await setup()
    env.addReady('A')
    const sent: string[] = []
    const { loop } = env.make({ submit: env.submitHook(sent) })
    loop.pauseWorker('submit')
    loop.start()
    await advance(5 * MIN)
    expect(sent).toHaveLength(0)
    expect(loop.status().workers.submit).toMatchObject({ state: 'paused', reason: 'Paused by you.' })
    loop.resumeWorker('submit')
    await advance(5_000)
    expect(sent).toHaveLength(1)
    await loop.stop()
  })

  it('leaves the prepare and submit workers off while their settings are off', async () => {
    const env = await setup()
    env.ctx.settings.update({ autopilot: { autoPrepare: false, autoSubmit: false } })
    env.addReady('A')
    const sent: string[] = []
    const { loop } = env.make({ submit: env.submitHook(sent) })
    loop.start()
    await advance(5 * MIN)
    expect(sent).toHaveLength(0)
    expect(loop.status().workers.prepare.state).toBe('off')
    expect(loop.status().workers.submit.state).toBe('off')
    env.ctx.settings.update({ autopilot: { autoSubmit: true } })
    loop.wake()
    await advance(5_000)
    expect(sent).toHaveLength(1)
    await loop.stop()
  })

  it('backs off from 30 seconds to 5 minutes when there is nothing to do', async () => {
    const env = await setup()
    let looks = 0
    const { loop } = env.make({
      prepare: async () => undefined,
      submit: async (id) => {
        looks += 1
        return env.submitHook()(id)
      }
    })
    loop.start()
    await advance(20 * MIN)
    // Nothing is ready, so the submit worker is never called, and the loop is still quiet and running.
    expect(looks).toBe(0)
    // A job that turns up is picked up within 5 minutes without any wake.
    env.addReady('Late')
    await advance(5 * MIN + 1000)
    expect(looks).toBe(1)
    await loop.stop()
  })
})
