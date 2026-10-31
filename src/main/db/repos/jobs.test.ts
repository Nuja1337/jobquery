import { describe, expect, it } from 'vitest'
import { bucketFor } from '@shared/defaults'
import type { ApplicationStatus, FitAssessment, JobStage } from '@shared/types'
import { ingestRaw } from '../../pipeline/ingest'
import { makeRaw, makeTestEnv } from '../../testing'
import { stageForReopened } from './jobs'

const DAY = 86_400_000

function fit(score: number, bucket: FitAssessment['bucket'] = 'good'): FitAssessment {
  return { score, bucket, summary: 's', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }
}

describe('a closed job whose posting comes back', () => {
  const cases: Array<[ApplicationStatus, JobStage]> = [
    ['draft', 'preparing'],
    ['ready', 'ready'],
    ['needs_attention', 'ready'],
    ['submitting', 'ready'],
    ['failed', 'ready'],
    ['submitted', 'applied'],
    ['withdrawn', 'dismissed']
  ]

  it.each(cases)('with a %s application goes back to %s', async (status, expected) => {
    const { ctx } = await makeTestEnv()
    const raw = makeRaw({ source: 'greenhouse', ats: 'greenhouse', atsToken: 'acme', externalId: 'x' })
    const job = ingestRaw(ctx, raw).job
    const app = ctx.applications.create(job.id)
    ctx.applications.update(app.id, { status })
    ctx.db.run("UPDATE jobs SET stage = 'closed', closed_at = '2026-01-01T00:00:00.000Z' WHERE id = :id", { id: job.id })
    const back = ctx.jobs.upsertRaw(raw, null).job
    expect(back.stage).toBe(expected)
    expect(stageForReopened(status)).toBe(expected)
  })

  it('goes back to new without an application', async () => {
    const { ctx } = await makeTestEnv()
    const raw = makeRaw({ externalId: 'x' })
    const job = ingestRaw(ctx, raw).job
    ctx.db.run("UPDATE jobs SET stage = 'closed' WHERE id = :id", { id: job.id })
    expect(ctx.jobs.upsertRaw(raw, null).job.stage).toBe('new')
  })

  it('lets a ready application be submitted again after the posting left and came back', async () => {
    const { ctx } = await makeTestEnv()
    const raw = makeRaw({ source: 'greenhouse', ats: 'greenhouse', atsToken: 'acme', externalId: 'x' })
    const job = ingestRaw(ctx, raw).job
    const app = ctx.applications.create(job.id)
    ctx.applications.update(app.id, { status: 'ready' })
    expect(ctx.applications.listReady()).toHaveLength(1)
    expect(ctx.jobs.markClosedMissing('greenhouse', 'acme', ['other'])).toEqual([job.id])
    expect(ctx.applications.listReady()).toHaveLength(0)
    ctx.jobs.upsertRaw(raw, null)
    expect(ctx.applications.listReady()).toHaveLength(1)
  })
})

describe('refreshing a posting that arrives without a description', () => {
  it('keeps the stored pay, work type, links and description', async () => {
    const { ctx } = await makeTestEnv()
    const full = makeRaw({
      source: 'smartrecruiters',
      ats: 'smartrecruiters',
      atsToken: 'Acme',
      externalId: 's1',
      remote: 'hybrid',
      salaryMin: 100_000,
      salaryMax: 130_000,
      salaryCurrency: 'USD',
      url: 'https://jobs.smartrecruiters.com/Acme/s1-engineer',
      applyUrl: 'https://jobs.smartrecruiters.com/Acme/s1-engineer?apply',
      description: 'Full text with pay.'
    })
    const job = ctx.jobs.upsertRaw(full, null).job
    // The list endpoint carries none of that.
    const listOnly = { ...full, description: '', remote: 'unknown' as const, salaryMin: null, salaryMax: null, salaryCurrency: null, url: 'https://jobs.smartrecruiters.com/Acme/s1', applyUrl: 'https://jobs.smartrecruiters.com/Acme/s1', title: 'Engineer II' }
    const after = ctx.jobs.upsertRaw(listOnly, null).job
    expect(after.id).toBe(job.id)
    expect(after).toMatchObject({
      description: 'Full text with pay.',
      remote: 'hybrid',
      salaryMin: 100_000,
      salaryMax: 130_000,
      salaryCurrency: 'USD',
      url: 'https://jobs.smartrecruiters.com/Acme/s1-engineer',
      applyUrl: 'https://jobs.smartrecruiters.com/Acme/s1-engineer?apply',
      // Fields the list does carry still update.
      title: 'Engineer II'
    })
  })

  it('still takes new values when the description is present', async () => {
    const { ctx } = await makeTestEnv()
    const raw = makeRaw({ externalId: 'x', salaryMin: 90_000, salaryMax: 100_000, url: 'https://a.test/1' })
    ctx.jobs.upsertRaw(raw, null)
    const after = ctx.jobs.upsertRaw({ ...raw, salaryMin: null, salaryMax: null, url: 'https://a.test/2', description: 'New text.' }, null).job
    expect(after).toMatchObject({ salaryMin: null, url: 'https://a.test/2', description: 'New text.' })
  })

  it('does not count a posting without a description as known', async () => {
    const { ctx } = await makeTestEnv()
    ctx.jobs.upsertRaw(makeRaw({ source: 'smartrecruiters', ats: 'smartrecruiters', atsToken: 'acme', externalId: 'has', description: 'Text.' }), null)
    ctx.jobs.upsertRaw(makeRaw({ source: 'smartrecruiters', ats: 'smartrecruiters', atsToken: 'acme', externalId: 'empty', description: '' }), null)
    expect([...ctx.jobs.knownExternalIds('smartrecruiters', 'acme')]).toEqual(['has'])
  })
})

describe('dismissed_at', () => {
  it('is set when a job is dismissed and cleared when it is restored', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw({ externalId: 'x' })).job
    const read = () => ctx.db.get<{ dismissed_at: string | null }>('SELECT dismissed_at FROM jobs WHERE id = :id', { id: job.id })!.dismissed_at
    expect(read()).toBeNull()
    ctx.jobs.dismiss(job.id, null, [])
    expect(read()).not.toBeNull()
    // Seeing the posting again does not change when it was dismissed.
    const dismissedAt = read()
    ctx.jobs.upsertRaw(makeRaw({ externalId: 'x' }), null)
    expect(read()).toBe(dismissedAt)
    ctx.jobs.restore(job.id, 60)
    expect(read()).toBeNull()
  })
})

describe('last_seen_at and stale search jobs', () => {
  const seenDaysAgo = (ctx: Awaited<ReturnType<typeof makeTestEnv>>['ctx'], id: string, days: number) =>
    ctx.db.run('UPDATE jobs SET last_seen_at = :at WHERE id = :id', { id, at: new Date(Date.now() - days * DAY).toISOString() })

  it('is refreshed each time a source returns the posting', async () => {
    const { ctx } = await makeTestEnv()
    const raw = makeRaw({ source: 'remoteok', externalId: 'x' })
    const job = ctx.jobs.upsertRaw(raw, null).job
    seenDaysAgo(ctx, job.id, 40)
    expect(ctx.jobs.isUnseen(job.id)).toBe(true)
    ctx.jobs.upsertRaw(raw, null)
    expect(ctx.jobs.isUnseen(job.id)).toBe(false)
  })

  it('closes early-stage search jobs after 30 days and leaves the rest', async () => {
    const { ctx } = await makeTestEnv()
    const make = (id: string, stage: JobStage, source: 'remoteok' | 'greenhouse' = 'remoteok') => {
      const job = ctx.jobs.upsertRaw(makeRaw({ source, externalId: id }), null).job
      ctx.jobs.setStage(job.id, stage)
      seenDaysAgo(ctx, job.id, 31)
      return job.id
    }
    const old = ['new', 'filtered_out', 'prescored_out', 'scored', 'shortlisted'].map((stage) => make(stage, stage as JobStage))
    const preparing = make('preparing', 'preparing')
    const applied = make('applied', 'applied')
    const dismissed = make('dismissed', 'dismissed')
    const board = make('board', 'shortlisted', 'greenhouse')
    const recent = ctx.jobs.upsertRaw(makeRaw({ source: 'remoteok', externalId: 'recent' }), null).job

    const closed = ctx.jobs.closeUnseenSearchJobs(['remoteok'])
    expect(closed.sort()).toEqual([...old].sort())
    for (const id of old) expect(ctx.jobs.get(id)?.stage).toBe('closed')
    for (const id of [preparing, applied, dismissed, board]) expect(ctx.jobs.get(id)?.stage).not.toBe('closed')
    expect(ctx.jobs.get(recent.id)?.stage).toBe('new')
  })
})

describe('restaging for the shortlist line', () => {
  it('moves scored and shortlisted jobs across the line and refreshes their bucket', async () => {
    const { ctx } = await makeTestEnv()
    const make = (id: string, score: number, stage: JobStage, bucket: FitAssessment['bucket']) => {
      const job = ingestRaw(ctx, makeRaw({ externalId: id, description: `Text ${id}` })).job
      ctx.jobs.saveFit(job.id, fit(score, bucket), 1, stage)
      return job.id
    }
    const a = make('a', 72, 'shortlisted', 'great')
    const b = make('b', 72, 'scored', 'great')
    const c = make('c', 90, 'shortlisted', 'perfect')
    const applied = make('applied', 72, 'shortlisted', 'great')
    ctx.jobs.setStage(applied, 'applied')

    const changed = ctx.jobs.restageForShortlistScore(75)
    expect(changed.sort()).toEqual([a, b].sort())
    expect(ctx.jobs.get(a)).toMatchObject({ stage: 'scored', fitBucket: 'weak' })
    expect(ctx.jobs.get(a)?.fit?.bucket).toBe('weak')
    expect(ctx.jobs.get(b)).toMatchObject({ stage: 'scored', fitBucket: 'weak' })
    expect(ctx.jobs.get(c)).toMatchObject({ stage: 'shortlisted', fitBucket: 'perfect' })
    expect(ctx.jobs.get(applied)).toMatchObject({ stage: 'applied', fitBucket: 'great' })

    // Lowering the line brings them back.
    ctx.jobs.restageForShortlistScore(60)
    expect(ctx.jobs.get(a)).toMatchObject({ stage: 'shortlisted', fitBucket: 'great' })
    expect(ctx.jobs.restageForShortlistScore(60)).toEqual([])
  })
})

describe('bucketFor', () => {
  it('never labels a score below the shortlist line above the lowest bucket', () => {
    expect(bucketFor(72, 75)).toBe('weak')
    expect(bucketFor(84, 90)).toBe('weak')
    expect(bucketFor(75, 75)).toBe('great')
    expect(bucketFor(72, 60)).toBe('great')
    expect(bucketFor(85, 60)).toBe('perfect')
    expect(bucketFor(65, 60)).toBe('good')
    expect(bucketFor(59, 60)).toBe('weak')
  })
})
