import { describe, expect, it } from 'vitest'
import { type TestEnv, makeRaw, makeTestEnv } from '../../testing'
import { MAX_BOARD_FAILURES } from './boards'

const MINUTE = 60_000
const DAY = 86_400_000
const T0 = Date.parse('2026-11-01T12:00:00.000Z')

async function setup() {
  return makeTestEnv({ provider: false })
}

function watch(env: TestEnv, name: string, token = name.toLowerCase(), extra: { createdDaysAgo?: number } = {}) {
  const company = env.ctx.companies.save({ name, ats: 'greenhouse', atsToken: token, watch: true })
  env.ctx.boards.ensureState(company.id, 'manual', new Date(T0 - 1000).toISOString())
  if (extra.createdDaysAgo !== undefined) {
    env.ctx.db.run('UPDATE companies SET created_at = :at WHERE id = :id', { id: company.id, at: new Date(T0 - extra.createdDaysAgo * DAY).toISOString() })
  }
  return company
}

/** Stores a posting on the company's board and puts it in a stage, found `daysAgo` days before T0. */
function posting(env: TestEnv, token: string, externalId: string, stage: string, daysAgo: number) {
  const raw = makeRaw({ source: 'greenhouse', ats: 'greenhouse', atsToken: token, externalId })
  const { job } = env.ctx.jobs.upsertRaw(raw, null)
  env.ctx.db.run('UPDATE jobs SET stage = :stage, discovered_at = :at WHERE id = :id', {
    id: job.id,
    stage,
    at: new Date(T0 - daysAgo * DAY).toISOString()
  })
  return job
}

const minutesUntilNext = (env: TestEnv, id: string, from = T0) => (Date.parse(env.ctx.boards.get(id)!.nextCheckAt) - from) / MINUTE

describe('BoardsRepo', () => {
  it('lists only watched, unblocked boards that are due, soonest first', async () => {
    const env = await setup()
    const a = watch(env, 'Alpha')
    const b = watch(env, 'Beta')
    const c = watch(env, 'Gamma')
    const off = env.ctx.companies.save({ name: 'Off', ats: 'greenhouse', atsToken: 'off', watch: false })
    env.ctx.boards.ensureState(off.id)
    const blocked = watch(env, 'Blocked')
    env.ctx.companies.save({ id: blocked.id, blocked: true })
    env.ctx.boards.recordCheck(b.id, { status: 304 }, T0 - 400 * MINUTE)
    env.ctx.boards.recordCheck(a.id, { status: 304 }, T0 - 700 * MINUTE)
    // Alpha was checked longest ago, so it is due first. Beta is due 20 minutes ago. Gamma was never checked, so it is due now-ish.
    env.ctx.db.run("UPDATE board_state SET next_check_at = :at WHERE company_id = :id", { id: c.id, at: new Date(T0 + 5 * DAY).toISOString() })
    const due = env.ctx.boards.due(new Date(T0).toISOString(), 10)
    expect(due.map((d) => d.company.name)).toEqual(['Alpha', 'Beta'])
    expect(env.ctx.boards.due(new Date(T0).toISOString(), 1).map((d) => d.company.name)).toEqual(['Alpha'])
    expect(env.ctx.boards.due(new Date(T0).toISOString(), 10, ['lever'])).toEqual([])
  })

  it('gives a watched company that has no state a due one', async () => {
    const env = await setup()
    env.ctx.companies.save({ name: 'Late', ats: 'greenhouse', atsToken: 'late', watch: true })
    const due = env.ctx.boards.due(new Date(T0).toISOString(), 10)
    expect(due.map((d) => d.company.name)).toEqual(['Late'])
    expect(due[0].state.origin).toBe('manual')
  })

  it('checks a board every six hours by default', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    const { state, unwatched } = env.ctx.boards.recordCheck(c.id, { status: 200, etag: 'W/"1"', listHash: 'h1', jobCount: 4, relevantCount: 0, newRelevant: false }, T0)
    expect(unwatched).toBe(false)
    expect(state).toMatchObject({ intervalMinutes: 360, etag: 'W/"1"', listHash: 'h1', liveJobs: 4, failures: 0, lastStatus: 200, lastError: null })
    expect(minutesUntilNext(env, c.id)).toBe(360)
    expect(state.lastChangedAt).toBe(new Date(T0).toISOString())
  })

  it('checks hourly when a relevant job appeared in the last 14 days', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    env.ctx.boards.recordCheck(c.id, { status: 200, newRelevant: true, relevantCount: 1 }, T0)
    expect(env.ctx.boards.get(c.id)).toMatchObject({ intervalMinutes: 60, relevantJobs: 1 })
    expect(minutesUntilNext(env, c.id)).toBe(60)
  })

  it('checks once a day when nothing relevant appeared in 60 days', async () => {
    const env = await setup()
    const old = watch(env, 'Old', 'old', { createdDaysAgo: 120 })
    env.ctx.boards.recordCheck(old.id, { status: 304 }, T0)
    expect(minutesUntilNext(env, old.id)).toBe(1440)

    // A relevant job from 30 days ago keeps the default.
    const active = watch(env, 'Active', 'active', { createdDaysAgo: 120 })
    posting(env, 'active', 'j1', 'shortlisted', 30)
    env.ctx.boards.recordCheck(active.id, { status: 304 }, T0)
    expect(minutesUntilNext(env, active.id)).toBe(360)

    // A job that never reached the shortlist does not count.
    const dull = watch(env, 'Dull', 'dull', { createdDaysAgo: 120 })
    posting(env, 'dull', 'j2', 'scored', 3)
    env.ctx.boards.recordCheck(dull.id, { status: 304 }, T0)
    expect(minutesUntilNext(env, dull.id)).toBe(1440)
  })

  it('does not slow down a board that has been watched for less than 60 days', async () => {
    const env = await setup()
    const fresh = watch(env, 'Fresh', 'fresh', { createdDaysAgo: 10 })
    env.ctx.boards.recordCheck(fresh.id, { status: 304 }, T0)
    expect(minutesUntilNext(env, fresh.id)).toBe(360)
  })

  it('counts a board\'s live and relevant postings', async () => {
    const env = await setup()
    watch(env, 'Acme')
    posting(env, 'acme', 'a', 'shortlisted', 2)
    posting(env, 'acme', 'b', 'applied', 40)
    posting(env, 'acme', 'c', 'closed', 1)
    posting(env, 'acme', 'd', 'scored', 1)
    posting(env, 'other', 'e', 'shortlisted', 1)
    expect(env.ctx.boards.relevance('greenhouse', 'acme', T0)).toEqual({ live: 3, relevant: 2, newRelevant: true })
    expect(env.ctx.boards.relevance('greenhouse', 'acme', T0 + 20 * DAY)).toMatchObject({ newRelevant: false })
  })

  it('doubles the interval after each failure, up to a day, and keeps the stored validators', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    env.ctx.boards.recordCheck(c.id, { status: 200, etag: 'W/"1"', listHash: 'h1' }, T0)
    const minutes: number[] = []
    for (let i = 0; i < MAX_BOARD_FAILURES - 1; i++) {
      env.ctx.boards.recordCheck(c.id, { status: 500, error: 'boom' }, T0)
      minutes.push(minutesUntilNext(env, c.id))
    }
    expect(minutes).toEqual([720, 1440, 1440, 1440])
    expect(env.ctx.boards.get(c.id)).toMatchObject({ failures: 4, lastError: 'boom', lastStatus: 500, etag: 'W/"1"', listHash: 'h1' })
    expect(env.ctx.companies.get(c.id)!.watch).toBe(true)
  })

  it('stops watching after five failures in a row and keeps the row', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    let outcome
    for (let i = 0; i < MAX_BOARD_FAILURES; i++) outcome = env.ctx.boards.recordCheck(c.id, { status: 404, error: 'boards-api.greenhouse.io answered 404' }, T0)
    expect(outcome!.unwatched).toBe(true)
    expect(env.ctx.companies.get(c.id)!.watch).toBe(false)
    expect(env.ctx.boards.get(c.id)).toMatchObject({ failures: 5, lastError: 'boards-api.greenhouse.io answered 404' })
    expect(env.ctx.boards.due(new Date(T0 + 30 * DAY).toISOString(), 10)).toEqual([])
  })

  it('a good read clears the failures', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    for (let i = 0; i < 3; i++) env.ctx.boards.recordCheck(c.id, { status: null, error: 'timed out' }, T0)
    const { state } = env.ctx.boards.recordCheck(c.id, { status: 304 }, T0)
    expect(state).toMatchObject({ failures: 0, lastError: null, intervalMinutes: 360 })
  })

  it('an unreachable host counts no failure, keeps the interval and tries again in 15 minutes', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    env.ctx.boards.recordCheck(c.id, { status: 200, etag: 'W/"1"', listHash: 'h1' }, T0)
    env.ctx.boards.recordCheck(c.id, { status: 500, error: 'boom' }, T0)
    const before = env.ctx.boards.get(c.id)!
    env.ctx.boards.recordCheck(c.id, { status: null, error: 'getaddrinfo ENOTFOUND boards-api.greenhouse.io' }, T0)
    expect(env.ctx.boards.get(c.id)).toMatchObject({
      failures: before.failures,
      intervalMinutes: before.intervalMinutes,
      lastStatus: null,
      lastError: 'getaddrinfo ENOTFOUND boards-api.greenhouse.io',
      etag: 'W/"1"',
      listHash: 'h1'
    })
    expect(minutesUntilNext(env, c.id)).toBe(15)
  })

  it('a long outage does not unwatch a board', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    // Three and a half days offline, checked every 15 minutes.
    let outcome
    for (let i = 0; i < 4 * 24 * 4; i++) outcome = env.ctx.boards.recordCheck(c.id, { status: null, error: 'fetch failed' }, T0 + i * 15 * MINUTE)
    expect(outcome!.unwatched).toBe(false)
    expect(env.ctx.companies.get(c.id)!.watch).toBe(true)
    expect(env.ctx.boards.get(c.id)).toMatchObject({ failures: 0, intervalMinutes: 360 })
    // Once the network is back, the board is read as before.
    const { state } = env.ctx.boards.recordCheck(c.id, { status: 200, listHash: 'h1' }, T0 + 5 * DAY)
    expect(state).toMatchObject({ failures: 0, lastError: null })
  })

  it('an outage does not clear failures a board earned with real errors', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    for (let i = 0; i < 3; i++) env.ctx.boards.recordCheck(c.id, { status: 404, error: 'answered 404' }, T0)
    for (let i = 0; i < 50; i++) env.ctx.boards.recordCheck(c.id, { status: null, error: 'fetch failed' }, T0)
    expect(env.ctx.boards.get(c.id)!.failures).toBe(3)
    // Two more real failures still unwatch it.
    env.ctx.boards.recordCheck(c.id, { status: 410, error: 'answered 410' }, T0)
    const { unwatched } = env.ctx.boards.recordCheck(c.id, { status: 503, error: 'answered 503' }, T0)
    expect(unwatched).toBe(true)
  })

  it('a 429 puts the board off without counting a failure', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    env.ctx.boards.recordCheck(c.id, { status: 429, error: 'slow down', deferUntil: T0 + 10 * MINUTE }, T0)
    expect(env.ctx.boards.get(c.id)).toMatchObject({ failures: 0, lastStatus: 429, intervalMinutes: 360 })
    // Never sooner than 15 minutes.
    expect(minutesUntilNext(env, c.id)).toBe(15)
    env.ctx.boards.recordCheck(c.id, { status: 429, error: 'slow down', deferUntil: T0 + 40 * MINUTE }, T0)
    expect(minutesUntilNext(env, c.id)).toBe(40)
  })

  it('keeps the stored validators on a 304 and replaces them when given, and null clears them', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    env.ctx.boards.recordCheck(c.id, { status: 200, etag: 'W/"1"', lastModified: 'Mon', listHash: 'h1' }, T0)
    env.ctx.boards.recordCheck(c.id, { status: 304 }, T0)
    expect(env.ctx.boards.get(c.id)).toMatchObject({ etag: 'W/"1"', lastModified: 'Mon', listHash: 'h1' })
    env.ctx.boards.recordCheck(c.id, { status: 200, etag: null, listHash: null }, T0)
    expect(env.ctx.boards.get(c.id)).toMatchObject({ etag: null, lastModified: 'Mon', listHash: null })
  })

  it('only moves the changed time when the list changed', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    env.ctx.boards.recordCheck(c.id, { status: 200, listHash: 'h1' }, T0)
    env.ctx.boards.recordCheck(c.id, { status: 200, listHash: 'h1' }, T0 + DAY)
    expect(env.ctx.boards.get(c.id)!.lastChangedAt).toBe(new Date(T0).toISOString())
    env.ctx.boards.recordCheck(c.id, { status: 200, listHash: 'h2' }, T0 + 2 * DAY)
    expect(env.ctx.boards.get(c.id)!.lastChangedAt).toBe(new Date(T0 + 2 * DAY).toISOString())
  })

  it('ensureState on a board with history clears its failures and makes it due', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    for (let i = 0; i < 2; i++) env.ctx.boards.recordCheck(c.id, { status: 500, error: 'x' }, T0)
    env.ctx.boards.ensureState(c.id, 'manual', new Date(T0).toISOString())
    expect(env.ctx.boards.get(c.id)).toMatchObject({ failures: 0, lastError: null, nextCheckAt: new Date(T0).toISOString() })
  })

  it('deleting a company deletes its state', async () => {
    const env = await setup()
    const c = watch(env, 'Acme')
    env.ctx.companies.delete(c.id)
    expect(env.ctx.boards.get(c.id)).toBeNull()
  })

  it('records where a company came from', async () => {
    const env = await setup()
    const c = env.ctx.companies.save({ name: 'Found', ats: 'lever', atsToken: 'found', watch: true, origin: 'posting_link' })
    expect(c.origin).toBe('posting_link')
    expect(env.ctx.companies.save({ id: c.id, notes: 'x' }).origin).toBe('posting_link')
    expect(env.ctx.companies.save({ name: 'Mine', ats: 'lever', atsToken: 'mine' }).origin).toBe('manual')
    expect(env.ctx.companies.countWatched()).toBe(1)
  })
})
