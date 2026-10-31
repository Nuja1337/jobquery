import type {
  Job,
  JobStage,
  PipelinePhase,
  PipelineProgress,
  RunOptions,
  RunStats,
  SourceKind,
  SubmitResult
} from '@shared/types'
import type { AppContext } from '../context'
import { SEARCH_SOURCES } from '../db/repos/jobs'
import { emptyStats } from '../db/repos/runs'
import { BudgetExceededError, RateLimitedError } from '../llm/errors'
import { type TaskProvider, defaultTasks } from '../sources'
import { mapLimit } from '../sources/http'
import {
  applyFree,
  buildFreeEnv,
  freeFingerprint,
  getMeta,
  ingestJob,
  ingestRaw,
  restageForShortlist,
  reviveDuplicatesOfClosed,
  setMeta,
  shortlistNeedsRestage
} from './ingest'
import { triageJobs } from './triage'

export { ingestJob, restageForShortlist }

/** Prepare and submit are built elsewhere and plugged in here. */
export interface PipelineHooks {
  prepare?: (jobId: string) => Promise<void>
  submit?: (applicationId: string) => Promise<SubmitResult>
}

const IDLE: PipelineProgress = { runId: null, phase: 'idle', message: 'Idle', done: 0, total: 0 }
const DISCOVERY_CONCURRENCY = 3
const FINGERPRINT_KEY = 'free_filter_fingerprint'

function startOfToday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export class Pipeline {
  private running = false
  private abort: AbortController | null = null
  private progress: PipelineProgress = IDLE
  /** Set once the run has written its rate limit note. */
  private rateLimitNoted = false

  constructor(
    private readonly ctx: AppContext,
    private hooks: PipelineHooks = {},
    private readonly tasks: TaskProvider = defaultTasks
  ) {}

  /** Plugs in the prepare and submit steps once they exist. */
  setHooks(hooks: PipelineHooks): void {
    this.hooks = hooks
  }

  status(): PipelineProgress {
    return this.progress
  }

  isRunning(): boolean {
    return this.running
  }

  /** Stops after the item in progress. The run still saves its stats. */
  cancel(): void {
    this.abort?.abort()
  }

  private setProgress(phase: PipelinePhase, message: string, done = 0, total = 0): void {
    this.progress = { runId: this.progress.runId, phase, message, done, total }
    this.ctx.emit('pipeline:progress', this.progress)
  }

  async run(options: RunOptions = {}): Promise<RunStats> {
    if (this.running) throw new Error('A run is already in progress.')
    this.running = true
    this.rateLimitNoted = false
    this.abort = new AbortController()
    const signal = this.abort.signal
    const { ctx } = this
    const trigger = options.trigger ?? 'manual'
    const record = ctx.runs.start(trigger)
    const stats = emptyStats()
    this.progress = { ...IDLE, runId: record.id }
    ctx.events.add('run_started', trigger === 'schedule' ? 'Scheduled run started.' : 'Run started.', null, { runId: record.id })

    try {
      if (options.discover !== false) await this.discover(stats, signal)
      if (!signal.aborted) this.filter(stats)
      if (!signal.aborted && options.triage !== false) await this.triage(stats, signal)
      if (!signal.aborted && options.prepare) await this.prepare(stats, signal)
      if (!signal.aborted && options.submit) await this.submit(stats, signal)

      this.addSpend(stats, record.startedAt)
      ctx.runs.finish(record.id, stats)
      const summary = `${plural(stats.newJobs, 'new job')}, ${stats.shortlisted} shortlisted, ${stats.prepared} prepared, ${stats.submitted} submitted. Spent $${stats.costUsd.toFixed(3)}.`
      ctx.events.add('run_finished', `${signal.aborted ? 'Run stopped. ' : 'Run finished. '}${summary}`, null, { runId: record.id, ...stats })
      return stats
    } catch (err) {
      stats.errors += 1
      this.addSpend(stats, record.startedAt)
      ctx.runs.finish(record.id, stats, (err as Error).message)
      ctx.events.add('error', `The run stopped. ${(err as Error).message}`, null, { runId: record.id })
      throw err
    } finally {
      this.running = false
      this.abort = null
      this.progress = IDLE
      ctx.emit('pipeline:progress', IDLE)
    }
  }

  private addSpend(stats: RunStats, sinceIso: string): void {
    const row = this.ctx.db.get<{ usd: number | null; tokens: number | null }>(
      `SELECT SUM(cost_usd) AS usd, SUM(input_tokens + output_tokens + cached_input_tokens) AS tokens
       FROM llm_calls WHERE at >= :since AND cache_hit = 0`,
      { since: sinceIso }
    )
    stats.costUsd = row?.usd ?? 0
    stats.tokens = row?.tokens ?? 0
  }

  // -------------------------------------------------------------------------
  // Discover and ingest
  // -------------------------------------------------------------------------

  private async discover(stats: RunStats, signal: AbortSignal): Promise<void> {
    const { ctx } = this
    const tasks = this.tasks(ctx)
    if (tasks.length === 0) return
    let done = 0
    /** Jobs that closed during discovery, for the duplicate re-check afterwards. */
    const closedIds: string[] = []
    /** Search sources that answered in this run. Only these may close jobs nobody lists any more. */
    const answeredSearches = new Set<SourceKind>()
    this.setProgress('discovering', `Checking ${plural(tasks.length, 'source')}`, 0, tasks.length)
    await mapLimit(tasks, DISCOVERY_CONCURRENCY, async (task) => {
      if (signal.aborted) return
      const changed: string[] = []
      try {
        const result = await task.run(signal)
        for (const raw of result.jobs) {
          stats.discovered += 1
          try {
            const r = ingestRaw(ctx, raw)
            if (r.duplicate) stats.duplicates += 1
            else if (r.isNew) stats.newJobs += 1
            if (r.isNew) changed.push(r.job.id)
          } catch (err) {
            stats.errors += 1
            if (stats.errors <= 3) ctx.events.add('error', `Could not store "${raw.title}" from ${task.name}: ${(err as Error).message}`)
          }
        }
        if (task.board && result.complete !== false) {
          const closed = ctx.jobs.markClosedMissing(task.board.source, task.board.atsToken, result.jobs.map((j) => j.externalId))
          closedIds.push(...closed)
          changed.push(...closed)
        }
        if (task.searchId) ctx.searches.markRun(task.searchId)
        if (task.searchSource && result.jobs.length > 0) answeredSearches.add(task.searchSource)
      } catch (err) {
        if (!signal.aborted) {
          stats.errors += 1
          ctx.events.add('error', `Could not read ${task.name}: ${(err as Error).message}`)
        }
      }
      if (changed.length) ctx.emit('jobs:changed', { jobIds: changed })
      done += 1
      this.setProgress('discovering', `Checked ${done} of ${plural(tasks.length, 'source')}`, done, tasks.length)
    })
    // Saved searches have no board to compare against. A job no search has returned for 30 days is gone.
    const sources = SEARCH_SOURCES.filter((source) => answeredSearches.has(source))
    const stale = ctx.jobs.closeUnseenSearchJobs(sources)
    closedIds.push(...stale)
    // A repost under a new id may have been stored as a duplicate of a job that has just closed.
    const revived = reviveDuplicatesOfClosed(ctx, closedIds)
    const touched = [...stale, ...revived]
    if (touched.length) ctx.emit('jobs:changed', { jobIds: touched })
    if (stats.discovered > 0) {
      ctx.events.add(
        'discovered',
        `Found ${plural(stats.discovered, 'posting')}. ${stats.newJobs} ${stats.newJobs === 1 ? 'is' : 'are'} new${stats.duplicates ? ` and ${stats.duplicates} already appeared on another board` : ''}.`
      )
    }
  }

  // -------------------------------------------------------------------------
  // Free filters and keyword pre-score
  // -------------------------------------------------------------------------

  private filter(stats: RunStats): void {
    const { ctx } = this
    const env = buildFreeEnv(ctx)
    const fingerprint = freeFingerprint(env)
    // A changed shortlist score moves scored jobs across the line and refreshes their bucket.
    if (shortlistNeedsRestage(ctx)) restageForShortlist(ctx)
    // Jobs dropped earlier get a second look when a setting or the profile changed.
    const settingsChanged = getMeta(ctx.db, FINGERPRINT_KEY) !== fingerprint
    const stages: JobStage[] = settingsChanged ? ['new', 'filtered_out', 'prescored_out'] : ['new']
    const jobs = ctx.jobs.listByStage(stages)
    // A job dropped because of a recent application is let back in once the cooldown ends, which no
    // setting change signals. Checking it is free, so it runs every time.
    if (!settingsChanged) jobs.push(...ctx.jobs.listCooldownFiltered())
    if (jobs.length === 0) {
      setMeta(ctx.db, FINGERPRINT_KEY, fingerprint)
      return
    }
    this.setProgress('filtering', `Checking ${plural(jobs.length, 'job')} against your filters`, 0, jobs.length)
    const changed: string[] = []
    ctx.db.transaction(() => {
      for (const job of jobs) {
        const after = applyFree(ctx, job, env)
        if (after === job.stage) continue
        changed.push(job.id)
        if (after === 'filtered_out') stats.filteredOut += 1
        else if (after === 'prescored_out') stats.prescoredOut += 1
      }
    })
    setMeta(ctx.db, FINGERPRINT_KEY, fingerprint)
    if (stats.filteredOut + stats.prescoredOut > 0) {
      ctx.events.add(
        'filtered',
        `Skipped ${plural(stats.filteredOut + stats.prescoredOut, 'job')} without using the AI. ${stats.filteredOut} failed a filter and ${stats.prescoredOut} had too little keyword overlap with your profile.`
      )
    }
    if (changed.length) ctx.emit('jobs:changed', { jobIds: changed })
  }

  // -------------------------------------------------------------------------
  // AI fit scoring
  // -------------------------------------------------------------------------

  private async triage(stats: RunStats, signal: AbortSignal): Promise<void> {
    const { ctx } = this
    const { budget } = ctx.settings.get()
    // A job whose scoring failed three times with this profile waits for a profile change or "Score now".
    const jobs = ctx.jobs.listByStage('new', { orderBy: 'prescore', limit: budget.maxTriagePerRun, skipRepeatedTriageFailures: true })
    if (jobs.length === 0) return

    // The budget limits money spent. A free or local scoring model is not held back by it.
    const status = ctx.llm.isFreeStage('triage') ? { ok: true, reason: null } : ctx.llm.budgetStatus()
    if (!status.ok) {
      stats.stoppedForBudget = true
      ctx.events.add('budget_stop', `${status.reason} ${plural(jobs.length, 'job')} waiting to be scored.`)
      return
    }
    if (!ctx.llm.isConfigured()) {
      stats.errors += 1
      ctx.events.add('error', `No AI model is set up, so ${plural(jobs.length, 'job')} could not be scored. Add one in Settings.`)
      return
    }

    this.setProgress('scoring', `Scoring ${plural(jobs.length, 'job')}`, 0, jobs.length)
    const result = await triageJobs(ctx, jobs, {
      signal,
      onProgress: (done, total) => this.setProgress('scoring', `Scored ${done} of ${total}`, done, total)
    })
    stats.scored += result.scored
    stats.shortlisted += result.shortlisted
    stats.errors += result.errors + (result.noModel ? 1 : 0)
    for (const message of result.errorMessages) ctx.events.add('error', `Scoring problem. ${message}`)
    if (result.stoppedForBudget) {
      stats.stoppedForBudget = true
      ctx.events.add('budget_stop', `${result.budgetMessage} Scoring stopped after ${plural(result.scored, 'job')}.`, null, { scored: result.scored })
    }
    if (result.stoppedForRateLimit) {
      stats.stoppedForRateLimit = true
      this.addRateLimitStop(jobs.length - result.scored - result.errors, 'job', result.rateLimitMessage)
    }
    if (result.scored > 0) {
      ctx.events.add('scored', `Scored ${plural(result.scored, 'job')}. ${result.shortlisted} made the shortlist.`)
    }
    ctx.emit('jobs:changed', { jobIds: jobs.map((j) => j.id) })
  }

  /** Adds the one calm note per run about a provider limit. Later stops in the same run add nothing. */
  private addRateLimitStop(waiting: number, noun: string, detail: string | null, jobId?: string): void {
    if (this.rateLimitNoted) return
    this.rateLimitNoted = true
    const count = Math.max(0, waiting)
    this.ctx.events.add(
      'rate_limit_stop',
      `Your AI provider's limit was reached, so ${plural(count, noun)} ${count === 1 ? 'waits' : 'wait'} for a later run.${detail ? ` ${detail}` : ''}`,
      jobId ?? null,
      { waiting: count }
    )
  }

  // -------------------------------------------------------------------------
  // Prepare and submit, through hooks
  // -------------------------------------------------------------------------

  private async prepare(stats: RunStats, signal: AbortSignal): Promise<void> {
    const { ctx } = this
    const { autopilot, thresholds, budget } = ctx.settings.get()
    if (!autopilot.autoPrepare || !this.hooks.prepare) return
    const jobs: Job[] = ctx.jobs
      .listByStage('shortlisted', { orderBy: 'fit' })
      .filter((j) => !j.applicationId && (j.fit?.score ?? 0) >= thresholds.autoPrepareScore)
      // A posting no source has listed for a month is probably gone. Don't spend the writing model on it.
      .filter((j) => !ctx.jobs.isUnseen(j.id))
      .slice(0, budget.maxPreparePerRun)
    if (jobs.length === 0) return
    this.setProgress('preparing', `Preparing ${plural(jobs.length, 'application')}`, 0, jobs.length)
    let done = 0
    for (const job of jobs) {
      if (signal.aborted) break
      // The user may have prepared, dismissed or applied while this run was going.
      const fresh = ctx.jobs.get(job.id)
      if (!fresh || fresh.stage !== 'shortlisted' || ctx.applications.getByJob(job.id)) {
        done += 1
        continue
      }
      try {
        await this.hooks.prepare(job.id)
        stats.prepared += 1
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          stats.stoppedForBudget = true
          ctx.events.add('budget_stop', `${err.message} Preparing stopped after ${plural(stats.prepared, 'application')}.`, job.id)
          break
        }
        if (err instanceof RateLimitedError) {
          stats.stoppedForRateLimit = true
          this.addRateLimitStop(jobs.length - done, 'application', err.message, job.id)
          break
        }
        stats.errors += 1
        ctx.events.add('error', `Could not prepare ${job.title} at ${job.company}: ${(err as Error).message}`, job.id)
      }
      done += 1
      this.setProgress('preparing', `Prepared ${done} of ${jobs.length}`, done, jobs.length)
    }
    ctx.emit('jobs:changed', { jobIds: jobs.map((j) => j.id) })
  }

  private async submit(stats: RunStats, signal: AbortSignal): Promise<void> {
    const { ctx } = this
    const { autopilot, thresholds } = ctx.settings.get()
    if (!autopilot.autoSubmit || !this.hooks.submit) return
    const left = autopilot.dailySubmitCap - ctx.applications.countSubmittedSince(startOfToday())
    if (left <= 0) {
      ctx.events.add('submitted', `Daily limit of ${autopilot.dailySubmitCap} applications reached, so nothing more was sent today.`)
      return
    }
    const ready = ctx.applications
      .listReady()
      .filter((a) => (a.fitScore ?? 0) >= thresholds.autoSubmitScore && a.flaggedCount === 0 && a.guessCount === 0)
      .slice(0, left)
    if (ready.length === 0) return
    this.setProgress('submitting', `Submitting ${plural(ready.length, 'application')}`, 0, ready.length)
    let done = 0
    for (const app of ready) {
      if (signal.aborted) break
      // Check again right before sending. The user may have edited, withdrawn or dismissed it,
      // turned auto-submit off, or the daily cap may have been reached by a manual submit.
      const now = ctx.settings.get()
      const current = ctx.applications.get(app.id)
      const job = current ? ctx.jobs.get(current.jobId) : null
      const sentToday = ctx.applications.countSubmittedSince(startOfToday())
      if (
        !now.autopilot.autoSubmit ||
        sentToday >= now.autopilot.dailySubmitCap ||
        !current ||
        !job ||
        current.status !== 'ready' ||
        job.stage !== 'ready' ||
        current.flaggedCount > 0 ||
        current.guessCount > 0 ||
        (job.fit?.score ?? 0) < now.thresholds.autoSubmitScore
      ) {
        done += 1
        continue
      }
      try {
        const result = await this.hooks.submit(app.id)
        if (result.ok && result.status === 'submitted') stats.submitted += 1
        else if (!result.ok) stats.errors += 1
      } catch (err) {
        stats.errors += 1
        ctx.events.add('submit_failed', `Could not submit ${app.title} at ${app.company}: ${(err as Error).message}`, app.jobId)
      }
      done += 1
      this.setProgress('submitting', `Submitted ${done} of ${ready.length}`, done, ready.length)
    }
    ctx.emit('applications:changed', { applicationIds: ready.map((a) => a.id) })
    ctx.emit('jobs:changed', { jobIds: ready.map((a) => a.jobId) })
  }
}
