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

describe('volume analytics', () => {
  /** An age that is always inside today, even just after midnight. */
  function earlierToday(): number {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    return Math.floor((Date.now() - midnight.getTime()) / 2)
  }

  function sendNow(env: TestEnv, id: string, at: Date, score = 80) {
    const job = seedJob(env, id, DAY, 'applied')
    env.ctx.jobs.saveFit(job.id, fit(score, 'great', [], []), 1)
    const app = env.ctx.applications.create(job.id)
    env.ctx.applications.update(app.id, { status: 'submitted', submittedAt: at.toISOString() })
    return app
  }

  it('counts the day and the week in SQL, not from list lengths', async () => {
    const env = await makeTestEnv()
    const { ctx } = env
    ctx.settings.update({ thresholds: { shortlistScore: 60 } })
    const recent = earlierToday()

    // Today: one dropped by a filter, one dropped by the keyword score, one scored low, one shortlisted, one prepared and waiting.
    seedJob(env, 't-f', recent, 'filtered_out', {}, { reason: 'company blocked' })
    seedJob(env, 't-p', recent, 'prescored_out', {}, { reason: 'keyword match too low (10)' })
    const low = seedJob(env, 't-low', recent, 'scored')
    ctx.jobs.saveFit(low.id, fit(40, 'weak', [], []), 1)
    const short = seedJob(env, 't-short', recent, 'shortlisted')
    ctx.jobs.saveFit(short.id, fit(70, 'good', [], []), 1)
    const prepared = seedJob(env, 't-prep', recent, 'ready')
    ctx.jobs.saveFit(prepared.id, fit(85, 'great', [], []), 1)
    const readyApp = ctx.applications.create(prepared.id)
    ctx.applications.update(readyApp.id, { status: 'ready' })
    // Today: one application that needs the user.
    const stuck = seedJob(env, 't-stuck', recent, 'preparing')
    ctx.jobs.saveFit(stuck.id, fit(90, 'perfect', [], []), 1)
    const stuckApp = ctx.applications.create(stuck.id)
    ctx.applications.update(stuckApp.id, { status: 'needs_attention' })
    // Found a day ago, sent just now. Its job was not found today, but its application is new.
    sendNow(env, 't-sent', new Date(Date.now() - recent / 2))
    // Three days ago: found, shortlisted and sent.
    const old = seedJob(env, 'w-old', 3 * DAY, 'applied')
    ctx.jobs.saveFit(old.id, fit(75, 'great', [], []), 1)
    const oldApp = ctx.applications.create(old.id)
    ctx.db.run('UPDATE applications SET created_at = :at WHERE id = :id', { id: oldApp.id, at: new Date(Date.now() - 3 * DAY).toISOString() })
    ctx.applications.update(oldApp.id, { status: 'submitted', submittedAt: new Date(Date.now() - 3 * DAY).toISOString() })
    // Ten days ago: outside the week.
    seedJob(env, 'x-old', 10 * DAY, 'filtered_out', {}, { reason: 'company blocked' })

    seedCall(env, { task: 'triage', tokens: 100, cost: 0.2, ageMs: recent })
    seedCall(env, { task: 'triage', tokens: 100, cost: 0.5, ageMs: 3 * DAY })
    seedCall(env, { task: 'triage', tokens: 0, cost: 0, hit: true, ageMs: recent })

    const { today, week } = getAnalytics(ctx, 1)
    expect(today).toMatchObject({ discovered: 6, filteredOut: 2, scored: 4, shortlisted: 3, prepared: 3, submitted: 1, needsAttention: 1, ready: 1 })
    expect(today.costUsd).toBeCloseTo(0.2, 6)
    expect(week).toMatchObject({ discovered: 8, filteredOut: 2, scored: 6, shortlisted: 5, prepared: 4, submitted: 2, needsAttention: 1, ready: 1 })
    expect(week.costUsd).toBeCloseTo(0.7, 6)
    // The windows do not depend on the range asked for.
    expect(getAnalytics(ctx, 30).today).toEqual(today)
  })

  it('counts the whole queue and the replies over all time', async () => {
    const env = await makeTestEnv()
    const { ctx } = env
    const old = sendNow(env, 'o1', new Date(Date.now() - 90 * DAY))
    ctx.db.run("UPDATE applications SET outcome = 'rejected' WHERE id = :id", { id: old.id })
    sendNow(env, 'o2', new Date(Date.now() - 80 * DAY))
    for (const [id, status] of [['q1', 'ready'], ['q2', 'ready'], ['q3', 'needs_attention']] as const) {
      const job = seedJob(env, id, 40 * DAY, 'ready')
      const app = ctx.applications.create(job.id)
      ctx.db.run('UPDATE applications SET created_at = :at WHERE id = :id', { id: app.id, at: new Date(Date.now() - 40 * DAY).toISOString() })
      ctx.applications.update(app.id, { status })
    }
    expect(getAnalytics(ctx, 7).totals).toEqual({ submitted: 2, responses: 1, needsAttention: 1, ready: 2 })
  })

  it('buckets the last 24 hours of sends by hour with zeros filled in', async () => {
    const env = await makeTestEnv()
    const now = Date.now()
    sendNow(env, 'h1', new Date(now - 60_000))
    sendNow(env, 'h2', new Date(now - 60_000))
    sendNow(env, 'h3', new Date(now - 3 * HOUR))
    sendNow(env, 'h4', new Date(now - 30 * HOUR))
    const { sendsByHour } = getAnalytics(env.ctx, 7)
    expect(sendsByHour).toHaveLength(24)
    const hours = sendsByHour.map((h) => h.hour)
    expect(hours).toEqual([...hours].sort())
    expect(new Set(hours).size).toBe(24)
    expect(hours.every((h) => h.endsWith(':00:00.000Z'))).toBe(true)
    expect(sendsByHour.reduce((n, h) => n + h.count, 0)).toBe(3)
    // The last bucket is the current hour. A send a minute ago is in it, or in the one before just after the hour turns.
    expect(sendsByHour[23].count + sendsByHour[22].count).toBe(2)
    expect(sendsByHour[20].count + sendsByHour[19].count + sendsByHour[21].count).toBeGreaterThanOrEqual(1)
  })

  it('counts a Submit click with no confirmation as a send', async () => {
    const env = await makeTestEnv()
    const job = seedJob(env, 'c1', HOUR, 'applied')
    const app = env.ctx.applications.create(job.id)
    env.ctx.db.run('UPDATE applications SET submit_clicked_at = :at WHERE id = :id', { id: app.id, at: new Date(Date.now() - 60_000).toISOString() })
    const report = getAnalytics(env.ctx, 7)
    expect(report.week.submitted).toBe(1)
    expect(report.sendsByHour.reduce((n, h) => n + h.count, 0)).toBe(1)
  })

  it('builds the score histogram for jobs found in the last 7 days', async () => {
    const env = await makeTestEnv()
    const { ctx } = env
    const scores: Array<[string, number, number]> = [
      ['a', 49, DAY],
      ['b', 50, DAY],
      ['c', 54, DAY],
      ['d', 55, DAY],
      ['e', 72, 2 * DAY],
      ['f', 72, 2 * DAY],
      ['g', 99, DAY],
      ['h', 100, DAY],
      ['i', 90, 10 * DAY]
    ]
    for (const [id, score, age] of scores) {
      const job = seedJob(env, `s-${id}`, age, 'scored')
      ctx.jobs.saveFit(job.id, fit(score, 'good', [], []), 1)
    }
    const { scoreHistogram, scoreCounts } = getAnalytics(ctx, 7)
    expect(scoreHistogram).toHaveLength(10)
    expect(scoreHistogram[0]).toEqual({ from: 50, to: 55, count: 2 })
    expect(scoreHistogram[1]).toEqual({ from: 55, to: 60, count: 1 })
    expect(scoreHistogram.find((b) => b.from === 70)?.count).toBe(2)
    expect(scoreHistogram[9]).toEqual({ from: 95, to: 100, count: 2 })
    expect(scoreHistogram.reduce((n, b) => n + b.count, 0)).toBe(7)
    expect(scoreCounts).toHaveLength(51)
    expect(scoreCounts[72 - 50]).toBe(2)
    expect(scoreCounts[100 - 50]).toBe(1)
  })

  it('counts boards like the Sources page and finds the ones due now', async () => {
    const env = await makeTestEnv()
    const { ctx } = env
    const board = (token: string, o: { watch: boolean; blocked?: boolean; failures?: number; next?: Date }) => {
      const c = ctx.companies.save({ name: `Co ${token}`, ats: 'greenhouse', atsToken: token, watch: o.watch, blocked: o.blocked ?? false })
      ctx.boards.ensureState(c.id)
      ctx.db.run('UPDATE board_state SET failures = :f, next_check_at = :n WHERE company_id = :id', {
        id: c.id,
        f: o.failures ?? 0,
        n: (o.next ?? new Date(Date.now() + DAY)).toISOString()
      })
    }
    board('ok-later', { watch: true })
    board('ok-due', { watch: true, next: new Date(Date.now() - HOUR) })
    board('flaky', { watch: true, failures: 2, next: new Date(Date.now() - HOUR) })
    board('dead', { watch: false, failures: 5 })
    board('blocked-due', { watch: true, blocked: true, next: new Date(Date.now() - HOUR) })
    board('unwatched-due', { watch: false, next: new Date(Date.now() - HOUR) })
    expect(getAnalytics(ctx, 7).boards).toEqual({ watched: 3, failing: 1, stopped: 1, dueNow: 2 })
  })

  it('reports requests and spend today for each provider against its daily limit', async () => {
    const env = await makeTestEnv({ provider: false })
    const { ctx } = env
    const free = await ctx.providers.save({ kind: 'gemini', label: 'Gemini free', apiKey: 'k', requestsPerDay: 1000 })
    const paid = await ctx.providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'k' })
    const idle = await ctx.providers.save({ kind: 'openai', label: 'Idle', apiKey: 'k' })
    const call = (providerId: string, cost: number, o: { hit?: boolean; ageMs?: number } = {}) => {
      seedCall(env, { task: 'triage', tokens: 10, cost, hit: o.hit, ageMs: o.ageMs ?? earlierToday() })
      ctx.db.run('UPDATE llm_calls SET provider_id = :p WHERE rowid = (SELECT MAX(rowid) FROM llm_calls)', { p: providerId })
    }
    call(free.id, 0)
    call(free.id, 0)
    call(free.id, 0, { hit: true })
    call(paid.id, 0.25)
    call(paid.id, 0.5, { ageMs: 2 * DAY })
    const { quota } = getAnalytics(ctx, 7)
    expect(quota).toEqual([
      { providerId: free.id, label: 'Gemini free', requestsToday: 2, requestsPerDay: 1000, costToday: 0 },
      { providerId: paid.id, label: 'Claude', requestsToday: 1, requestsPerDay: null, costToday: 0.25 },
      { providerId: idle.id, label: 'Idle', requestsToday: 0, requestsPerDay: null, costToday: 0 }
    ])
  })

  it('returns empty volume fields for an empty database', async () => {
    const { ctx } = await makeTestEnv({ provider: false })
    const r = getAnalytics(ctx, 7)
    const zero = { discovered: 0, filteredOut: 0, scored: 0, shortlisted: 0, prepared: 0, submitted: 0, needsAttention: 0, ready: 0, costUsd: 0 }
    expect(r.today).toEqual(zero)
    expect(r.week).toEqual(zero)
    expect(r.sendsByHour).toHaveLength(24)
    expect(r.scoreHistogram.every((b) => b.count === 0)).toBe(true)
    expect(r.boards).toEqual({ watched: 0, failing: 0, stopped: 0, dueNow: 0 })
    expect(r.quota).toEqual([])
    expect(r.totals).toEqual({ submitted: 0, responses: 0, needsAttention: 0, ready: 0 })
  })
})
