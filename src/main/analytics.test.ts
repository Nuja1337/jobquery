import { describe, expect, it } from 'vitest'
import type { FitAssessment, FitBucket, JobStage, RawJob } from '@shared/types'
import { getAnalytics } from './analytics'
import { ingestRaw } from './pipeline/ingest'
import { type TestEnv, makeRaw, makeTestEnv } from './testing'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function fit(score: number, bucket: FitBucket, matches: string[], gaps: string[]): FitAssessment {
  return { score, bucket, summary: 's', matches, gaps, dealbreakers: [], seniorityFit: 'match', keywords: [] }
}

function seedJob(env: TestEnv, id: string, ageMs: number, stage: JobStage, raw: Partial<RawJob> = {}, extra: { reason?: string } = {}) {
  const job = ingestRaw(env.ctx, makeRaw({ externalId: id, title: `Job ${id}`, description: `Unique text ${id}`, ...raw })).job
  const at = new Date(Date.now() - ageMs).toISOString()
  env.ctx.db.run('UPDATE jobs SET discovered_at = :at, stage = :stage, filter_reason = :reason, updated_at = :at WHERE id = :id', {
    id: job.id,
    at,
    stage,
    reason: extra.reason ?? null
  })
  return job
}

function seedCall(env: TestEnv, o: { task: string; model?: string; jobId?: string | null; tokens: number; cost: number; hit?: boolean; ageMs?: number }) {
  env.ctx.db.run(
    `INSERT INTO llm_calls (id, at, task, stage, provider_kind, model, job_id, input_tokens, output_tokens, cached_input_tokens, cost_usd, cache_hit, duration_ms, ok)
     VALUES (:id, :at, :task, 'triage', 'anthropic', :model, :jobId, :tokens, 0, 0, :cost, :hit, 1, 1)`,
    {
      id: crypto.randomUUID(),
      at: new Date(Date.now() - (o.ageMs ?? 0)).toISOString(),
      task: o.task,
      model: o.model ?? 'claude-haiku-5-5',
      jobId: o.jobId ?? null,
      tokens: o.tokens,
      cost: o.cost,
      hit: o.hit ?? false
    }
  )
}

describe('getAnalytics', () => {
  it('fills every field from seeded data', async () => {
    const env = await makeTestEnv()
    const { ctx } = env
    ctx.settings.update({ thresholds: { shortlistScore: 60 } })

    // Free outcomes
    seedJob(env, 'f1', HOUR, 'filtered_out', {}, { reason: 'posted 45 days ago' })
    seedJob(env, 'f2', HOUR, 'filtered_out', {}, { reason: 'posted 50 days ago' })
    seedJob(env, 'p1', HOUR, 'prescored_out', {}, { reason: 'keyword match too low (10)' })
    seedJob(env, 'd1', HOUR, 'duplicate')

    // A strong job that got an interview
    const strong = seedJob(env, 's1', 4 * DAY, 'applied', { source: 'greenhouse' })
    ctx.jobs.saveFit(strong.id, fit(90, 'perfect', ['TypeScript'], ['Kubernetes']), 1)
    const appStrong = ctx.applications.create(strong.id)
    ctx.db.run('UPDATE applications SET created_at = :c WHERE id = :id', { id: appStrong.id, c: new Date(Date.now() - 3 * DAY).toISOString() })
    ctx.applications.update(appStrong.id, { status: 'submitted', submittedAt: new Date(Date.now() - 3 * DAY).toISOString() })
    ctx.db.run("UPDATE applications SET outcome = 'interview', outcome_at = :at WHERE id = :id", { id: appStrong.id, at: new Date(Date.now() - 1 * DAY).toISOString() })

    // A good job that was rejected
    const good = seedJob(env, 'g1', 2 * DAY + 4 * HOUR, 'applied', { source: 'remoteok' })
    ctx.jobs.saveFit(good.id, fit(75, 'great', ['React'], []), 1)
    const appGood = ctx.applications.create(good.id)
    ctx.applications.update(appGood.id, { status: 'submitted', submittedAt: new Date(Date.now() - 2 * DAY).toISOString() })
    ctx.db.run("UPDATE applications SET outcome = 'rejected', outcome_at = :at WHERE id = :id", { id: appGood.id, at: new Date(Date.now() - 1 * DAY).toISOString() })

    // A weak job and a dismissed job
    const weak = seedJob(env, 'w1', DAY, 'scored')
    ctx.jobs.saveFit(weak.id, fit(50, 'weak', [], ['Kubernetes', 'Go']), 1)
    const gone = seedJob(env, 'x1', DAY, 'dismissed')
    ctx.db.run("UPDATE jobs SET dismiss_tags = '[\"too senior\",\"other\"]', dismissed_at = :at WHERE id = :id", { id: gone.id, at: new Date(Date.now() - HOUR).toISOString() })

    // Outside the 7 day range
    seedJob(env, 'old', 30 * DAY, 'filtered_out', {}, { reason: 'company blocked' })

    // Model calls: two real triage calls, one cached, one cover letter for the strong job
    seedCall(env, { task: 'triage', jobId: strong.id, tokens: 2300, cost: 0.01 })
    seedCall(env, { task: 'triage', jobId: weak.id, tokens: 2300, cost: 0.01, ageMs: DAY })
    seedCall(env, { task: 'triage', jobId: weak.id, tokens: 0, cost: 0, hit: true })
    seedCall(env, { task: 'cover_letter', model: 'claude-sonnet-5-5', jobId: strong.id, tokens: 3000, cost: 0.05 })

    const report = getAnalytics(ctx, 7)

    expect(report.rangeDays).toBe(7)
    expect(report.funnel).toEqual({
      discovered: 8,
      filteredOut: 2,
      prescoredOut: 1,
      duplicates: 1,
      scored: 3,
      shortlisted: 2,
      dismissed: 1,
      prepared: 2,
      submitted: 2,
      responses: 2,
      interviews: 1,
      offers: 0
    })

    expect(report.daily).toHaveLength(7)
    expect(new Set(report.daily.map((d) => d.date)).size).toBe(7)
    expect(report.daily.reduce((n, d) => n + d.discovered, 0)).toBe(8)
    expect(report.daily.reduce((n, d) => n + d.submitted, 0)).toBe(2)
    expect(report.daily.reduce((n, d) => n + d.costUsd, 0)).toBeCloseTo(0.07, 6)
    expect(report.daily.reduce((n, d) => n + d.tokens, 0)).toBe(7600)
    expect(report.daily.some((d) => d.discovered === 0)).toBe(true)

    expect(report.outcomesByBucket).toEqual([
      { bucket: 'perfect', submitted: 1, responses: 1, interviews: 1 },
      { bucket: 'great', submitted: 1, responses: 1, interviews: 0 },
      { bucket: 'good', submitted: 0, responses: 0, interviews: 0 },
      { bucket: 'weak', submitted: 0, responses: 0, interviews: 0 }
    ])
    expect(report.outcomesBySource).toEqual(
      expect.arrayContaining([
        { source: 'greenhouse', submitted: 1, responses: 1, interviews: 1 },
        { source: 'remoteok', submitted: 1, responses: 1, interviews: 0 }
      ])
    )

    expect(report.costByTask[0]).toMatchObject({ task: 'cover_letter', calls: 1, tokens: 3000 })
    expect(report.costByTask[1]).toMatchObject({ task: 'triage', calls: 2, tokens: 4600 })
    expect(report.costByTask[1].costUsd).toBeCloseTo(0.02, 6)
    expect(report.costByModel.map((m) => m.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])

    expect(report.scoreDistribution).toHaveLength(10)
    expect(report.scoreDistribution.find((r) => r.range === '90-100')?.count).toBe(1)
    expect(report.scoreDistribution.find((r) => r.range === '70-79')?.count).toBe(1)
    expect(report.scoreDistribution.find((r) => r.range === '50-59')?.count).toBe(1)
    expect(report.topGaps[0]).toEqual({ key: 'Kubernetes', count: 2 })
    expect(report.topGaps).toContainEqual({ key: 'Go', count: 1 })
    expect(report.topMatches.map((m) => m.key).sort()).toEqual(['React', 'TypeScript'])
    expect(report.dismissReasons).toEqual(expect.arrayContaining([{ key: 'too senior', count: 1 }, { key: 'other', count: 1 }]))
    expect(report.filterReasons).toEqual([
      { key: 'posted too long ago', count: 2 },
      { key: 'keyword match too low', count: 1 }
    ])

    expect(report.tokenSavings.jobsSkippedFree).toBe(4)
    expect(report.tokenSavings.estimatedTokensSaved).toBe(4 * 2300)
    expect(report.tokenSavings.estimatedUsdSaved).toBeCloseTo(0.04, 6)
    expect(report.tokenSavings.cacheHits).toBe(1)

    // All paid spend in the range (two triage calls and a cover letter, 0.07), shared by 2 applications sent.
    expect(report.averages.costPerApplicationUsd).toBeCloseTo(0.035, 6)
    expect(report.averages.hoursDiscoveryToApply).toBeCloseTo((24 + 4) / 2, 1)
    expect(report.averages.daysToFirstResponse).toBeCloseTo(1.5, 1)
  })

  it('counts a dismissal on the day it happened, not when the posting was last seen', async () => {
    const env = await makeTestEnv()
    const { ctx } = env
    const dismissedAt = (id: string, daysAgo: number) =>
      ctx.db.run("UPDATE jobs SET dismissed_at = :at, dismiss_tags = '[\"not remote\"]' WHERE id = :id", { id, at: new Date(Date.now() - daysAgo * DAY).toISOString() })
    // Found long ago and dismissed two days ago.
    const recent = seedJob(env, 'recent', 40 * DAY, 'dismissed')
    dismissedAt(recent.id, 2)
    // Dismissed a month ago, but the board listed it again today, which bumps updated_at.
    const old = seedJob(env, 'old', 40 * DAY, 'dismissed')
    dismissedAt(old.id, 30)
    ctx.db.run('UPDATE jobs SET updated_at = :at WHERE id = :id', { id: old.id, at: new Date().toISOString() })

    const report = getAnalytics(ctx, 7)
    expect(report.dismissReasons).toEqual([{ key: 'not remote', count: 1 }])
  })

  it('divides all AI spend in the range by the applications sent in the range', async () => {
    const env = await makeTestEnv()
    const { ctx } = env
    const sent = seedJob(env, 'sent', 3 * DAY, 'applied')
    const app = ctx.applications.create(sent.id)
    ctx.applications.update(app.id, { status: 'submitted', submittedAt: new Date(Date.now() - DAY).toISOString() })
    // Triage of jobs that were never applied to still costs money.
    const other = seedJob(env, 'other', DAY, 'scored')
    seedCall(env, { task: 'triage', jobId: other.id, tokens: 1000, cost: 0.3 })
    seedCall(env, { task: 'cover_letter', jobId: sent.id, tokens: 1000, cost: 0.1 })
    // Outside the range and cached calls are left out.
    seedCall(env, { task: 'triage', jobId: other.id, tokens: 1000, cost: 5, ageMs: 20 * DAY })
    seedCall(env, { task: 'triage', jobId: other.id, tokens: 0, cost: 0, hit: true })
    expect(getAnalytics(ctx, 7).averages.costPerApplicationUsd).toBeCloseTo(0.4, 6)
  })

  it('builds the funnel from the jobs discovered in the range, so no step is larger than the one before', async () => {
    const env = await makeTestEnv()
    const { ctx } = env
    ctx.settings.update({ thresholds: { shortlistScore: 60 } })
    // Found a month ago, applied to yesterday. It is not part of this week's cohort.
    const older = seedJob(env, 'older', 30 * DAY, 'applied')
    ctx.jobs.saveFit(older.id, fit(90, 'perfect', [], []), 1)
    const olderApp = ctx.applications.create(older.id)
    ctx.applications.update(olderApp.id, { status: 'submitted', submittedAt: new Date(Date.now() - DAY).toISOString() })
    // Found this week, scored and applied to.
    const a = seedJob(env, 'a', 2 * DAY, 'applied')
    ctx.jobs.saveFit(a.id, fit(80, 'great', [], []), 1)
    const appA = ctx.applications.create(a.id)
    ctx.applications.update(appA.id, { status: 'submitted', submittedAt: new Date(Date.now() - DAY).toISOString() })
    // Found this week and prepared by hand without a score.
    const b = seedJob(env, 'b', 2 * DAY, 'preparing')
    ctx.applications.create(b.id)
    // Found this week, scored below the line.
    const c = seedJob(env, 'c', 2 * DAY, 'scored')
    ctx.jobs.saveFit(c.id, fit(40, 'weak', [], []), 1)

    const { funnel, averages, outcomesBySource } = getAnalytics(ctx, 7)
    expect(funnel).toMatchObject({ discovered: 3, scored: 3, shortlisted: 2, prepared: 2, submitted: 1 })
    const steps = [funnel.discovered, funnel.scored, funnel.shortlisted, funnel.prepared, funnel.submitted, funnel.responses, funnel.interviews, funnel.offers]
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThanOrEqual(steps[i - 1])
    // Averages and outcomes still follow the applications sent in the range, whenever the job was found.
    expect(outcomesBySource.reduce((n, o) => n + o.submitted, 0)).toBe(2)
    expect(averages.hoursDiscoveryToApply).not.toBeNull()
  })

  it('returns zeros and nulls for an empty database', async () => {
    const { ctx } = await makeTestEnv({ provider: false })
    const report = getAnalytics(ctx, 30)
    expect(report.daily).toHaveLength(30)
    expect(report.funnel.discovered).toBe(0)
    expect(report.costByTask).toEqual([])
    expect(report.outcomesByBucket).toHaveLength(4)
    expect(report.tokenSavings).toEqual({ jobsSkippedFree: 0, estimatedTokensSaved: 0, estimatedUsdSaved: 0, cacheHits: 0 })
    expect(report.averages).toEqual({ costPerApplicationUsd: null, hoursDiscoveryToApply: null, daysToFirstResponse: null })
  })

  it('estimates savings from 2500 tokens and the triage model price when no real call exists yet', async () => {
    const env = await makeTestEnv()
    seedJob(env, 'f1', HOUR, 'filtered_out', {}, { reason: 'company blocked' })
    seedJob(env, 'f2', HOUR, 'filtered_out', {}, { reason: 'company blocked' })
    const report = getAnalytics(env.ctx, 7)
    expect(report.tokenSavings.estimatedTokensSaved).toBe(5000)
    // 2125 input at $0.10/M plus 375 output at $0.50/M, per skipped job.
    expect(report.tokenSavings.estimatedUsdSaved).toBeCloseTo(2 * (2125 * 0.1 + 375 * 0.5) / 1_000_000, 8)
  })
})
