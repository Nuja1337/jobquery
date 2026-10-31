import type {
  AnalyticsReport,
  ApplicationOutcome,
  CountByKey,
  FitAssessment,
  FitBucket,
  LlmTask,
  SourceKind
} from '@shared/types'
import type { AppContext } from './context'
import { RESPONSE_OUTCOMES } from './db/repos/applications'
import { parseJson } from './db/database'
import { costOf, priceFor } from './llm/pricing'
import { groupReason } from './pipeline/filters'

const DAY_MS = 86_400_000
const FALLBACK_TRIAGE_TOKENS = 2500
const BUCKETS: FitBucket[] = ['perfect', 'great', 'good', 'weak']
/** Reached an interview or further. */
const INTERVIEW_OUTCOMES: ApplicationOutcome[] = ['interview', 'offer', 'accepted']
const OFFER_OUTCOMES: ApplicationOutcome[] = ['offer', 'accepted']

function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function keyOf(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? dateKey(new Date(t)) : null
}

function top(counts: Map<string, { label: string; n: number }>, limit: number): CountByKey[] {
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((c) => ({ key: c.label, count: c.n }))
}

function bump(map: Map<string, { label: string; n: number }>, label: string, id = label.trim().toLowerCase()): void {
  if (!id) return
  const entry = map.get(id)
  if (entry) entry.n += 1
  else map.set(id, { label: label.trim(), n: 1 })
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

interface JobRow {
  source: SourceKind
  stage: string
  discovered_at: string
  fit_score: number | null
  fit_json: string | null
  filter_reason: string | null
  /** Set when the job has an application. */
  application_id: string | null
  submitted_at: string | null
  outcome: ApplicationOutcome | null
}

interface AppRow {
  job_id: string
  created_at: string
  submitted_at: string | null
  outcome: ApplicationOutcome
  outcome_at: string | null
  source: SourceKind
  fit_bucket: FitBucket | null
  discovered_at: string
}

interface CallRow {
  at: string
  task: LlmTask
  model: string
  job_id: string | null
  tokens: number
  cost_usd: number
  cache_hit: number
}

/** Everything the Analytics screen shows, for the last `rangeDays` days including today. */
export function getAnalytics(ctx: AppContext, rangeDays: number): AnalyticsReport {
  const days = Math.max(1, Math.floor(rangeDays))
  const { thresholds, prices } = ctx.settings.get()
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const from = new Date(startOfToday.getTime() - (days - 1) * DAY_MS)
  // Walk by calendar day so daylight saving changes don't skip or repeat a day.
  const dayKeys: string[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(from)
    d.setDate(from.getDate() + i)
    dayKeys.push(dateKey(d))
  }
  const since = from.toISOString()

  // The funnel follows the jobs discovered in the range, so a later step can never be larger than an earlier one.
  const jobs = ctx.db.all<JobRow>(
    `SELECT j.source, j.stage, j.discovered_at, j.fit_score, j.fit_json, j.filter_reason,
       a.id AS application_id, a.submitted_at, a.outcome
     FROM jobs j LEFT JOIN applications a ON a.job_id = j.id WHERE j.discovered_at >= :since`,
    { since }
  )
  // Dismissals are counted by the day they happened, whenever the job was found.
  const dismissedRows = ctx.db.all<{ dismiss_tags: string }>("SELECT dismiss_tags FROM jobs WHERE stage = 'dismissed' AND dismissed_at >= :since", { since })
  const submitted = ctx.db.all<AppRow>(
    `SELECT a.job_id, a.created_at, a.submitted_at, a.outcome, a.outcome_at, j.source, j.fit_bucket, j.discovered_at
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.submitted_at >= :since`,
    { since }
  )
  const calls = ctx.db.all<CallRow>(
    `SELECT at, task, model, job_id, input_tokens + output_tokens + cached_input_tokens AS tokens, cost_usd, cache_hit
     FROM llm_calls WHERE at >= :since`,
    { since }
  )
  const paidCalls = calls.filter((c) => c.cache_hit === 0)

  // Funnel. Each job counts at the furthest step it reached. A job with an application got at least
  // as far as the shortlist, even when the user prepared it without a score.
  const isResponse = (a: Pick<AppRow, 'outcome'>) => RESPONSE_OUTCOMES.includes(a.outcome)
  const count = (stage: string) => jobs.filter((j) => j.stage === stage).length
  const withApplication = jobs.filter((j) => j.application_id !== null)
  const sent = withApplication.filter((j) => j.submitted_at !== null)
  const outcomeOf = (j: JobRow): ApplicationOutcome => j.outcome ?? 'none'
  const funnel: AnalyticsReport['funnel'] = {
    discovered: jobs.length,
    filteredOut: count('filtered_out'),
    prescoredOut: count('prescored_out'),
    duplicates: count('duplicate'),
    scored: jobs.filter((j) => j.fit_score !== null || j.application_id !== null).length,
    shortlisted: jobs.filter((j) => (j.fit_score !== null && j.fit_score >= thresholds.shortlistScore) || j.application_id !== null).length,
    dismissed: count('dismissed'),
    prepared: withApplication.length,
    submitted: sent.length,
    responses: sent.filter((j) => isResponse({ outcome: outcomeOf(j) })).length,
    interviews: sent.filter((j) => INTERVIEW_OUTCOMES.includes(outcomeOf(j))).length,
    offers: sent.filter((j) => OFFER_OUTCOMES.includes(outcomeOf(j))).length
  }

  // Daily rows, zeros filled in
  const daily = new Map(dayKeys.map((date) => [date, { date, discovered: 0, submitted: 0, costUsd: 0, tokens: 0 }]))
  for (const j of jobs) {
    const row = daily.get(keyOf(j.discovered_at) ?? '')
    if (row) row.discovered += 1
  }
  for (const a of submitted) {
    const row = daily.get(keyOf(a.submitted_at) ?? '')
    if (row) row.submitted += 1
  }
  for (const c of paidCalls) {
    const row = daily.get(keyOf(c.at) ?? '')
    if (row) {
      row.costUsd += c.cost_usd
      row.tokens += c.tokens
    }
  }

  // Outcomes by fit bucket and by source
  const byBucket = new Map<FitBucket, { bucket: FitBucket; submitted: number; responses: number; interviews: number }>(
    BUCKETS.map((bucket) => [bucket, { bucket, submitted: 0, responses: 0, interviews: 0 }])
  )
  const bySource = new Map<SourceKind, { source: SourceKind; submitted: number; responses: number; interviews: number }>()
  for (const a of submitted) {
    type Tally = { submitted: number; responses: number; interviews: number }
    const targets: Array<Tally | undefined> = [a.fit_bucket ? byBucket.get(a.fit_bucket) : undefined]
    let s = bySource.get(a.source)
    if (!s) bySource.set(a.source, (s = { source: a.source, submitted: 0, responses: 0, interviews: 0 }))
    targets.push(s)
    for (const t of targets) {
      if (!t) continue
      t.submitted += 1
      if (isResponse(a)) t.responses += 1
      if (INTERVIEW_OUTCOMES.includes(a.outcome)) t.interviews += 1
    }
  }

  // Cost by task and by model (calls answered from the cache cost nothing and aren't counted as calls)
  const task = new Map<LlmTask, { task: LlmTask; costUsd: number; tokens: number; calls: number }>()
  const model = new Map<string, { model: string; costUsd: number; tokens: number; calls: number }>()
  for (const c of paidCalls) {
    const t = task.get(c.task) ?? { task: c.task, costUsd: 0, tokens: 0, calls: 0 }
    t.costUsd += c.cost_usd
    t.tokens += c.tokens
    t.calls += 1
    task.set(c.task, t)
    const m = model.get(c.model) ?? { model: c.model, costUsd: 0, tokens: 0, calls: 0 }
    m.costUsd += c.cost_usd
    m.tokens += c.tokens
    m.calls += 1
    model.set(c.model, m)
  }

  // Score distribution, gaps and matches
  const ranges = Array.from({ length: 10 }, (_, i) => ({ range: i === 9 ? '90-100' : `${i * 10}-${i * 10 + 9}`, count: 0 }))
  const gaps = new Map<string, { label: string; n: number }>()
  const matches = new Map<string, { label: string; n: number }>()
  for (const j of jobs) {
    if (j.fit_score === null) continue
    ranges[Math.min(9, Math.floor(j.fit_score / 10))].count += 1
    const fit = parseJson<FitAssessment | null>(j.fit_json, null)
    fit?.gaps.forEach((g) => bump(gaps, g))
    fit?.matches.forEach((m) => bump(matches, m))
  }

  // Dismissals and filters
  const dismissed = new Map<string, { label: string; n: number }>()
  for (const row of dismissedRows) {
    const tags = parseJson<string[]>(row.dismiss_tags, [])
    if (tags.length === 0) bump(dismissed, 'other')
    else tags.forEach((t) => bump(dismissed, t))
  }
  const filters = new Map<string, { label: string; n: number }>()
  for (const j of jobs) {
    if (j.stage === 'filtered_out' || j.stage === 'prescored_out') bump(filters, groupReason(j.filter_reason ?? 'unknown reason'))
  }

  // Token savings: what the free rules kept away from the AI
  const avg = averageTriageCall(ctx, prices)
  const skipped = funnel.filteredOut + funnel.prescoredOut + funnel.duplicates

  // Averages
  // All AI spend in the range, including scoring of jobs that were never applied to, per application sent in the range.
  const totalSpend = paidCalls.reduce((sum, c) => sum + c.cost_usd, 0)
  const hours = submitted.map((a) => (Date.parse(a.submitted_at!) - Date.parse(a.discovered_at)) / 3_600_000).filter((h) => Number.isFinite(h) && h >= 0)
  const responseDays = submitted
    .filter((a) => isResponse(a) && a.outcome_at && a.submitted_at)
    .map((a) => (Date.parse(a.outcome_at!) - Date.parse(a.submitted_at!)) / DAY_MS)
    .filter((d) => Number.isFinite(d) && d >= 0)

  return {
    rangeDays: days,
    funnel,
    daily: dayKeys.map((k) => daily.get(k)!),
    outcomesByBucket: BUCKETS.map((b) => byBucket.get(b)!),
    outcomesBySource: [...bySource.values()].sort((a, b) => b.submitted - a.submitted),
    costByTask: [...task.values()].sort((a, b) => b.costUsd - a.costUsd),
    costByModel: [...model.values()].sort((a, b) => b.costUsd - a.costUsd),
    scoreDistribution: ranges,
    topGaps: top(gaps, 10),
    topMatches: top(matches, 10),
    dismissReasons: top(dismissed, 10),
    filterReasons: top(filters, 15),
    tokenSavings: {
      jobsSkippedFree: skipped,
      estimatedTokensSaved: Math.round(skipped * avg.tokens),
      estimatedUsdSaved: skipped * avg.usd,
      cacheHits: calls.filter((c) => c.cache_hit === 1).length
    },
    averages: {
      costPerApplicationUsd: submitted.length ? totalSpend / submitted.length : null,
      hoursDiscoveryToApply: average(hours),
      daysToFirstResponse: average(responseDays)
    }
  }
}

/** The average real triage call so far, or an estimate when there are none yet. */
function averageTriageCall(ctx: AppContext, prices: Parameters<typeof priceFor>[1]): { tokens: number; usd: number } {
  const row = ctx.db.get<{ n: number; tokens: number | null; usd: number | null }>(
    `SELECT COUNT(*) AS n, AVG(input_tokens + output_tokens + cached_input_tokens) AS tokens, AVG(cost_usd) AS usd
     FROM llm_calls WHERE task = 'triage' AND cache_hit = 0 AND ok = 1`
  )
  if (row && row.n > 0 && row.tokens) return { tokens: row.tokens, usd: row.usd ?? 0 }
  let usd = 0
  try {
    const ref = ctx.llm.resolveModel('triage')
    // Roughly 85 percent of a triage call is input.
    usd = costOf(
      { inputTokens: Math.round(FALLBACK_TRIAGE_TOKENS * 0.85), outputTokens: Math.round(FALLBACK_TRIAGE_TOKENS * 0.15), cacheReadTokens: 0, cacheWriteTokens: 0 },
      priceFor(ref.model, prices)
    )
  } catch {
    // No model set up yet, so there is no price to estimate with.
  }
  return { tokens: FALLBACK_TRIAGE_TOKENS, usd }
}
