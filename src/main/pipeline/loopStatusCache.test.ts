import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRaw, makeTestEnv } from '../testing'
import { WorkLoop } from './loop'
import { Pipeline } from './orchestrator'

afterEach(() => {
  vi.useRealTimers()
})

async function setup() {
  const env = await makeTestEnv()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date(2026, 10, 7, 10, 0, 0))
  const pipeline = new Pipeline(env.ctx, {}, () => [])
  const loop = new WorkLoop(env.ctx, pipeline)
  const queries = vi.spyOn(env.ctx.db, 'get')
  const discover = (id: string) => env.ctx.jobs.upsertRaw(makeRaw({ externalId: id, company: `Co ${id}` }), null)
  return { ...env, loop, queries, discover }
}

describe('WorkLoop status counts', () => {
  it('reads the day counts once and reuses them for the next few seconds', async () => {
    const env = await setup()
    const first = env.loop.status()
    expect(env.queries.mock.calls.length).toBeGreaterThanOrEqual(6)
    env.discover('a')
    const used = env.queries.mock.calls.length
    vi.advanceTimersByTime(2_000)
    const again = env.loop.status()
    expect(env.queries.mock.calls.length).toBe(used)
    expect(again.today).toEqual(first.today)
    expect(again.today.discovered).toBe(0)
  })

  it('reads them again after the window, and the result matches the database', async () => {
    const env = await setup()
    expect(env.loop.status().today.discovered).toBe(0)
    env.discover('a')
    env.discover('b')
    vi.advanceTimersByTime(3_500)
    expect(env.loop.status().today).toMatchObject({ discovered: 2, scored: 0, prepared: 0, submitted: 0, errors: 0 })
    expect(env.loop.status().workers.discover.doneToday).toBe(2)
  })

  it('reads them again on a new day', async () => {
    const env = await setup()
    env.discover('a')
    expect(env.loop.status().today.discovered).toBe(1)
    // One second later, but past midnight: yesterday's counts must not carry over.
    vi.setSystemTime(new Date(2026, 10, 8, 0, 0, 0))
    vi.advanceTimersByTime(1_000)
    expect(env.loop.status().today.discovered).toBe(0)
  })

  it('drops the counts when the loop starts and stops', async () => {
    const env = await setup()
    expect(env.loop.status().today.submitted).toBe(0)
    const { job } = env.discover('a')
    const app = env.ctx.applications.create(job.id)
    env.ctx.applications.update(app.id, { status: 'submitted' })
    env.loop.start()
    expect(env.loop.status().today).toMatchObject({ discovered: 1, prepared: 1, submitted: 1 })
    const clicked = env.discover('b').job
    env.ctx.db.run('UPDATE applications SET submit_clicked_at = :at WHERE id = :id', { at: new Date().toISOString(), id: env.ctx.applications.create(clicked.id).id })
    await env.loop.stop()
    expect(env.loop.status().today.submitted).toBe(2)
  })

  it('counts a Submit click that saw no confirmation', async () => {
    const env = await setup()
    const { job } = env.discover('a')
    const app = env.ctx.applications.create(job.id)
    env.ctx.db.run('UPDATE applications SET submit_clicked_at = :at WHERE id = :id', { at: new Date().toISOString(), id: app.id })
    expect(env.loop.status().today.submitted).toBe(1)
  })
})
