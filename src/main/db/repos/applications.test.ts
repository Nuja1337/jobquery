import { describe, expect, it } from 'vitest'
import { ingestRaw } from '../../pipeline/ingest'
import { makeRaw, makeTestEnv } from '../../testing'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const DAY = 86_400_000
const HOUR = 3_600_000

describe('ApplicationsRepo send counts', () => {
  async function withApps() {
    const { ctx } = await makeTestEnv()
    const add = (company: string, externalId: string, ats: 'lever' | 'ashby' | 'greenhouse' = 'greenhouse') => {
      const job = ingestRaw(ctx, makeRaw({ company, externalId, ats })).job
      return ctx.applications.create(job.id).id
    }
    return { ctx, add }
  }

  it('counts the sends to a company inside a window, with confirmed ones and clicks, once each', async () => {
    const { ctx, add } = await withApps()
    const confirmed = add('Acme, Inc.', 'a1')
    const clicked = add('Acme', 'a2')
    const both = add('Acme', 'a3')
    const old = add('Acme', 'a4')
    const draft = add('Acme', 'a5')
    add('Globex', 'g1')
    ctx.applications.update(confirmed, { status: 'submitted', submittedAt: ago(2 * DAY) })
    ctx.applications.update(clicked, { status: 'needs_attention', submitClickedAt: ago(5 * DAY) })
    ctx.applications.update(both, { status: 'submitted', submitClickedAt: ago(1 * DAY), submittedAt: ago(1 * DAY) })
    ctx.applications.update(old, { status: 'submitted', submittedAt: ago(40 * DAY) })
    void draft
    expect(ctx.applications.countSentToCompanySince('acme', ago(30 * DAY))).toBe(3)
    expect(ctx.applications.countSentToCompanySince('acme', ago(3 * DAY))).toBe(2)
    expect(ctx.applications.countSentToCompanySince('acme', ago(90 * DAY))).toBe(4)
    expect(ctx.applications.countSentToCompanySince('globex', ago(90 * DAY))).toBe(0)
  })

  it('counts the sends of each form family since a time', async () => {
    const { ctx, add } = await withApps()
    const lever1 = add('A', 'l1', 'lever')
    const lever2 = add('B', 'l2', 'lever')
    const ashby = add('C', 'h1', 'ashby')
    const earlier = add('D', 'l3', 'lever')
    ctx.applications.update(lever1, { status: 'submitted', submittedAt: ago(10 * 60_000) })
    ctx.applications.update(lever2, { status: 'needs_attention', submitClickedAt: ago(20 * 60_000) })
    ctx.applications.update(ashby, { status: 'submitted', submittedAt: ago(30 * 60_000) })
    ctx.applications.update(earlier, { status: 'submitted', submittedAt: ago(3 * HOUR) })
    expect(ctx.applications.countSentByAtsSince(ago(HOUR))).toEqual({ lever: 2, ashby: 1 })
    expect(ctx.applications.countSentByAtsSince(ago(5 * HOUR))).toEqual({ lever: 3, ashby: 1 })
  })

  it('counts the applications created since a time', async () => {
    const { ctx, add } = await withApps()
    add('A', 'x1')
    add('B', 'x2')
    expect(ctx.applications.countCreatedSince(ago(HOUR))).toBe(2)
    expect(ctx.applications.countCreatedSince(new Date(Date.now() + HOUR).toISOString())).toBe(0)
  })
})

describe('ApplicationsRepo list order and paging', () => {
  it('sorts by fit when asked and pages with an offset', async () => {
    const { ctx } = await makeTestEnv()
    const fit = { score: 0, bucket: 'good' as const, summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }
    const ids: string[] = []
    for (const [i, score] of [60, 90, 75].entries()) {
      const job = ingestRaw(ctx, makeRaw({ company: `Co${i}`, externalId: `fit${i}` })).job
      ctx.jobs.saveFit(job.id, { ...fit, score }, 1, 'shortlisted')
      ids.push(ctx.applications.create(job.id).id)
    }
    // The least fitting one changed last, so the default order puts it first.
    ctx.applications.update(ids[0], { status: 'ready' })
    expect(ctx.applications.list({}).items[0].id).toBe(ids[0])
    const byFit = ctx.applications.list({ sort: 'fit', limit: 2 })
    expect(byFit.items.map((a) => a.fitScore)).toEqual([90, 75])
    expect(byFit.total).toBe(3)
    expect(ctx.applications.list({ sort: 'fit', limit: 2, offset: 2 }).items.map((a) => a.fitScore)).toEqual([60])
  })

  it('reads the review rows of open applications only', async () => {
    const { ctx } = await makeTestEnv()
    const make = (n: number, status: 'ready' | 'needs_attention' | 'submitted' | 'draft') => {
      const id = ctx.applications.create(ingestRaw(ctx, makeRaw({ company: `Co${n}`, externalId: `rr${n}` })).job.id).id
      ctx.applications.update(id, { status, error: status === 'needs_attention' ? 'Timed out while filling the form.' : null })
      return id
    }
    const ready = make(1, 'ready')
    const stuck = make(2, 'needs_attention')
    make(3, 'submitted')
    make(4, 'draft')
    const rows = ctx.applications.reviewRows(['ready', 'needs_attention'])
    expect(rows.map((r) => r.id).sort()).toEqual([ready, stuck].sort())
    expect(rows.find((r) => r.id === stuck)).toMatchObject({ company: 'Co2', error: 'Timed out while filling the form.', submitClickedAt: null, answers: [] })
    expect(ctx.applications.reviewRows([])).toEqual([])
  })
})

describe('ApplicationsRepo job stage', () => {
  async function withApp() {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw({ company: 'Acme', externalId: 'a1' })).job
    const app = ctx.applications.create(job.id)
    return { ctx, job, app }
  }

  it('does not move a closed posting back to ready when its application changes', async () => {
    const { ctx, job, app } = await withApp()
    ctx.jobs.setStage(job.id, 'closed')
    ctx.applications.update(app.id, { status: 'ready' })
    expect(ctx.jobs.get(job.id)!.stage).toBe('closed')
    ctx.applications.update(app.id, { status: 'needs_attention' })
    expect(ctx.jobs.get(job.id)!.stage).toBe('closed')
  })

  it('still marks a closed posting applied when its application was sent', async () => {
    const { ctx, job, app } = await withApp()
    ctx.jobs.setStage(job.id, 'closed')
    ctx.applications.update(app.id, { status: 'submitted' })
    expect(ctx.jobs.get(job.id)!.stage).toBe('applied')
  })

  it('keeps who started the last attempt', async () => {
    const { ctx, app } = await withApp()
    expect(ctx.applications.lastAttemptBy(app.id)).toBeNull()
    ctx.applications.update(app.id, { lastAttemptBy: 'autopilot' })
    expect(ctx.applications.lastAttemptBy(app.id)).toBe('autopilot')
    ctx.applications.update(app.id, { lastAttemptBy: 'user' })
    expect(ctx.applications.lastAttemptBy(app.id)).toBe('user')
  })
})
