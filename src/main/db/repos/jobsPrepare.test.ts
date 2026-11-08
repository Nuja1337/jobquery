import { describe, expect, it } from 'vitest'
import { ingestRaw } from '../../pipeline/ingest'
import { makeRaw, makeTestEnv } from '../../testing'
import { MAX_PREPARE_FAILURES } from './jobs'

describe('prepare failures', () => {
  async function shortlisted() {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw({ externalId: 'x' })).job
    ctx.jobs.setStage(job.id, 'shortlisted')
    return { ctx, job }
  }
  const listed = (ctx: Awaited<ReturnType<typeof shortlisted>>['ctx']) => ctx.jobs.listByStage('shortlisted', { skipRepeatedPrepareFailures: true }).map((j) => j.id)

  it('skips a job after two failures and lets it back in once one is cleared', async () => {
    const { ctx, job } = await shortlisted()
    expect(MAX_PREPARE_FAILURES).toBe(2)
    expect(listed(ctx)).toEqual([job.id])
    ctx.jobs.recordPrepareFailure(job.id)
    expect(listed(ctx)).toEqual([job.id])
    ctx.jobs.recordPrepareFailure(job.id)
    expect(listed(ctx)).toEqual([])
    // Without the option the job is still found, which is what the Prepare button needs.
    expect(ctx.jobs.listByStage('shortlisted').map((j) => j.id)).toEqual([job.id])
    ctx.jobs.resetPrepareFailures(job.id)
    expect(listed(ctx)).toEqual([job.id])
  })

  it('starts every job at zero', async () => {
    const { ctx, job } = await shortlisted()
    expect(ctx.db.get<{ n: number }>('SELECT prepare_failures AS n FROM jobs WHERE id = :id', { id: job.id })?.n).toBe(0)
  })
})

describe('setApplyTarget', () => {
  it('stores where the posting really applies', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw({ source: 'remotive', externalId: 'board-1' })).job
    expect(job.applyUrl).not.toBe('https://boards.greenhouse.io/acme/jobs/42')
    ctx.jobs.setApplyTarget(job.id, { applyUrl: 'https://boards.greenhouse.io/acme/jobs/42', ats: 'greenhouse', atsToken: 'acme' })
    const after = ctx.jobs.get(job.id)!
    expect(after).toMatchObject({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/42', ats: 'greenhouse' })
    expect(ctx.db.get<{ t: string | null }>('SELECT ats_token AS t FROM jobs WHERE id = :id', { id: job.id })?.t).toBe('acme')
  })

  it('accepts a missing token', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw({ externalId: 'board-2' })).job
    ctx.jobs.setApplyTarget(job.id, { applyUrl: 'https://jobs.lever.co/acme/1', ats: 'lever', atsToken: null })
    expect(ctx.jobs.get(job.id)).toMatchObject({ applyUrl: 'https://jobs.lever.co/acme/1', ats: 'lever' })
    expect(ctx.db.get<{ t: string | null }>('SELECT ats_token AS t FROM jobs WHERE id = :id', { id: job.id })?.t).toBeNull()
  })
})

describe('re-ingest of a resolved job-board posting', () => {
  const ASHBY = 'https://jobs.ashbyhq.com/acme/abc'
  const board = { source: 'remotive' as const, externalId: 'board-9', url: 'https://remotive.com/remote-jobs/9', applyUrl: 'https://remotive.com/remote-jobs/9' }

  it('keeps the employer link, ATS and token when the board lists the job again', async () => {
    const { ctx } = await makeTestEnv()
    const first = ingestRaw(ctx, makeRaw(board)).job
    ctx.jobs.setApplyTarget(first.id, { applyUrl: ASHBY, ats: 'ashby', atsToken: 'acme' })
    const again = ingestRaw(ctx, makeRaw({ ...board, description: 'A longer, refreshed description of the job.' }))
    expect(again.isNew).toBe(false)
    expect(again.job).toMatchObject({ id: first.id, applyUrl: ASHBY, ats: 'ashby' })
    expect(ctx.db.get<{ t: string | null }>('SELECT ats_token AS t FROM jobs WHERE id = :id', { id: first.id })?.t).toBe('acme')
  })

  it('still takes a new apply link from a source that is not a job board', async () => {
    const { ctx } = await makeTestEnv()
    const first = ingestRaw(ctx, makeRaw({ externalId: 'gh-1', applyUrl: 'https://example.com/apply/1' })).job
    const again = ingestRaw(ctx, makeRaw({ externalId: 'gh-1', applyUrl: 'https://example.com/apply/2' })).job
    expect(again.id).toBe(first.id)
    expect(again.applyUrl).toBe('https://example.com/apply/2')
  })
})
