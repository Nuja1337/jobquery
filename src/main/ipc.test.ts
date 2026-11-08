import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Application, FitAssessment, PreparedAnswer } from '@shared/types'
import type { SubmitRunDeps, SubmitRunResult } from './apply/submitRun'
import { BudgetExceededError, LlmFormatError, LlmRefusalError, RateLimitedError } from './llm/errors'
import { WorkLoop } from './pipeline/loop'

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null }, dialog: {}, shell: {} }))

type RunImpl = (deps: SubmitRunDeps, mode: string, by: string) => Promise<SubmitRunResult>
const mocks = vi.hoisted(() => ({
  run: { impl: null as RunImpl | null, calls: 0 },
  draft: { impl: null as (() => Promise<unknown>) | null, seen: [] as unknown[] },
  read: { impl: null as (() => Promise<unknown>) | null },
  probe: { impl: null as ((ats: string, token: string) => Promise<unknown>) | null, calls: [] as string[] }
}))

vi.mock('./apply/submitRun', () => ({
  runSubmission: (deps: SubmitRunDeps, _job: unknown, _app: unknown, mode: string, by: string) => {
    mocks.run.calls += 1
    return mocks.run.impl!(deps, mode, by)
  }
}))
vi.mock('./apply/prepare', async (importOriginal) => {
  const original = await importOriginal<typeof import('./apply/prepare')>()
  return {
    ...original,
    draftApplication: (_deps: unknown, job: unknown) => {
      mocks.draft.seen.push(job)
      return mocks.draft.impl!()
    },
    readFormForJob: (...args: Parameters<typeof original.readFormForJob>) => (mocks.read.impl ? mocks.read.impl() : original.readFormForJob(...args))
  }
})

vi.mock('./sources/importBoards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sources/importBoards')>()),
  probeBoard: async (ats: string, token: string) => {
    mocks.probe.calls.push(`${ats}:${token}`)
    return mocks.probe.impl!(ats, token)
  }
}))

import { createServices, recordProcessError } from './ipc'
import { appPaths } from './paths'
import { testVault } from './secrets'
import { starterPack } from './sources/starterPack'
import { makeRaw } from './testing'

const FIT: FitAssessment = { score: 95, bucket: 'perfect', summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }
const FIELD = { key: 'q', label: 'Q', type: 'text' as const, required: false, options: [], placeholder: null, maxLength: null, fileHint: null }

const result = (patch: Partial<SubmitRunResult> = {}): SubmitRunResult => ({
  ok: false,
  status: 'needs_attention',
  message: 'Didn\'t submit. "Desired salary" needs your answer. Fix it in the browser and press submit there.',
  screenshotPath: null,
  confirmation: null,
  answers: [],
  formFields: [],
  costUsd: 0,
  completion: null,
  ...patch
})
const completion = (confirmed = false) => Promise.resolve({ confirmed, screenshotPath: null, costUsd: 0, answers: [], formFields: [] })
const prepareFailures = (ctx: { db: { get<T>(sql: string, params?: Record<string, string | number | null>): T | undefined } }, jobId: string): number =>
  ctx.db.get<{ n: number }>('SELECT prepare_failures AS n FROM jobs WHERE id = :id', { id: jobId })?.n ?? -1
const settle = () => new Promise((r) => setTimeout(r, 30))

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
  mocks.run.impl = null
  mocks.run.calls = 0
  mocks.draft.impl = null
  mocks.draft.seen = []
  mocks.read.impl = null
  mocks.probe.impl = null
  mocks.probe.calls = []
})

describe('Starter pack', () => {
  it('adds every board of a group as a watched company that is due now', async () => {
    const env = await services()
    const games = starterPack('games')
    const counts = await env.api.addStarterPack('games')
    expect(counts).toEqual({ added: games.length, skipped: 0 })
    const page = await env.api.listCompanies({ pageSize: 200 })
    expect(page.total).toBe(games.length)
    expect(page.items.every((c) => c.watch && c.origin === 'starter' && c.careersUrl)).toBe(true)
    const riot = page.items.find((c) => c.name === 'Riot Games')!
    expect(riot).toMatchObject({ ats: 'greenhouse', atsToken: 'riotgames', careersUrl: 'https://boards.greenhouse.io/riotgames' })
    const state = env.ctx.boards.get(riot.id)!
    expect(state.origin).toBe('starter')
    expect(Date.parse(state.nextCheckAt)).toBeLessThanOrEqual(Date.now())
    expect(env.ctx.boards.due(new Date().toISOString(), 1000).length).toBe(games.length)
  })

  it('skips boards you already have and leaves their settings alone', async () => {
    const env = await services()
    const mine = await env.api.saveCompany({ name: 'My Riot', ats: 'greenhouse', atsToken: 'riotgames', watch: false, notes: 'Mine.' })
    const blocked = await env.api.saveCompany({ name: 'Epic', ats: 'greenhouse', atsToken: 'epicgames', blocked: true })
    const games = starterPack('games')
    expect(await env.api.addStarterPack('games')).toEqual({ added: games.length - 2, skipped: 2 })
    expect(env.ctx.companies.get(mine.id)).toMatchObject({ name: 'My Riot', watch: false, notes: 'Mine.', origin: 'manual' })
    expect(env.ctx.companies.get(blocked.id)).toMatchObject({ blocked: true, watch: false })
    expect(env.ctx.boards.get(mine.id)).toBeNull()
    // A second run adds nothing.
    expect(await env.api.addStarterPack('games')).toEqual({ added: 0, skipped: games.length })
  })

  it('adds both groups for all', async () => {
    const env = await services()
    const all = starterPack()
    expect(await env.api.addStarterPack('all')).toEqual({ added: all.length, skipped: 0 })
    expect(await env.api.addStarterPack('tech')).toEqual({ added: 0, skipped: starterPack('tech').length })
    expect(env.ctx.companies.countWatched()).toBe(all.length)
  })
})

describe('Board import', () => {
  it('reads a pasted list without any request', async () => {
    const env = await services()
    const lines = await env.api.parseBoardImport('greenhouse:stripe\nhttps://jobs.lever.co/spotify/abc\nhttps://acme.wd5.myworkdayjobs.com/Careers\n# skip\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ ats: 'greenhouse', token: 'stripe', name: 'Stripe' })
    expect(lines[1]).toMatchObject({ ats: 'lever', token: 'spotify' })
    expect(lines[2]).toHaveProperty('error')
    expect(mocks.probe.calls).toEqual([])
  })

  it('adds boards as watched imports with a first check, and skips known and unreadable ones', async () => {
    const env = await services()
    const known = await env.api.saveCompany({ name: 'Known', ats: 'lever', atsToken: 'known', watch: false })
    const counts = await env.api.importBoards([
      { ats: 'greenhouse', token: 'acme', name: 'Acme Corp' },
      { ats: 'lever', token: 'known', name: 'Known Again' },
      { ats: 'ashby', token: 'no-name', name: null },
      { ats: 'workday', token: 'tenant', name: 'Workday Co' }
    ])
    expect(counts).toEqual({ added: 2, skipped: 2 })
    const acme = env.ctx.companies.findByAts('greenhouse', 'acme')!
    expect(acme).toMatchObject({ name: 'Acme Corp', watch: true, origin: 'import', careersUrl: 'https://boards.greenhouse.io/acme' })
    expect(env.ctx.boards.get(acme.id)).toMatchObject({ origin: 'import', failures: 0 })
    expect(env.ctx.companies.findByAts('ashby', 'no-name')?.name).toBe('No Name')
    expect(env.ctx.companies.get(known.id)).toMatchObject({ name: 'Known', watch: false })
    expect(env.ctx.companies.findByAts('workday', 'tenant')).toBeNull()
  })

  it('checks boards one at a time and pushes each result under the token', async () => {
    const pushed: Array<{ channel: string; payload: any }> = []
    const env = await services({ emit: (channel, payload) => pushed.push({ channel, payload }) })
    let running = 0
    let overlap = 0
    mocks.probe.impl = async (_ats, token) => {
      running += 1
      overlap = Math.max(overlap, running)
      await new Promise((r) => setTimeout(r, 2))
      running -= 1
      return token === 'gone' ? { ok: false, error: 'Greenhouse has no board named "gone".' } : { ok: true, name: token.toUpperCase(), jobs: token.length }
    }
    const entries = [
      { ats: 'greenhouse' as const, token: 'acme' },
      { ats: 'lever' as const, token: 'gone' },
      { ats: 'ashby' as const, token: 'beta' }
    ]
    const results = await env.api.probeBoards(entries, 'tok-1')
    expect(overlap).toBe(1)
    expect(mocks.probe.calls).toEqual(['greenhouse:acme', 'lever:gone', 'ashby:beta'])
    expect(results).toEqual([
      { ats: 'greenhouse', token: 'acme', ok: true, name: 'ACME', jobs: 4 },
      { ats: 'lever', token: 'gone', ok: false, error: 'Greenhouse has no board named "gone".' },
      { ats: 'ashby', token: 'beta', ok: true, name: 'BETA', jobs: 4 }
    ])
    const probes = pushed.filter((p) => p.channel === 'boards:probe').map((p) => p.payload)
    expect(probes.map((p) => [p.token, p.done, p.total])).toEqual([['tok-1', 1, 3], ['tok-1', 2, 3], ['tok-1', 3, 3]])
    expect(probes.map((p) => p.result)).toEqual(results)
    // Checking adds nothing to the list.
    expect((await env.api.listCompanies()).total).toBe(0)
  })

  it('refuses more than 500 boards in one call', async () => {
    const env = await services()
    mocks.probe.impl = async () => ({ ok: true, name: null, jobs: 0 })
    const many = Array.from({ length: 501 }, (_, i) => ({ ats: 'greenhouse' as const, token: `b${i}` }))
    await expect(env.api.probeBoards(many, 't')).rejects.toThrow('at most 500')
    expect(mocks.probe.calls).toEqual([])
    expect(await env.api.probeBoards(many.slice(0, 500), 't')).toHaveLength(500)
  })
})

describe('Bulk company actions', () => {
  it('watching a stopped board clears its failures and makes it due', async () => {
    const env = await services()
    const stopped = await env.api.saveCompany({ name: 'Stopped', ats: 'greenhouse', atsToken: 'stopped', watch: true })
    for (let i = 0; i < 5; i++) env.ctx.boards.recordCheck(stopped.id, { status: 500, error: 'HTTP 500' })
    expect(env.ctx.companies.get(stopped.id)?.watch).toBe(false)
    expect((await env.api.listCompanies({ state: 'stopped' })).items.map((c) => c.id)).toEqual([stopped.id])
    const fresh = await env.api.saveCompany({ name: 'Fresh', ats: 'lever', atsToken: 'fresh', watch: false })
    expect(await env.api.bulkCompanies({ ids: [stopped.id, fresh.id], action: 'watch' })).toEqual({ changed: 2 })
    expect(env.ctx.boards.get(stopped.id)).toMatchObject({ failures: 0, lastError: null })
    expect(Date.parse(env.ctx.boards.get(stopped.id)!.nextCheckAt)).toBeLessThanOrEqual(Date.now())
    expect(env.ctx.boards.get(fresh.id)).not.toBeNull()
    expect((await env.api.listCompanies({ state: 'stopped' })).total).toBe(0)
  })

  it('blocks, unblocks and deletes many at once', async () => {
    const env = await services()
    const a = await env.api.saveCompany({ name: 'Alpha', ats: 'lever', atsToken: 'alpha', watch: true })
    const b = await env.api.saveCompany({ name: 'Beta', ats: 'lever', atsToken: 'beta', watch: true })
    expect(await env.api.bulkCompanies({ ids: [a.id, b.id], action: 'block' })).toEqual({ changed: 2 })
    expect((await env.api.listCompanies({ state: 'blocked' })).total).toBe(2)
    expect(await env.api.bulkCompanies({ ids: [a.id, b.id], action: 'watch' })).toEqual({ changed: 0 })
    expect(await env.api.bulkCompanies({ ids: [a.id, b.id], action: 'delete' })).toEqual({ changed: 2 })
    expect((await env.api.listCompanies()).counts.total).toBe(0)
  })
})

async function services(options: { beforeStart?: (dir: string) => void; emit?: (channel: string, payload: unknown) => void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-ipc-'))
  const paths = appPaths(dir)
  options.beforeStart?.(dir)
  const s = await createServices({ paths, vault: testVault, emit: options.emit ?? (() => {}), appVersion: '0.0.0' })
  open.push(async () => {
    await s.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { ctx } = s
  ctx.settings.update({ autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 50 }, thresholds: { autoSubmitScore: 85 } })
  /** A job in the shortlist, with no application. */
  const addJob = (company: string) => {
    const { job } = ctx.jobs.upsertRaw(makeRaw({ externalId: `x-${company}`, company }), null)
    ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    return job.id
  }
  /** An application that is ready for autopilot. */
  const addReady = (company: string) => {
    const app = ctx.applications.create(addJob(company))
    ctx.applications.update(app.id, { status: 'ready', formFields: [FIELD] })
    return app.id
  }
  const run = () => s.api.runPipeline({ discover: false, triage: false, submit: true })
  return { ...s, paths, addJob, addReady, run }
}

describe('autopilot submit failures', () => {
  it('keeps every waiting application in the queue when the browser will not start', async () => {
    const env = await services()
    const ids = Array.from({ length: 5 }, (_, i) => env.addReady(`Co${i}`))
    mocks.run.impl = async () => {
      throw new Error('Could not open a browser. Install Chrome or Edge.')
    }
    const stats = await env.run()
    // The run ends after two failures in a row, so only two applications were touched.
    expect(mocks.run.calls).toBe(2)
    expect(stats.errors).toBe(2)
    const after = ids.map((id) => env.ctx.applications.get(id)!)
    expect(after.map((a) => a.submitFailures)).toEqual([1, 1, 0, 0, 0])
    for (const a of after) expect(a).toMatchObject({ status: 'ready', submitMode: null, submitClickedAt: null })
    expect(after[0].error).toMatch(/Couldn't open or fill the form\. Could not open a browser/)
    expect(env.ctx.applications.listReady()).toHaveLength(5)
  })

  it('leaves an application for the user on the third failure', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async () => {
      throw new Error('The page would not load.')
    }
    await env.run()
    await env.run()
    expect(env.ctx.applications.get(id)).toMatchObject({ status: 'ready', submitFailures: 2 })
    await env.run()
    const done = env.ctx.applications.get(id)!
    expect(done).toMatchObject({ status: 'needs_attention', submitFailures: 3 })
    expect(done.error).toMatch(/failed 3 times/)
    expect(env.ctx.applications.listReady()).toHaveLength(0)
  })

  it('does not count a budget or provider limit, puts the application back and rethrows to the run', async () => {
    for (const [error, flag] of [
      [new BudgetExceededError("Today's AI budget of $1.00 is used up."), 'stoppedForBudget'],
      [new RateLimitedError('Too many requests.'), 'stoppedForRateLimit']
    ] as const) {
      const env = await services()
      const first = env.addReady('Acme')
      const second = env.addReady('Globex')
      mocks.run.impl = async () => {
        throw error
      }
      mocks.run.calls = 0
      const stats = await env.run()
      expect(stats[flag]).toBe(true)
      expect(mocks.run.calls).toBe(1)
      expect(env.ctx.applications.get(first)).toMatchObject({ status: 'ready', submitMode: null, submitFailures: 0 })
      expect(env.ctx.applications.get(first)!.error).toMatch(/tried again on a later run/)
      expect(env.ctx.applications.get(second)).toMatchObject({ status: 'ready', submitFailures: 0 })
      expect(env.ctx.applications.listReady()).toHaveLength(2)
    }
  })

  it('still parks an application after a failure once its Submit click was recorded', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async (deps) => {
      deps.recordSubmitClick(new Date().toISOString())
      throw new Error('The browser crashed.')
    }
    const stats = await env.run()
    // The failure comes back as a result, not an exception, since a click may have gone through.
    expect(stats.errors).toBe(1)
    const app = env.ctx.applications.get(id)!
    expect(app).toMatchObject({ status: 'needs_attention', submitMode: 'auto', submitFailures: 0 })
    expect(app.submitClickedAt).not.toBeNull()
    expect(env.ctx.applications.listReady()).toHaveLength(0)
  })

  it('keeps today\'s behavior when the user pressed Submit', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async () => {
      throw new Error('Could not open a browser.')
    }
    const res = await env.api.submitApplication(id, 'auto')
    expect(res).toMatchObject({ ok: false, status: 'needs_attention' })
    expect(env.ctx.applications.get(id)).toMatchObject({ status: 'needs_attention', submitMode: 'auto', submitFailures: 0 })
  })

  it('clears the failure count after a confirmed submit', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    env.ctx.applications.update(id, { submitFailures: 2 })
    mocks.run.impl = async () => result({ ok: true, status: 'submitted', message: 'Submitted.', confirmation: 'Thank you' })
    const stats = await env.run()
    expect(stats.submitted).toBe(1)
    expect(env.ctx.applications.get(id)).toMatchObject({ status: 'submitted', submitFailures: 0 })
  })
})

describe('autopilot dry run', () => {
  const dryRun = () =>
    result({ ok: true, status: 'ready', message: 'Dry run: filled and not sent. See the screenshot.', screenshotPath: '/shots/a.png', dryRun: true })

  it('returns the application to the queue marked as dry-run, so it is not filled again', async () => {
    const env = await services()
    env.ctx.settings.update({ autopilot: { dryRun: true } })
    const id = env.addReady('Acme')
    mocks.run.impl = async () => dryRun()
    await env.run()
    expect(env.ctx.applications.get(id)).toMatchObject({
      status: 'ready',
      submitMode: null,
      error: 'Dry run: filled and not sent. See the screenshot.',
      screenshotPath: '/shots/a.png'
    })
    expect(env.ctx.applications.get(id)!.dryRunAt).not.toBeNull()
    await env.run()
    expect(mocks.run.calls).toBe(1)

    // With dry run off the application is eligible again.
    env.ctx.settings.update({ autopilot: { dryRun: false } })
    mocks.run.impl = async () => result({ ok: true, status: 'submitted', message: 'Submitted.', confirmation: 'Thank you' })
    await env.run()
    expect(mocks.run.calls).toBe(2)
    expect(env.ctx.applications.get(id)!.status).toBe('submitted')
  })

  it('does not mark a dry run the user started from the Review page', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async () => result({ ok: true, status: 'submitting', message: 'Dry run: the form is filled.', completion: completion() })
    await env.api.submitApplication(id, 'auto')
    await settle()
    expect(env.ctx.applications.get(id)).toMatchObject({ submitMode: 'auto', dryRunAt: null })
  })
})

describe('the watcher after a run', () => {
  it('keeps the reason autopilot gave when no click happened', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async () => result({ completion: completion() })
    await env.run()
    await settle()
    const app = env.ctx.applications.get(id)!
    expect(app.status).toBe('needs_attention')
    expect(app.error).toMatch(/"Desired salary" needs your answer/)
    expect(app.error).not.toMatch(/No confirmation page was seen/)
  })

  it('says no confirmation was seen when the app clicked Submit', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async (deps) => {
      deps.recordSubmitClick(new Date().toISOString())
      return result({ message: 'No confirmation page appeared. Check the browser window to see what happened.', completion: completion() })
    }
    await env.run()
    await settle()
    const app = env.ctx.applications.get(id)!
    expect(app.status).toBe('needs_attention')
    expect(app.error).toMatch(/^No confirmation page was seen\. If you submitted it/)
  })

  it('moves an application the user was filling in out of submitting without claiming a click', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async () => result({ ok: true, status: 'submitting', message: 'Everything is filled in.', completion: completion() })
    await env.api.submitApplication(id, 'assist')
    await settle()
    const app = env.ctx.applications.get(id)!
    expect(app.status).toBe('needs_attention')
    expect(app.error).toMatch(/closed before a confirmation page appeared/)
  })
})

describe('preparing', () => {
  it('counts a refusal or an unreadable reply against the job', async () => {
    const env = await services()
    for (const [i, error] of [new LlmFormatError('not JSON', ''), new LlmRefusalError('declined')].entries()) {
      const jobId = env.addJob(`Co${i}`)
      mocks.draft.impl = async () => {
        throw error
      }
      await expect(env.api.prepareApplication(jobId)).rejects.toBe(error)
      expect(prepareFailures(env.ctx, jobId)).toBe(1)
    }
  })

  it('does not count a provider error, a limit or a stopped local model', async () => {
    const env = await services()
    const errors = [
      new TypeError('fetch failed'),
      Object.assign(new Error('Service unavailable'), { status: 503 }),
      new Error('connect ECONNREFUSED 127.0.0.1:11434'),
      new Error('Request timed out.'),
      new BudgetExceededError('Budget used up.'),
      new RateLimitedError('Too many requests.')
    ]
    for (const [i, error] of errors.entries()) {
      const jobId = env.addJob(`Co${i}`)
      mocks.draft.impl = async () => {
        throw error
      }
      await expect(env.api.prepareApplication(jobId)).rejects.toBe(error)
      expect(prepareFailures(env.ctx, jobId)).toBe(0)
    }
  })

  it('lets jobs be tried again after the provider or the routing changed', async () => {
    const env = await services()
    const a = env.addJob('Acme')
    const b = env.addJob('Globex')
    const fail = () => {
      env.ctx.jobs.recordPrepareFailure(a)
      env.ctx.jobs.recordPrepareFailure(a)
      env.ctx.jobs.recordPrepareFailure(b)
    }
    fail()
    // An unrelated setting leaves the counts alone.
    await env.api.updateSettings({ thresholds: { autoSubmitScore: 90 } })
    expect(prepareFailures(env.ctx, a)).toBe(2)

    const provider = await env.api.saveProvider({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
    expect(prepareFailures(env.ctx, a)).toBe(0)
    expect(prepareFailures(env.ctx, b)).toBe(0)

    fail()
    await env.api.updateSettings({ routing: { writing: { providerId: provider.id, model: 'claude-sonnet-5-5' } } })
    expect(prepareFailures(env.ctx, a)).toBe(0)
    expect(prepareFailures(env.ctx, b)).toBe(0)
  })
})

describe('startup housekeeping', () => {
  it('deletes screenshots older than 60 days and keeps newer ones', async () => {
    let oldShot = ''
    let newShot = ''
    await services({
      beforeStart: (dir) => {
        const shots = appPaths(dir).screenshotsDir
        fs.mkdirSync(shots, { recursive: true })
        oldShot = path.join(shots, 'old.png')
        newShot = path.join(shots, 'new.png')
        fs.writeFileSync(oldShot, 'x')
        fs.writeFileSync(newShot, 'x')
        const past = new Date(Date.now() - 61 * 86_400_000)
        fs.utimesSync(oldShot, past, past)
      }
    })
    expect(fs.existsSync(oldShot)).toBe(false)
    expect(fs.existsSync(newShot)).toBe(true)
  })
})

describe('uncaught errors', () => {
  it('go to the activity log while the app is up, and never throw', async () => {
    const env = await services()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    recordProcessError('A background task failed.', new Error('socket hang up'))
    expect(env.ctx.events.list({ limit: 5, types: ['error'] })[0].message).toBe('A background task failed. socket hang up')
    await env.shutdown()
    expect(() => recordProcessError('Late.', 'after shutdown')).not.toThrow()
    quiet.mockRestore()
  })
})

describe('Application fields', () => {
  it('start at zero failures and no dry run', async () => {
    const env = await services()
    const app: Application = env.ctx.applications.get(env.addReady('Acme'))!
    expect(app).toMatchObject({ submitFailures: 0, dryRunAt: null })
  })
})

describe('Watched company boards', () => {
  it('gives a company a first board check when it becomes watched, and not again for an edit', async () => {
    const env = await services()
    const saved = await env.api.saveCompany({ careersUrl: 'https://jobs.lever.co/acme', watch: true })
    expect(saved).toMatchObject({ ats: 'lever', atsToken: 'acme', watch: true, origin: 'manual' })
    expect(env.ctx.boards.get(saved.id)).not.toBeNull()
    env.ctx.boards.recordCheck(saved.id, { status: 200, etag: 'W/"1"' })
    await env.api.saveCompany({ id: saved.id, notes: 'Good team.' })
    expect(env.ctx.boards.get(saved.id)).toMatchObject({ etag: 'W/"1"', lastStatus: 200 })
  })

  it('keeps the discovery numbers whole and in range', async () => {
    const env = await services()
    const next = await env.api.updateSettings({ discovery: { maxWatchedBoards: -5, boardsPerRun: 1e9 } })
    expect(next.discovery).toMatchObject({ maxWatchedBoards: 0, boardsPerRun: 20_000, autoWatchBoards: true })
    const rounded = await env.api.updateSettings({ discovery: { boardsPerRun: 12.6 } })
    expect(rounded.discovery.boardsPerRun).toBe(13)
  })
})

describe('Continuous mode', () => {
  it('starts and stops the work loop with the mode, and reports its status', async () => {
    const env = await services()
    expect((await env.api.getLoopStatus()).running).toBe(false)
    await env.api.updateSettings({ autopilot: { enabled: true, mode: 'continuous' } })
    const on = await env.api.getLoopStatus()
    expect(on.running).toBe(true)
    expect(Object.keys(on.workers)).toEqual(['discover', 'score', 'prepare', 'submit'])
    expect(env.controls.loopStatus()?.running).toBe(true)
    expect(env.controls.isRunning()).toBe(true)
    await env.api.updateSettings({ autopilot: { mode: 'interval' } })
    expect((await env.api.getLoopStatus()).running).toBe(false)
    expect(env.controls.loopStatus()).toBeNull()
    await env.api.updateSettings({ autopilot: { mode: 'continuous' } })
    await env.api.updateSettings({ autopilot: { enabled: false } })
    expect((await env.api.getLoopStatus()).running).toBe(false)
  })

  it('wakes the loop and returns today\'s counts instead of starting a batch run', async () => {
    const env = await services()
    await env.api.updateSettings({ autopilot: { enabled: true, mode: 'continuous' } })
    const stats = await env.api.runPipeline({ discover: true, triage: true, prepare: true })
    expect(stats).toMatchObject({ submitted: 0, discovered: 0, errors: 0 })
    expect(env.ctx.runs.list(5).filter((r) => r.trigger === 'manual')).toHaveLength(0)
  })

  it('stops the loop when the run is cancelled', async () => {
    const env = await services()
    await env.api.updateSettings({ autopilot: { enabled: true, mode: 'continuous' } })
    await env.api.cancelPipeline()
    expect((await env.api.getLoopStatus()).running).toBe(false)
  })

  it('pauses and resumes one worker, and refuses a name that is not a worker', async () => {
    const env = await services()
    await env.api.updateSettings({ autopilot: { enabled: true, mode: 'continuous' } })
    await env.api.pauseWorker('submit')
    expect((await env.api.getLoopStatus()).workers.submit).toMatchObject({ state: 'paused', reason: 'Paused by you.' })
    await env.api.resumeWorker('submit')
    expect((await env.api.getLoopStatus()).workers.submit.state).not.toBe('paused')
    await expect(env.api.pauseWorker('bogus' as never)).rejects.toThrow(/not one of the workers/)
  })

  it('keeps the new limits whole and in range', async () => {
    const env = await services()
    const next = await env.api.updateSettings({
      autopilot: { submitConcurrency: 9, hourlySubmitCap: -3.4, mode: 'sometimes' as never },
      budget: { maxTriagePerDay: 1e9, maxPreparePerDay: -1 },
      preferences: { perCompanyLimit: 0 }
    })
    expect(next.autopilot).toMatchObject({ submitConcurrency: 3, hourlySubmitCap: 0, mode: 'interval' })
    expect(next.budget).toMatchObject({ maxTriagePerDay: 1_000_000, maxPreparePerDay: 0 })
    expect(next.preferences.perCompanyLimit).toBe(1)
    const rounded = await env.api.updateSettings({ autopilot: { submitConcurrency: 2.4 }, preferences: { perCompanyLimit: 2 } })
    expect(rounded.autopilot.submitConcurrency).toBe(2)
    expect(rounded.preferences.perCompanyLimit).toBe(2)
  })

  it('sends loop status pushes to the window', async () => {
    const pushed: string[] = []
    const env = await services({ emit: (channel) => void pushed.push(channel) })
    await env.api.updateSettings({ autopilot: { enabled: true, mode: 'continuous' } })
    expect(pushed).toContain('loop:status')
    expect(pushed).toContain('pipeline:progress')
  })
})

describe('Review exceptions', () => {
  const answer = (label: string, patch: Partial<PreparedAnswer> = {}): PreparedAnswer => ({
    fieldKey: label.toLowerCase().replace(/\W+/g, '_'),
    label,
    type: 'text',
    required: true,
    options: [],
    value: '',
    source: 'ai',
    confidence: 0,
    needsUser: true,
    note: null,
    lint: null,
    ...patch
  })
  const filled = (label: string) => answer(label, { value: 'done', source: 'profile', confidence: 1, needsUser: false })
  const SALARY_USD = 'Expected salary (USD)'
  type Env = Awaited<ReturnType<typeof services>>

  /** An application with the given answers, left in the status its flags imply. */
  const addWith = (env: Env, company: string, answers: PreparedAnswer[]) => {
    const id = env.addReady(company)
    env.ctx.applications.update(id, { answers, status: answers.some((a) => a.needsUser) ? 'needs_attention' : 'ready' })
    return id
  }

  describe('answerGroup', () => {
    it('clears the flag in every application of the group and makes the finished ones ready', async () => {
      const env = await services()
      const a = addWith(env, 'Acme', [answer(SALARY_USD), filled('Name')])
      const b = addWith(env, 'Globex', [answer('Salary expectations in USD'), answer('Favorite editor')])
      const c = addWith(env, 'Initech', [answer('Expected salary (GBP)')])
      const groups = (await env.api.listExceptions()).needsYou
      const usd = groups.find((g) => g.scope === 'USD')!
      expect(usd.count).toBe(2)

      const res = await env.api.answerGroup({ key: usd.key, wordings: usd.wordings, value: '120000', saveToBank: false })
      expect(res).toEqual({ updated: 2, ready: 1, skipped: 0 })
      const first = env.ctx.applications.get(a)!
      expect(first.status).toBe('ready')
      expect(first.answers.find((x) => x.label === SALARY_USD)).toMatchObject({ value: '120000', source: 'user', confidence: 1, needsUser: false, note: null })
      // The second still has another question open, and the GBP one is a different group.
      expect(env.ctx.applications.get(b)!.status).toBe('needs_attention')
      expect(env.ctx.applications.get(b)!.answers.find((x) => x.label === 'Favorite editor')!.needsUser).toBe(true)
      expect(env.ctx.applications.get(c)!.answers[0].needsUser).toBe(true)
      expect((await env.api.listExceptions()).needsYou.map((g) => g.scope ?? g.label)).toEqual(expect.arrayContaining(['GBP', 'Favorite editor']))
    })

    it('saves one answer bank entry with the topic and scope, so the next application never asks', async () => {
      const env = await services()
      addWith(env, 'Acme', [answer(SALARY_USD)])
      addWith(env, 'Globex', [answer('Salary expectations in USD')])
      const { key, wordings } = (await env.api.listExceptions()).needsYou[0]
      await env.api.answerGroup({ key, wordings, value: '120000', saveToBank: true })
      const bank = await env.api.listAnswers()
      expect(bank).toHaveLength(1)
      expect(bank[0]).toMatchObject({ question: SALARY_USD, answer: '120000', kind: 'fact', topic: 'salary_expectation', scope: 'USD' })
      // Another wording of the same question now finds it, and a second save updates it.
      expect(env.ctx.answers.findBest('What is your desired salary in USD?')?.answer).toBe('120000')
      addWith(env, 'Initech', [answer(SALARY_USD)])
      await env.api.answerGroup({ key, wordings, value: '125000', saveToBank: true })
      expect((await env.api.listAnswers()).map((e) => e.answer)).toEqual(['125000'])
    })

    it('saves nothing when saveToBank is off', async () => {
      const env = await services()
      addWith(env, 'Acme', [answer(SALARY_USD)])
      const { key, wordings } = (await env.api.listExceptions()).needsYou[0]
      await env.api.answerGroup({ key, wordings, value: '1', saveToBank: false })
      expect(await env.api.listAnswers()).toHaveLength(0)
    })

    it('answers a user-only question and lets statusAfterEdit decide the status', async () => {
      const env = await services()
      const label = 'Do you agree to our AI use policy for applications?'
      const id = addWith(env, 'Acme', [answer(label, { type: 'radio', options: ['Yes', 'No'] })])
      const group = (await env.api.listExceptions()).needsYou[0]
      expect(group.userOnly).toBe(true)
      expect(group.options).toEqual(['Yes', 'No'])
      const res = await env.api.answerGroup({ key: group.key, wordings: group.wordings, value: 'Yes', saveToBank: false })
      expect(res).toMatchObject({ updated: 1, ready: 1 })
      const app = env.ctx.applications.get(id)!
      expect(app.status).toBe('ready')
      // The answer is the person's own. Autopilot still holds it back unless Settings sends saved user answers.
      expect(app.answers[0]).toMatchObject({ value: 'Yes', source: 'user' })
      expect(env.ctx.settings.get().autopilot.sendSavedUserAnswers).toBe(false)
    })

    it('keeps opposite wordings of a user-only question apart', async () => {
      const env = await services()
      const yesNo = { type: 'radio' as const, options: ['Yes', 'No'] }
      addWith(env, 'Acme', [answer('Have you been convicted of a felony?', yesNo)])
      const consent = addWith(env, 'Globex', [answer('Do you consent to a criminal background check?', yesNo)])
      const groups = (await env.api.listExceptions()).needsYou
      expect(groups).toHaveLength(2)
      const felony = groups.find((g) => /felony/.test(g.label))!
      const res = await env.api.answerGroup({ key: felony.key, wordings: felony.wordings, value: 'No', saveToBank: false })
      expect(res).toMatchObject({ updated: 1 })
      expect(env.ctx.applications.get(consent)!.answers[0]).toMatchObject({ value: '', needsUser: true })
    })

    it('applies a text answer only to the wordings the person saw', async () => {
      const env = await services()
      const first = addWith(env, 'Acme', [answer(SALARY_USD)])
      const second = addWith(env, 'Globex', [answer('Salary expectations in USD')])
      const group = (await env.api.listExceptions()).needsYou[0]
      expect(group.wordings).toEqual([SALARY_USD, 'Salary expectations in USD'])
      const res = await env.api.answerGroup({ key: group.key, wordings: [SALARY_USD], value: '120000', saveToBank: false })
      expect(res).toEqual({ updated: 1, ready: 1, skipped: 1 })
      expect(env.ctx.applications.get(first)!.answers[0].value).toBe('120000')
      expect(env.ctx.applications.get(second)!.answers[0]).toMatchObject({ value: '', needsUser: true })
    })

    it('does not reopen a closed posting or answer its application', async () => {
      const env = await services()
      const id = addWith(env, 'Acme', [answer(SALARY_USD)])
      const jobId = env.ctx.applications.get(id)!.jobId
      env.ctx.jobs.setStage(jobId, 'closed')
      const group = (await env.api.listExceptions()).needsYou[0]
      const res = await env.api.answerGroup({ key: group.key, wordings: group.wordings, value: '1', saveToBank: false })
      expect(res).toEqual({ updated: 0, ready: 0, skipped: 1 })
      expect(env.ctx.jobs.get(jobId)!.stage).toBe('closed')
      expect(env.ctx.applications.get(id)!.answers[0].needsUser).toBe(true)
    })

    it('skips an application whose form does not accept the value', async () => {
      const env = await services()
      const ok = addWith(env, 'Acme', [answer('T-shirt size', { type: 'select', options: ['S', 'M'] })])
      const odd = addWith(env, 'Globex', [answer('T-shirt size', { type: 'select', options: ['Small', 'Large'] })])
      const { key, wordings } = (await env.api.listExceptions()).needsYou[0]
      const res = await env.api.answerGroup({ key, wordings, value: 'M', saveToBank: false })
      expect(res).toEqual({ updated: 1, ready: 1, skipped: 1 })
      expect(env.ctx.applications.get(ok)!.status).toBe('ready')
      expect(env.ctx.applications.get(odd)!.answers[0].needsUser).toBe(true)
    })

    it('refuses an empty answer, and does nothing for a group that has gone', async () => {
      const env = await services()
      addWith(env, 'Acme', [answer(SALARY_USD)])
      const { key, wordings } = (await env.api.listExceptions()).needsYou[0]
      await expect(env.api.answerGroup({ key, wordings, value: '  ', saveToBank: false })).rejects.toThrow(/Write an answer/)
      expect(await env.api.answerGroup({ key: 'topic:gone:', wordings: [], value: 'x', saveToBank: false })).toEqual({ updated: 0, ready: 0, skipped: 0 })
    })

    it('pushes the changed applications once', async () => {
      const pushed: Array<[string, unknown]> = []
      const env = await services({ emit: (channel, payload) => void pushed.push([channel, payload]) })
      const a = addWith(env, 'Acme', [answer(SALARY_USD)])
      const b = addWith(env, 'Globex', [answer(SALARY_USD)])
      pushed.length = 0
      const first = (await env.api.listExceptions()).needsYou[0]
      await env.api.answerGroup({ key: first.key, wordings: first.wordings, value: '1', saveToBank: false })
      const changed = pushed.filter(([c]) => c === 'applications:changed')
      expect(changed).toHaveLength(1)
      expect((changed[0][1] as { applicationIds: string[] }).applicationIds.sort()).toEqual([a, b].sort())
    })
  })

  describe('retryLater', () => {
    const stuck = (env: Env, company: string, error: string, patch: Parameters<Env['ctx']['applications']['update']>[1] = {}) => {
      const id = env.addReady(company)
      env.ctx.applications.update(id, { status: 'needs_attention', submitMode: 'auto', submitFailures: 3, error, ...patch })
      return id
    }

    it('puts a passing failure back in the queue and leaves the others alone', async () => {
      const env = await services()
      const timedOut = stuck(env, 'Acme', 'Timed out while filling the form.')
      const browser = stuck(env, 'Globex', "Couldn't open or fill the form. Could not open a browser.")
      const captcha = stuck(env, 'Initech', 'The site asked for a captcha. Solve it in the browser window and press submit.')
      const clicked = stuck(env, 'Hooli', 'No confirmation page appeared. Check the browser window.', { submitClickedAt: new Date().toISOString() })
      const res = await env.api.retryLater([timedOut, browser, captcha, clicked, timedOut, 'missing'])
      expect(res).toEqual({ updated: 2, skipped: 3 })
      for (const id of [timedOut, browser]) {
        expect(env.ctx.applications.get(id)).toMatchObject({ status: 'ready', submitMode: null, submitFailures: 0, error: null })
      }
      expect(env.ctx.applications.get(captcha)).toMatchObject({ status: 'needs_attention', submitMode: 'auto', submitFailures: 3 })
      expect(env.ctx.applications.get(clicked)!.status).toBe('needs_attention')
      expect(env.ctx.applications.listReady().map((a) => a.id).sort()).toEqual([timedOut, browser].sort())
    })

    it('keeps a form a person started, since they may have sent it by hand', async () => {
      const env = await services()
      const byUser = stuck(env, 'Acme', 'Timed out while filling the form.', { lastAttemptBy: 'user' })
      const assist = stuck(env, 'Globex', "Couldn't open or fill the form. Could not open a browser.", { submitMode: 'assist' })
      const byAutopilot = stuck(env, 'Initech', 'Timed out while filling the form.', { lastAttemptBy: 'autopilot' })
      expect(await env.api.retryLater([byUser, assist, byAutopilot])).toEqual({ updated: 1, skipped: 2 })
      expect(env.ctx.applications.get(byUser)!.status).toBe('needs_attention')
      expect(env.ctx.applications.get(assist)!.status).toBe('needs_attention')
      expect(env.ctx.applications.get(byAutopilot)!.status).toBe('ready')
    })

    it('keeps a form after the person pressed Submit and the browser would not start', async () => {
      const env = await services()
      const id = env.addReady('Acme')
      mocks.run.impl = async () => {
        throw new Error('Could not open a browser.')
      }
      await env.api.submitApplication(id, 'auto')
      expect(env.ctx.applications.get(id)).toMatchObject({ status: 'needs_attention', submitMode: 'auto' })
      expect(env.ctx.applications.lastAttemptBy(id)).toBe('user')
      expect(await env.api.retryLater([id])).toEqual({ updated: 0, skipped: 1 })
    })

    it('keeps a "no confirmation" when the attempt was not autopilot\'s', async () => {
      const env = await services()
      const id = stuck(env, 'Acme', 'The browser window closed before a confirmation page appeared.', { lastAttemptBy: 'user' })
      expect(await env.api.retryLater([id])).toEqual({ updated: 0, skipped: 1 })
    })

    it('does not reopen a closed posting', async () => {
      const env = await services()
      const id = stuck(env, 'Acme', 'Timed out while filling the form.', { lastAttemptBy: 'autopilot' })
      const jobId = env.ctx.applications.get(id)!.jobId
      env.ctx.jobs.setStage(jobId, 'closed')
      expect(await env.api.retryLater([id])).toEqual({ updated: 0, skipped: 1 })
      expect(env.ctx.jobs.get(jobId)!.stage).toBe('closed')
      expect(env.ctx.applications.listReady().map((a) => a.id)).not.toContain(id)
    })

    it('keeps an application with an open question out of the queue', async () => {
      const env = await services()
      const id = stuck(env, 'Acme', 'Timed out while filling the form.', { answers: [answer('Favorite editor')] })
      expect(await env.api.retryLater([id])).toEqual({ updated: 0, skipped: 1 })
      expect(env.ctx.applications.get(id)!.status).toBe('needs_attention')
    })
  })

  describe('reportWrongSubmission', () => {
    it('turns auto-submit off, writes the event and keeps the note without changing the status', async () => {
      const pushed: string[] = []
      const env = await services({ emit: (channel) => void pushed.push(channel) })
      const id = env.addReady('Acme')
      env.ctx.applications.update(id, { status: 'submitted' })
      expect(env.ctx.settings.get().autopilot.autoSubmit).toBe(true)

      await env.api.reportWrongSubmission(id, '  It sent the wrong resume.  ')

      expect(env.ctx.settings.get().autopilot.autoSubmit).toBe(false)
      expect(pushed).toContain('settings:changed')
      const [event] = env.ctx.events.list({ types: ['submit_failed'] })
      expect(event.message).toBe('Auto-submit paused. You reported a wrong submission to Acme for Software Engineer. It sent the wrong resume.')
      expect(event.jobId).toBe(env.ctx.applications.get(id)!.jobId)
      expect(env.ctx.applications.get(id)).toMatchObject({ status: 'submitted', error: 'It sent the wrong resume.' })
    })

    it('needs a note and a real application', async () => {
      const env = await services()
      const id = env.addReady('Acme')
      await expect(env.api.reportWrongSubmission(id, '  ')).rejects.toThrow(/one line/)
      expect(env.ctx.settings.get().autopilot.autoSubmit).toBe(true)
      await expect(env.api.reportWrongSubmission('missing', 'x')).rejects.toThrow(/no longer exists/)
    })
  })
})

const liveAnswer = (label: string, patch: Partial<PreparedAnswer> = {}): PreparedAnswer => ({
  fieldKey: label,
  label,
  type: 'text',
  required: true,
  options: [],
  value: '',
  source: 'ai',
  confidence: 0,
  needsUser: true,
  note: null,
  lint: null,
  ...patch
})

describe('pausing autopilot', () => {
  it('refuses the Submit click when autopilot was paused while the form was being filled', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    let accepted: boolean | null = null
    mocks.run.impl = async (deps) => {
      env.ctx.settings.update({ autopilot: { enabled: false } })
      accepted = deps.recordSubmitClick(new Date().toISOString())
      return result()
    }
    await env.run()
    expect(accepted).toBe(false)
    expect(env.ctx.applications.get(id)!.submitClickedAt).toBeNull()
  })

  it('refuses the click when auto-submit was turned off or dry run was turned on meanwhile', async () => {
    for (const patch of [{ autoSubmit: false }, { dryRun: true }]) {
      const env = await services()
      env.addReady('Acme')
      let accepted: boolean | null = null
      mocks.run.impl = async (deps) => {
        env.ctx.settings.update({ autopilot: patch })
        accepted = deps.recordSubmitClick(new Date().toISOString())
        return result()
      }
      await env.run()
      expect(accepted, JSON.stringify(patch)).toBe(false)
    }
  })

  it('still takes the click of a person who pressed Submit while autopilot is paused', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    env.ctx.settings.update({ autopilot: { enabled: false } })
    let accepted: boolean | null = null
    mocks.run.impl = async (deps) => {
      accepted = deps.recordSubmitClick(new Date().toISOString())
      return result()
    }
    await env.api.submitApplication(id, 'auto')
    expect(accepted).toBe(true)
  })

  it('cancels the running batch when autopilot is paused, so no later application is tried', async () => {
    const env = await services()
    for (const company of ['Acme', 'Globex', 'Initech']) env.addReady(company)
    mocks.run.impl = async () => {
      await env.api.updateSettings({ autopilot: { enabled: false } })
      return result({ ok: true, status: 'submitted', message: 'Submitted.', confirmation: 'Thanks' })
    }
    await env.run()
    expect(mocks.run.calls).toBe(1)
    expect(env.ctx.events.list({ types: ['run_finished'] })[0].message).toMatch(/^Run stopped\./)
  })
})

describe('review by exception after autopilot tried an application', () => {
  it('lets an application autopilot left with a live question go back to ready once the person answers it', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async () =>
      result({
        answers: [liveAnswer('Desired start date', { liveOnly: true })],
        formFields: [{ ...FIELD, key: 'Desired start date', label: 'Desired start date', required: true }]
      })
    await env.run()
    const left = env.ctx.applications.get(id)!
    expect(left).toMatchObject({ status: 'needs_attention', submitMode: null })

    const group = (await env.api.listExceptions()).needsYou[0]
    expect(group.label).toBe('Desired start date')
    expect(await env.api.answerGroup({ key: group.key, wordings: group.wordings, value: 'Two weeks', saveToBank: false })).toMatchObject({ updated: 1, ready: 1 })
    const done = env.ctx.applications.get(id)!
    expect(done.status).toBe('ready')
    expect(done.answers[0]).toMatchObject({ value: 'Two weeks', source: 'user' })
    expect(done.answers[0].liveOnly).toBeUndefined()
    expect(env.ctx.applications.listReady().map((a) => a.id)).toContain(id)
  })

  it('keeps the application open for a person when the person pressed Submit', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async () => result({ completion: completion() })
    await env.api.submitApplication(id, 'auto')
    await settle()
    expect(env.ctx.applications.get(id)).toMatchObject({ status: 'needs_attention', submitMode: 'auto' })
  })

  it('clears the mode after the third failure too, since nobody had the tab', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    mocks.run.impl = async () => {
      throw new Error('The page would not load.')
    }
    for (let i = 0; i < 3; i++) await env.run()
    expect(env.ctx.applications.get(id)).toMatchObject({ status: 'needs_attention', submitMode: null, submitFailures: 3 })
  })
})

describe('answers written on the live form', () => {
  it('leaves a dry run that met a problem as needs attention with the problem in the error', async () => {
    const env = await services()
    env.ctx.settings.update({ autopilot: { dryRun: true } })
    const id = env.addReady('Acme')
    mocks.run.impl = async () =>
      result({
        ok: false,
        status: 'needs_attention',
        dryRun: true,
        message: 'Dry run: filled and not sent. "Why us" wasn\'t on the form you reviewed. See the screenshot.',
        answers: [liveAnswer('Why us', { value: 'Because.', confidence: 0.85, needsUser: false, liveOnly: true })]
      })
    await env.run()
    const app = env.ctx.applications.get(id)!
    expect(app).toMatchObject({ status: 'needs_attention', submitMode: null })
    expect(app.error).toMatch(/"Why us" wasn't on the form you reviewed/)
    expect(app.dryRunAt).not.toBeNull()
    expect(env.ctx.applications.listReady()).toHaveLength(0)
    expect(app.answers.find((a) => a.label === 'Why us')?.liveOnly).toBe(true)
  })

  it('counts them as reviewed once a person saves the application', async () => {
    const env = await services()
    const id = env.addReady('Acme')
    env.ctx.applications.update(id, { answers: [liveAnswer('Why us', { value: 'Because.', confidence: 0.85, needsUser: false, liveOnly: true })] })
    const before = env.ctx.applications.get(id)!
    await env.api.updateApplication(id, { answers: before.answers })
    expect(env.ctx.applications.get(id)!.answers[0].liveOnly).toBeUndefined()
  })
})

describe('preparing a posting from a job board', () => {
  const resolved = { applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/42', ats: 'greenhouse' as const, atsToken: 'acme', atsJobId: '42' }
  const draftResult = { fields: [FIELD], formSource: 'browser', formError: null, resolved: null, answers: [], coverLetter: null, coverLetterLint: null, coverLetterNeedsInput: null, costUsd: 0 }
  /** The same posting found on the employer's board and again on a job board. */
  function twins(env: Awaited<ReturnType<typeof services>>) {
    const original = env.ctx.jobs.upsertRaw(makeRaw({ source: 'greenhouse', externalId: '42', ats: 'greenhouse', atsToken: 'acme', atsJobId: '42', company: 'Acme' }), null).job
    env.ctx.jobs.saveFit(original.id, FIT, 1, 'shortlisted')
    const copy = env.ctx.jobs.upsertRaw(makeRaw({ source: 'remotive', externalId: 'r-9', url: 'https://remotive.com/remote-jobs/r-9', company: 'Acme' }), null).job
    env.ctx.jobs.saveFit(copy.id, FIT, 1, 'shortlisted')
    return { original, copy }
  }

  it('marks the copy a duplicate and writes nothing when the employer posting already has an application', async () => {
    const env = await services()
    const { original, copy } = twins(env)
    const theirs = env.ctx.applications.create(original.id)
    mocks.read.impl = async () => ({ fields: [FIELD], via: 'browser', error: null, resolved })
    mocks.draft.impl = async () => {
      throw new Error('The writing model must not run for a copy.')
    }
    const app = await env.api.prepareApplication(copy.id)
    expect(app.id).toBe(theirs.id)
    expect(mocks.draft.seen).toHaveLength(0)
    expect(env.ctx.jobs.get(copy.id)).toMatchObject({ stage: 'duplicate', dupOf: original.id })
    expect(env.ctx.applications.getByJob(copy.id)).toBeNull()
  })

  it('prepares the copy when the employer posting has no application yet, and points it at the employer\'s form', async () => {
    const env = await services()
    const { copy } = twins(env)
    mocks.read.impl = async () => ({ fields: [FIELD], via: 'browser', error: null, resolved })
    mocks.draft.impl = async () => draftResult
    const app = await env.api.prepareApplication(copy.id)
    expect(app.jobId).toBe(copy.id)
    expect(env.ctx.jobs.get(copy.id)).toMatchObject({ applyUrl: resolved.applyUrl, ats: 'greenhouse', atsJobId: '42' })
    expect((mocks.draft.seen[0] as { applyUrl: string }).applyUrl).toBe(resolved.applyUrl)
  })

  it('does not treat a dismissed or closed employer posting as handled', async () => {
    const env = await services()
    const { original, copy } = twins(env)
    env.ctx.applications.create(original.id)
    env.ctx.jobs.setStage(original.id, 'closed')
    mocks.read.impl = async () => ({ fields: [FIELD], via: 'browser', error: null, resolved })
    mocks.draft.impl = async () => draftResult
    const app = await env.api.prepareApplication(copy.id)
    expect(app.jobId).toBe(copy.id)
  })
})

describe('startup recovery', () => {
  async function restart(seed: (env: Awaited<ReturnType<typeof services>>) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-ipc-'))
    const paths = appPaths(dir)
    const first = await createServices({ paths, vault: testVault, emit: () => {}, appVersion: '0.0.0' })
    seed(first as never)
    await first.shutdown()
    const second = await createServices({ paths, vault: testVault, emit: () => {}, appVersion: '0.0.0' })
    open.push(async () => {
      await second.shutdown()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    return second
  }
  const addSubmitting = (env: { ctx: Awaited<ReturnType<typeof services>>['ctx'] }, by: 'user' | 'autopilot') => {
    const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: `x-${by}`, company: by }), null)
    env.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    const app = env.ctx.applications.create(job.id)
    env.ctx.applications.update(app.id, { status: 'submitting', submitMode: 'auto', lastAttemptBy: by, formFields: [FIELD] })
    return app.id
  }

  it('puts a fill autopilot had not clicked back in the queue, and leaves one a person had open', async () => {
    let autopilotId = ''
    let userId = ''
    const env = await restart((first) => {
      autopilotId = addSubmitting(first, 'autopilot')
      userId = addSubmitting(first, 'user')
    })
    expect(env.ctx.applications.get(autopilotId)).toMatchObject({ status: 'ready', submitMode: null, error: null })
    expect(env.ctx.applications.listReady().map((a) => a.id)).toContain(autopilotId)
    const person = env.ctx.applications.get(userId)!
    expect(person.status).toBe('needs_attention')
    expect(person.error).toMatch(/If you submitted it/)
  })

  it('leaves a fill autopilot had clicked for the person to check', async () => {
    let id = ''
    const env = await restart((first) => {
      id = addSubmitting(first, 'autopilot')
      first.ctx.applications.update(id, { submitClickedAt: new Date().toISOString() })
    })
    expect(env.ctx.applications.get(id)!.status).toBe('needs_attention')
  })
})

describe('waking the work loop', () => {
  it('wakes it when a provider is saved, so a pause for a missing model ends', async () => {
    const wake = vi.spyOn(WorkLoop.prototype, 'wake')
    try {
      const env = await services()
      await env.api.updateSettings({ autopilot: { enabled: true, mode: 'continuous' } })
      expect((await env.api.getLoopStatus()).running).toBe(true)
      wake.mockClear()
      await env.api.saveProvider({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
      expect(wake).toHaveBeenCalled()
    } finally {
      wake.mockRestore()
    }
  })
})
