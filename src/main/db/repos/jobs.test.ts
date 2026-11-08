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

describe('ready applications for autopilot', () => {
  it('leaves out an application that was opened for sending in assist mode', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw({ source: 'greenhouse', ats: 'greenhouse', atsToken: 'acme', externalId: 'x' })).job
    const app = ctx.applications.create(job.id)
    ctx.applications.update(app.id, { status: 'ready' })
    expect(ctx.applications.listReady()).toHaveLength(1)
    ctx.applications.update(app.id, { submitMode: 'assist' })
    expect(ctx.applications.listReady()).toHaveLength(0)
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

describe('closing search jobs after a break', () => {
  type Ctx = Awaited<ReturnType<typeof makeTestEnv>>['ctx']
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()

  async function setup() {
    const { ctx } = await makeTestEnv()
    const search = (label: string, lastRunDaysAgo: number | null, enabled = true) => {
      const saved = ctx.searches.save({ source: 'remoteok', label, params: {}, enabled })
      ctx.db.run('UPDATE searches SET last_run_at = :at WHERE id = :id', { id: saved.id, at: lastRunDaysAgo === null ? null : daysAgo(lastRunDaysAgo) })
      return saved.id
    }
    const job = (id: string, seenDaysAgo: number) => {
      const j = ctx.jobs.upsertRaw(makeRaw({ source: 'remoteok', externalId: id }), null).job
      ctx.db.run('UPDATE jobs SET last_seen_at = :at WHERE id = :id', { id: j.id, at: daysAgo(seenDaysAgo) })
      return j.id
    }
    return { ctx, search, job }
  }
  const stage = (ctx: Ctx, id: string) => ctx.jobs.get(id)?.stage

  it('keeps a job open while a search of its source has not run since the job was last seen', async () => {
    const { ctx, search, job } = await setup()
    search('ran yesterday', 1)
    const stale = search('paused for weeks', 50)
    const id = job('a', 40)
    expect(ctx.jobs.closeUnseenSearchJobs(['remoteok'])).toEqual([])
    expect(stage(ctx, id)).toBe('new')
    // Once the other search has run too and still has not returned the job, it closes.
    ctx.db.run('UPDATE searches SET last_run_at = :at WHERE id = :id', { id: stale, at: daysAgo(0) })
    expect(ctx.jobs.closeUnseenSearchJobs(['remoteok'])).toEqual([id])
    expect(stage(ctx, id)).toBe('closed')
  })

  it('does not close anything while an enabled search has never run', async () => {
    const { ctx, search, job } = await setup()
    search('ran', 1)
    search('never', null)
    const id = job('a', 40)
    expect(ctx.jobs.closeUnseenSearchJobs(['remoteok'])).toEqual([])
    expect(stage(ctx, id)).toBe('new')
  })

  it('ignores disabled searches', async () => {
    const { ctx, search, job } = await setup()
    search('ran', 1)
    search('off', 90, false)
    const id = job('a', 40)
    expect(ctx.jobs.closeUnseenSearchJobs(['remoteok'])).toEqual([id])
  })

  it('still applies the 30-day rule when every search ran recently', async () => {
    const { ctx, search, job } = await setup()
    search('a', 1)
    search('b', 2)
    const recent = job('recent', 20)
    const old = job('old', 31)
    expect(ctx.jobs.closeUnseenSearchJobs(['remoteok'])).toEqual([old])
    expect(stage(ctx, recent)).toBe('new')
  })

  it('compares each job with the oldest search run, not only the newest', async () => {
    const { ctx, search, job } = await setup()
    search('a', 0)
    search('b', 35)
    const seenBeforeBothRuns = job('x', 40)
    const seenBetween = job('y', 33)
    expect(ctx.jobs.closeUnseenSearchJobs(['remoteok'])).toEqual([seenBeforeBothRuns])
    expect(stage(ctx, seenBetween)).toBe('new')
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

describe('posting identity on an application system', () => {
  const board = (externalId: string, over: Partial<Parameters<typeof makeRaw>[0]> = {}) =>
    makeRaw({ source: 'greenhouse', ats: 'greenhouse', atsToken: 'acme', atsJobId: externalId, externalId, ...over })
  const viaSite = (externalId: string, atsJobId: string | null, over: Partial<Parameters<typeof makeRaw>[0]> = {}) =>
    makeRaw({ source: 'remotive', ats: atsJobId ? 'greenhouse' : 'unknown', atsToken: atsJobId ? 'acme' : null, atsJobId, externalId, ...over })

  it('stores the posting id and reads it back', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, board('123')).job
    expect(ctx.jobs.get(job.id)!.atsJobId).toBe('123')
  })

  it('keeps a stored posting id when a later copy has none', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, board('123')).job
    ctx.jobs.upsertRaw(board('123', { atsJobId: null }), null)
    expect(ctx.jobs.get(job.id)!.atsJobId).toBe('123')
  })

  it('fills the posting id on an older row when the same source lists it again', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, board('123', { atsJobId: null })).job
    expect(ctx.jobs.get(job.id)!.atsJobId).toBeNull()
    ctx.jobs.upsertRaw(board('123'), null)
    expect(ctx.jobs.get(job.id)!.atsJobId).toBe('123')
  })

  it('marks a posting found through a job site as a duplicate of the board posting, whatever the text says', async () => {
    const { ctx } = await makeTestEnv()
    const original = ingestRaw(ctx, board('123', { description: 'Board text about building APIs.' })).job
    const result = ingestRaw(ctx, viaSite('r-9', '123', { description: 'Completely different site text.', title: 'Other title' }))
    expect(result.duplicate).toBe(true)
    expect(result.job).toMatchObject({ stage: 'duplicate', dupOf: original.id })
  })

  it('stores the posting once when the board posting arrives second, with the board row as the original', async () => {
    const { ctx } = await makeTestEnv()
    const first = ingestRaw(ctx, viaSite('r-9', '123', { description: 'Site text.' })).job
    const result = ingestRaw(ctx, board('123', { description: 'Board text.' }))
    // The board read closes its own rows, so the board row is the one that has to stay the original.
    expect(result.duplicate).toBe(false)
    expect(result.job.dupOf).toBeNull()
    expect(ctx.jobs.get(first.id)).toMatchObject({ stage: 'duplicate', dupOf: result.job.id })
  })

  it('treats postings with different ids on the same board as different', async () => {
    const { ctx } = await makeTestEnv()
    ingestRaw(ctx, board('123'))
    const other = ingestRaw(ctx, viaSite('r-9', '124', { description: 'Other text.', title: 'Designer' }))
    expect(other.duplicate).toBe(false)
  })

  it('does not match on the id alone when the board differs', async () => {
    const { ctx } = await makeTestEnv()
    ingestRaw(ctx, board('123'))
    const other = ingestRaw(ctx, viaSite('r-9', '123', { atsToken: 'other', description: 'Other text.', title: 'Designer' }))
    expect(other.duplicate).toBe(false)
  })

  it('lets a live copy replace a closed original', async () => {
    const { ctx } = await makeTestEnv()
    const original = ingestRaw(ctx, board('123', { description: 'Board text.' })).job
    ctx.jobs.saveFit(original.id, fit(80, 'great'), 1)
    ctx.db.run("UPDATE jobs SET stage = 'closed' WHERE id = :id", { id: original.id })
    const result = ingestRaw(ctx, viaSite('r-9', '123', { description: 'Site text.' }))
    expect(result.duplicate).toBe(false)
    expect(result.job.stage).toBe('new')
    expect(result.job.fit?.score).toBe(80)
  })

  it('keeps the job-site key and company name for a job-site posting that names an employer board', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, viaSite('r-9', '123', { company: 'Acme Robotics' })).job
    expect(job.company).toBe('Acme Robotics')
    expect(ctx.db.get<{ canonical_key: string }>('SELECT canonical_key FROM jobs WHERE id = :id', { id: job.id })!.canonical_key).toBe('remotive:acme robotics:r-9')
  })

  // Only a job without an application is marked here. prepare() creates the application first, so it checks for a handled
  // twin itself before this runs (see "preparing" in ipc.test.ts).
  it('makes a resolved job-board posting without an application a duplicate when the employer posting is already stored', async () => {
    const { ctx } = await makeTestEnv()
    const original = ingestRaw(ctx, board('123', { description: 'Board text.' })).job
    const site = ingestRaw(ctx, viaSite('r-9', null, { description: 'Site text.', title: 'Other title' })).job
    expect(site.stage).toBe('new')
    const target = { applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/123', ats: 'greenhouse' as const, atsToken: 'acme', atsJobId: '123' }
    expect(ctx.jobs.setApplyTarget(site.id, target)).toBe(original.id)
    expect(ctx.jobs.get(site.id)).toMatchObject({ stage: 'duplicate', dupOf: original.id, atsJobId: '123' })
  })

  it('leaves a job with an application in its stage when it is resolved to a stored posting', async () => {
    const { ctx } = await makeTestEnv()
    ingestRaw(ctx, board('123', { description: 'Board text.' }))
    const site = ingestRaw(ctx, viaSite('r-9', null, { description: 'Site text.', title: 'Other title' })).job
    ctx.applications.create(site.id)
    const target = { applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/123', ats: 'greenhouse' as const, atsToken: 'acme', atsJobId: '123' }
    expect(ctx.jobs.setApplyTarget(site.id, target)).toBeNull()
    expect(ctx.jobs.get(site.id)!.stage).not.toBe('duplicate')
    expect(ctx.jobs.get(site.id)!.atsJobId).toBe('123')
  })

  it('still accepts a target without a posting id', async () => {
    const { ctx } = await makeTestEnv()
    const site = ingestRaw(ctx, viaSite('r-9', null)).job
    expect(ctx.jobs.setApplyTarget(site.id, { applyUrl: 'https://careers.acme.test/apply', ats: 'unknown', atsToken: null })).toBeNull()
    expect(ctx.jobs.get(site.id)).toMatchObject({ applyUrl: 'https://careers.acme.test/apply', atsJobId: null })
  })
})

describe('board scan indexes', () => {
  it('uses the board index for the closed-posting scan and the posting index for identity lookups', async () => {
    const { ctx } = await makeTestEnv()
    const plan = (sql: string, params: Record<string, string>) =>
      ctx.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => r.detail).join(' | ')
    expect(plan('SELECT id, external_id, stage FROM jobs WHERE source = :source AND ats_token = :token', { source: 'greenhouse', token: 'acme' })).toContain('idx_jobs_board')
    expect(
      plan('SELECT id FROM jobs WHERE ats = :ats AND ats_token = :token AND ats_job_id = :id', { ats: 'greenhouse', token: 'acme', id: '1' })
    ).toContain('idx_jobs_ats_job')
  })
})
