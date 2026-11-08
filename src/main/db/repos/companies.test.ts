import { describe, expect, it } from 'vitest'
import type { AtsKind, CompanyOrigin } from '@shared/types'
import { STOP_AFTER_FAILURES } from '@shared/sources'
import { type TestEnv, makeTestEnv } from '../../testing'
import { MAX_BOARD_FAILURES } from './boards'

const T0 = Date.parse('2026-11-01T12:00:00.000Z')

interface Seed {
  name: string
  ats?: AtsKind
  token?: string | null
  watch?: boolean
  blocked?: boolean
  origin?: CompanyOrigin
  failures?: number
}

/** Saves a company and, when it has a board, a board state with the given failures. */
function seed(env: TestEnv, s: Seed) {
  const token = s.token === undefined ? s.name.toLowerCase().replace(/\W+/g, '') : s.token
  const company = env.ctx.companies.save({
    name: s.name,
    ats: s.ats ?? 'greenhouse',
    atsToken: token ?? undefined,
    watch: s.watch ?? true,
    blocked: s.blocked ?? false,
    origin: s.origin ?? 'manual'
  })
  if (token) {
    env.ctx.boards.ensureState(company.id, company.origin, new Date(T0).toISOString())
    if (s.failures) env.ctx.db.run('UPDATE board_state SET failures = :f, last_error = :e WHERE company_id = :id', { id: company.id, f: s.failures, e: 'HTTP 500' })
  }
  return company
}

const names = (env: TestEnv, query: Parameters<TestEnv['ctx']['companies']['listPage']>[0] = {}) => env.ctx.companies.listPage(query).items.map((c) => c.name)

describe('CompaniesRepo.listPage', () => {
  it('stops a board after the number of failures the page shows', () => {
    expect(STOP_AFTER_FAILURES).toBe(MAX_BOARD_FAILURES)
  })

  it('pages by name with a total, and clamps the page size to 200', async () => {
    const env = await makeTestEnv({ provider: false })
    for (let i = 0; i < 120; i++) seed(env, { name: `Company ${String(i).padStart(3, '0')}` })
    const first = env.ctx.companies.listPage()
    expect(first.items).toHaveLength(50)
    expect(first.total).toBe(120)
    expect(first.items[0].name).toBe('Company 000')
    const third = env.ctx.companies.listPage({ page: 3 })
    expect(third.items.map((c) => c.name)).toEqual(Array.from({ length: 20 }, (_, i) => `Company ${100 + i}`))
    expect(env.ctx.companies.listPage({ pageSize: 5000 }).items).toHaveLength(120)
    expect(env.ctx.companies.listPage({ pageSize: 10, page: 12 }).items).toHaveLength(10)
    expect(env.ctx.companies.listPage({ pageSize: 10, page: 13 }).items).toHaveLength(0)
    expect(env.ctx.companies.listPage({ page: 0, pageSize: 0 }).items).toHaveLength(1)
  })

  it('searches the name and the board token and treats wildcards as text', async () => {
    const env = await makeTestEnv({ provider: false })
    seed(env, { name: 'Riot Games', token: 'riotgames' })
    seed(env, { name: 'Epic Games', token: 'epicgames' })
    seed(env, { name: 'Sony Interactive', token: 'sonyinteractiveentertainmentglobal' })
    seed(env, { name: '100% Pure', token: 'pure_co' })
    seed(env, { name: 'Other', token: 'other' })
    expect(names(env, { search: 'games' })).toEqual(['Epic Games', 'Riot Games'])
    expect(names(env, { search: '  RIOT ' })).toEqual(['Riot Games'])
    expect(names(env, { search: 'entertainment' })).toEqual(['Sony Interactive'])
    expect(names(env, { search: '%' })).toEqual(['100% Pure'])
    expect(names(env, { search: '_' })).toEqual(['100% Pure'])
    expect(names(env, { search: 'zzz' })).toEqual([])
  })

  it('filters by system and origin and combines the filters', async () => {
    const env = await makeTestEnv({ provider: false })
    seed(env, { name: 'A', ats: 'greenhouse', origin: 'starter' })
    seed(env, { name: 'B', ats: 'lever', origin: 'starter' })
    seed(env, { name: 'C', ats: 'lever', origin: 'import' })
    seed(env, { name: 'D', ats: 'unknown', token: null, origin: 'manual' })
    expect(names(env, { ats: 'lever' })).toEqual(['B', 'C'])
    expect(names(env, { origin: 'starter' })).toEqual(['A', 'B'])
    expect(names(env, { ats: 'lever', origin: 'starter' })).toEqual(['B'])
    expect(names(env, { ats: 'all', origin: 'all', state: 'all' })).toEqual(['A', 'B', 'C', 'D'])
    expect(env.ctx.companies.listPage({ ats: 'lever', origin: 'starter' }).total).toBe(1)
  })

  it('filters by state', async () => {
    const env = await makeTestEnv({ provider: false })
    seed(env, { name: 'Watched ok' })
    seed(env, { name: 'Watched failing', failures: 2 })
    seed(env, { name: 'Watched last chance', failures: MAX_BOARD_FAILURES - 1 })
    seed(env, { name: 'Stopped', watch: false, failures: MAX_BOARD_FAILURES })
    seed(env, { name: 'Off', watch: false })
    seed(env, { name: 'Off failing', watch: false, failures: 2 })
    seed(env, { name: 'Blocked', watch: false, blocked: true })
    seed(env, { name: 'Blocked stopped', watch: false, blocked: true, failures: MAX_BOARD_FAILURES })
    expect(names(env, { state: 'watched' })).toEqual(['Watched failing', 'Watched last chance', 'Watched ok'])
    expect(names(env, { state: 'unwatched' })).toEqual(['Off', 'Off failing', 'Stopped'])
    expect(names(env, { state: 'blocked' })).toEqual(['Blocked', 'Blocked stopped'])
    expect(names(env, { state: 'stopped' })).toEqual(['Stopped'])
    expect(names(env, { state: 'failing' })).toEqual(['Watched failing', 'Watched last chance'])
  })

  it('returns board state and zeros for a company with no board', async () => {
    const env = await makeTestEnv({ provider: false })
    const a = seed(env, { name: 'Alpha' })
    seed(env, { name: 'Beta', ats: 'unknown', token: null })
    env.ctx.boards.recordCheck(a.id, { status: 200, jobCount: 12, relevantCount: 3 }, T0)
    const [alpha, beta] = env.ctx.companies.listPage().items
    expect(alpha).toMatchObject({ name: 'Alpha', liveJobs: 12, relevantJobs: 3, failures: 0, lastError: null, intervalMinutes: 360 })
    expect(alpha.lastCheckedAt).toBe(new Date(T0).toISOString())
    expect(alpha.nextCheckAt).toBe(new Date(T0 + 360 * 60_000).toISOString())
    expect(beta).toMatchObject({ name: 'Beta', lastCheckedAt: null, nextCheckAt: null, intervalMinutes: null, failures: 0, liveJobs: 0, relevantJobs: 0 })
  })

  it('counts every company whatever the filters say', async () => {
    const env = await makeTestEnv({ provider: false })
    const a = seed(env, { name: 'Alpha', origin: 'posting_link' })
    const b = seed(env, { name: 'Beta', origin: 'starter' })
    seed(env, { name: 'Gamma', origin: 'posting_link', failures: 3 })
    seed(env, { name: 'Delta', watch: false, failures: MAX_BOARD_FAILURES })
    seed(env, { name: 'Epsilon', watch: false, blocked: true })
    seed(env, { name: 'Zeta', ats: 'unknown', token: null })
    env.ctx.boards.recordCheck(a.id, { status: 200, jobCount: 10, relevantCount: 2 }, T0)
    env.ctx.boards.recordCheck(b.id, { status: 200, jobCount: 5, relevantCount: 1 }, T0)
    env.ctx.db.run("UPDATE board_state SET live_jobs = 99, relevant_jobs = 99 WHERE company_id = (SELECT id FROM companies WHERE name = 'Delta')")
    const page = env.ctx.companies.listPage({ search: 'alpha' })
    expect(page.items).toHaveLength(1)
    expect(page.counts).toMatchObject({
      total: 6,
      watched: 4,
      blocked: 1,
      fromPostings: 2,
      stopped: 1,
      failing: 1,
      liveJobs: 15,
      relevantJobs: 3
    })
    // Gamma was never checked, so it is due at T0, before the other two boards' next checks.
    expect(page.counts.nextCheckAt).toBe(new Date(T0).toISOString())
  })

  it('reports no next check when no readable board is watched', async () => {
    const env = await makeTestEnv({ provider: false })
    expect(env.ctx.companies.counts()).toMatchObject({ total: 0, watched: 0, nextCheckAt: null, liveJobs: 0 })
    seed(env, { name: 'Off', watch: false })
    seed(env, { name: 'Zeta', ats: 'unknown', token: null })
    expect(env.ctx.companies.counts().nextCheckAt).toBeNull()
  })
})

describe('CompaniesRepo.bulk', () => {
  it('watches, skips blocked companies and reports the boards that need a state', async () => {
    const env = await makeTestEnv({ provider: false })
    const off = seed(env, { name: 'Off', watch: false })
    const on = seed(env, { name: 'On' })
    const blocked = seed(env, { name: 'Blocked', watch: false, blocked: true })
    const noBoard = seed(env, { name: 'No board', ats: 'unknown', token: null, watch: false })
    const result = env.ctx.companies.bulk([off.id, on.id, blocked.id, noBoard.id, 'missing', off.id], 'watch')
    expect(result.changed).toBe(2)
    expect(result.started.map((c) => c.name)).toEqual(['Off'])
    expect(result.rewatched.map((c) => c.name)).toEqual(['On'])
    expect(env.ctx.companies.get(off.id)?.watch).toBe(true)
    expect(env.ctx.companies.get(blocked.id)).toMatchObject({ watch: false, blocked: true })
    expect(env.ctx.companies.get(noBoard.id)?.watch).toBe(true)
  })

  it('unwatches, blocks, unblocks and deletes', async () => {
    const env = await makeTestEnv({ provider: false })
    const a = seed(env, { name: 'Alpha' })
    const b = seed(env, { name: 'Beta' })
    expect(env.ctx.companies.bulk([a.id, b.id], 'unwatch').changed).toBe(2)
    expect(env.ctx.companies.bulk([a.id, b.id], 'unwatch').changed).toBe(0)
    expect(env.ctx.companies.get(a.id)?.watch).toBe(false)

    env.ctx.companies.save({ id: a.id, watch: true })
    expect(env.ctx.companies.bulk([a.id], 'block').changed).toBe(1)
    expect(env.ctx.companies.get(a.id)).toMatchObject({ blocked: true, watch: false })
    expect(env.ctx.companies.blockedNames()).toEqual(['alpha'])

    expect(env.ctx.companies.bulk([a.id], 'unblock').changed).toBe(1)
    expect(env.ctx.companies.get(a.id)).toMatchObject({ blocked: false, watch: false })

    expect(env.ctx.companies.bulk([a.id, b.id, 'missing'], 'delete').changed).toBe(2)
    expect(env.ctx.companies.list()).toEqual([])
    expect(env.ctx.boards.get(a.id)).toBeNull()
  })

  it('rolls back every change when one fails', async () => {
    const env = await makeTestEnv({ provider: false })
    const a = seed(env, { name: 'Alpha' })
    const b = seed(env, { name: 'Beta' })
    env.ctx.db.run('DROP TABLE board_state')
    expect(() => env.ctx.companies.bulk([a.id, b.id], 'delete')).toThrow()
    expect(env.ctx.companies.list()).toHaveLength(2)
  })
})

describe('BoardsRepo.resetFailures', () => {
  it('clears failures and the error and makes the board due now', async () => {
    const env = await makeTestEnv({ provider: false })
    const a = seed(env, { name: 'Alpha', watch: false, failures: MAX_BOARD_FAILURES })
    env.ctx.db.run("UPDATE board_state SET next_check_at = '2099-01-01T00:00:00.000Z' WHERE company_id = :id", { id: a.id })
    env.ctx.boards.resetFailures(a.id, new Date(T0).toISOString())
    expect(env.ctx.boards.get(a.id)).toMatchObject({ failures: 0, lastError: null, nextCheckAt: new Date(T0).toISOString() })
    expect(() => env.ctx.boards.resetFailures('missing')).not.toThrow()
  })
})
