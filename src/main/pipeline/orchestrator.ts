import type {
  Job,
  JobStage,
  PauseHint,
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
import { applyUrlFor } from '../apply/prepare'
import { BudgetExceededError, NoModelConfiguredError, RateLimitedError, isProviderError } from '../llm/errors'
import { type DiscoveryTask, type TaskProvider, defaultTasks } from '../sources'
import { HttpError, hostPauseUntil, mapLimit } from '../sources/http'
import {
  applyFree,
  buildFreeEnv,
  freeFingerprint,
  getMeta,
  ingestJob,
  ingestRaw,
  noteStartedWatching,
  restageForShortlist,
  reviveDuplicatesOfClosed,
  setMeta,
  shortlistNeedsRestage
} from './ingest'
import { normalizeCompany } from './dedupe'
import { triageJobs } from './triage'

export { ingestJob, restageForShortlist }

/** Prepare and submit are built elsewhere and plugged in here. */
export interface PipelineHooks {
  prepare?: (jobId: string) => Promise<void>
  submit?: (applicationId: string) => Promise<SubmitResult>
}

/** The longest one application may take to prepare or to fill and send before the run moves on. */
export const PREPARE_TIME_LIMIT_MS = 10 * 60_000
export const SUBMIT_TIME_LIMIT_MS = 15 * 60_000
/** Provider errors in a row before the prepare phase stops, the same policy as scoring. */
const MAX_PROVIDER_ERRORS = 3
/** Hook exceptions in a row (no browser, a page that won't load) before the submit loop stops. */
const MAX_CONSECUTIVE_SUBMIT_EXCEPTIONS = 2
const DAY_MS = 86_400_000
/** How long a worker waits after the provider or the browser failed several times in a row. */
export const PROVIDER_PAUSE_MS = 15 * 60_000
const CAPTCHA = /captcha/i
/** The message the submitter gives for a page that asks the person to sign in first. */
const SIGN_IN_WALL = /wants you to sign in|sign in to (apply|continue)|log in to (apply|continue)/i

/** What a step did. `did` is how many items it finished, and 0 means it found nothing to do. */
export interface StepOutcome {
  /** The counts this step added. A run adds them into its own totals. */
  stats: RunStats
  did: number
  /** Set when the step stopped early and its worker should wait. */
  pause: PauseHint | null
}

/** One application the submit step tried. */
export interface SubmitAttempt {
  applicationId: string
  jobId: string
  /** The job's form family, such as lever or greenhouse. */
  family: string
  result: 'sent' | 'clicked' | 'captcha' | 'sign_in' | 'failed' | 'other'
}

export interface SubmitOutcome extends StepOutcome {
  attempts: SubmitAttempt[]
}

export interface SubmitStepOptions {
  /** Stop after this many applications were tried. */
  maxAttempts?: number
  /** Form families to leave out, for example one that is paused or at its hourly cap. */
  skipFamilies?: ReadonlySet<string>
  /** Called by the work loop: no summary event for skipped applications, and fewer change pushes. */
  loop?: boolean
}

/** An application the submit step is working on right now. */
export interface SubmitClaim {
  company: string
  form: string
  family: string
}

function outcome(stats: RunStats, did: number, pause: PauseHint | null = null): StepOutcome {
  return { stats, did, pause }
}

/** Adds the counts of one step into a run's totals. */
export function addStats(into: RunStats, from: RunStats): void {
  for (const key of Object.keys(from) as Array<keyof RunStats>) {
    const value = from[key]
    if (typeof value === 'number') (into[key] as number) += value
    else if (value) (into[key] as boolean) = true
  }
}

/** The next local midnight after the given time, as epoch milliseconds. */
export function nextLocalMidnight(fromMs: number = Date.now()): number {
  const d = new Date(fromMs)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

export function budgetPause(message: string | null): PauseHint {
  return { kind: 'budget', until: new Date(nextLocalMidnight()).toISOString(), message: message ?? 'The AI budget is used up.' }
}

/** Waits as long as the provider asked, or until the next local midnight when it only said the daily limit was reached. */
export function rateLimitPause(message: string | null, retryAfterMs: number | null): PauseHint {
  const until = retryAfterMs !== null ? Date.now() + Math.max(retryAfterMs, 1000) : nextLocalMidnight()
  return { kind: 'rate_limit', until: new Date(until).toISOString(), message: message ?? "Your AI provider's limit was reached." }
}

export function providerPause(message: string): PauseHint {
  return { kind: 'provider_errors', until: new Date(Date.now() + PROVIDER_PAUSE_MS).toISOString(), message }
}

/** A hook ran past its time limit. */
class TimeLimitError extends Error {}

function withLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeLimitError('Timed out.')), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

/** Lowercase, no query string or fragment, no trailing slash, so two links to one form compare equal. */
export function normalizeApplyUrl(url: string): string {
  return url.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '')
}

const IDLE: PipelineProgress = { runId: null, phase: 'idle', message: 'Idle', done: 0, total: 0 }
/** Tasks in flight at once. At most one of them talks to any one host. */
const DISCOVERY_CONCURRENCY = 6
/** A board whose host asked us to wait is tried again no sooner than this. */
const DEFER_FALLBACK_MS = 15 * 60_000
/** Board failures that get their own line in the activity log. The rest are counted in one line. */
const BOARD_ERROR_EVENTS = 5
const FINGERPRINT_KEY = 'free_filter_fingerprint'

function startOfToday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/**
 * Runs fn over tasks with at most `limit` in flight and at most one per host. A task with no host
 * only counts toward the limit. Tasks start in order, except that one whose host is busy waits for the next free slot.
 */
async function runByHost(tasks: DiscoveryTask[], limit: number, fn: (task: DiscoveryTask) => Promise<void>): Promise<void> {
  const pending = [...tasks]
  const busy = new Set<string>()
  let active = 0
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (active < limit) {
        const index = pending.findIndex((t) => !t.host || !busy.has(t.host))
        if (index < 0) break
        const [task] = pending.splice(index, 1)
        if (task.host) busy.add(task.host)
        active += 1
        void fn(task)
          .catch(() => undefined)
          .finally(() => {
            if (task.host) busy.delete(task.host)
            active -= 1
            pump()
          })
      }
      if (active === 0 && pending.length === 0) resolve()
    }
    pump()
  })
}

const count = (n: number) => n.toLocaleString('en-US')

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export class Pipeline {
  private running = false
  private abort: AbortController | null = null
  private progress: PipelineProgress = IDLE
  /** Set once the run has written its rate limit note. */
  private rateLimitNoted = false
  /** Provider errors in a row in each AI step. They carry over between steps, so a loop taking small batches still counts them. */
  private scoreStreak = 0
  private prepareStreak = 0
  /** Submit hook exceptions in a row. */
  private submitStreak = 0
  /** Applications being filled right now. */
  private readonly claims = new Map<string, SubmitClaim>()
  private loop: { isRunning(): boolean } | null = null

  constructor(
    private readonly ctx: AppContext,
    private hooks: PipelineHooks = {},
    private readonly tasks: TaskProvider = defaultTasks,
    /** Overridden in tests. */
    private readonly limits = { prepareMs: PREPARE_TIME_LIMIT_MS, submitMs: SUBMIT_TIME_LIMIT_MS }
  ) {}

  /** Plugs in the prepare and submit steps once they exist. */
  setHooks(hooks: PipelineHooks): void {
    this.hooks = hooks
  }

  status(): PipelineProgress {
    return this.progress
  }

  /** True during a batch run and while the continuous work loop is on. */
  isRunning(): boolean {
    return this.running || (this.loop?.isRunning() ?? false)
  }

  /** The work loop registers itself, so its progress replaces the run's and isRunning() covers it. */
  attachLoop(loop: { isRunning(): boolean } | null): void {
    this.loop = loop
  }

  /** The work loop reports what it is doing here, so status() and the progress push match. */
  publish(progress: PipelineProgress): void {
    this.progress = progress
    this.ctx.emit('pipeline:progress', progress)
  }

  /** Stops after the item in progress. The run still saves its stats. */
  cancel(): void {
    this.abort?.abort()
  }

  private setProgress(phase: PipelinePhase, message: string, done = 0, total = 0): void {
    // Steps run by the work loop stay quiet. The loop reports one line for all its workers.
    if (!this.running && this.loop?.isRunning()) return
    this.progress = { runId: this.progress.runId, phase, message, done, total }
    this.ctx.emit('pipeline:progress', this.progress)
  }

  async run(options: RunOptions = {}): Promise<RunStats> {
    if (this.isRunning()) throw new Error('A run is already in progress.')
    this.running = true
    this.rateLimitNoted = false
    this.scoreStreak = 0
    this.prepareStreak = 0
    this.submitStreak = 0
    this.abort = new AbortController()
    const signal = this.abort.signal
    const { ctx } = this
    const trigger = options.trigger ?? 'manual'
    const record = ctx.runs.start(trigger)
    const stats = emptyStats()
    this.progress = { ...IDLE, runId: record.id }
    ctx.events.add('run_started', trigger === 'schedule' ? 'Scheduled run started.' : 'Run started.', null, { runId: record.id })

    try {
      if (options.discover !== false) addStats(stats, (await this.discoverStep(signal, { allBoards: options.allBoards })).stats)
      if (!signal.aborted) addStats(stats, this.filterStep().stats)
      if (!signal.aborted && options.triage !== false) addStats(stats, (await this.scoreStep(ctx.settings.get().budget.maxTriagePerRun, signal)).stats)
      if (!signal.aborted && options.prepare) addStats(stats, (await this.prepareStep(ctx.settings.get().budget.maxPreparePerRun, 1, signal)).stats)
      if (!signal.aborted && options.submit) await this.submitPhase(stats, signal)

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

  /** Reads the boards and searches that are due and stores what they list. `did` is the number of sources read. */
  async discoverStep(signal: AbortSignal, options: { allBoards?: boolean } = {}): Promise<StepOutcome> {
    const { ctx } = this
    const stats = emptyStats()
    const tasks = this.tasks(ctx, { allBoards: options.allBoards })
    if (tasks.length === 0) return outcome(stats, 0)
    const boardTotal = tasks.filter((t) => t.board).length
    const otherTotal = tasks.length - boardTotal
    let done = 0
    let boardsDone = 0
    let unchanged = 0
    /** Boards left due because their host asked us to slow down. */
    let waiting = 0
    let boardErrors = 0
    let startedWatching = 0
    /** Jobs that closed during discovery, for the duplicate re-check afterwards. */
    const closedIds: string[] = []
    /** Search sources that answered in this run. Only these may close jobs nobody lists any more. */
    const answeredSearches = new Set<SourceKind>()
    const boardsLabel = (n: number) => `${count(n)} ${n === 1 ? 'board' : 'boards'}`
    const report = () => {
      const message =
        boardTotal === 0
          ? `Checked ${done} of ${plural(tasks.length, 'source')}`
          : `Checked ${count(boardsDone)} of ${boardsLabel(boardTotal)}, ${count(unchanged)} unchanged${otherTotal ? `, and ${done - boardsDone} of ${plural(otherTotal, 'search', 'searches')}` : ''}`
      this.setProgress('discovering', message, done, tasks.length)
    }
    this.setProgress(
      'discovering',
      boardTotal === 0
        ? `Checking ${plural(tasks.length, 'source')}`
        : `Checking ${boardsLabel(boardTotal)}${otherTotal ? ` and ${plural(otherTotal, 'search', 'searches')}` : ''}`,
      0,
      tasks.length
    )
    await runByHost(tasks, DISCOVERY_CONCURRENCY, async (task) => {
      if (signal.aborted) return
      const board = task.board
      // A host that told us to slow down is left alone. The board stays due for the next run.
      if (board && task.host && hostPauseUntil(task.host) !== null) {
        waiting += 1
        done += 1
        boardsDone += 1
        report()
        return
      }
      const changed: string[] = []
      try {
        const result = await task.run(signal)
        if (result.unchanged) {
          // The board answered 304 or sent the same list. Nothing is stored, closed or reopened.
          if (board) ctx.jobs.touchSeen(board.source, board.atsToken)
          unchanged += 1
        } else {
          for (const raw of result.jobs) {
            stats.discovered += 1
            try {
              const r = ingestRaw(ctx, raw)
              if (r.duplicate) stats.duplicates += 1
              else if (r.isNew) stats.newJobs += 1
              if (r.isNew) changed.push(r.job.id)
              if (r.startedWatching) startedWatching += 1
            } catch (err) {
              stats.errors += 1
              if (stats.errors <= 3) ctx.events.add('error', `Could not store "${raw.title}" from ${task.name}: ${(err as Error).message}`)
            }
          }
          if (board) {
            // Postings stored already were listed but not sent again. They count as seen and stay open.
            if (result.seenExternalIds?.length) ctx.jobs.touchSeen(board.source, board.atsToken, result.seenExternalIds)
            if (result.complete !== false) {
              const seen = [...result.jobs.map((j) => j.externalId), ...(result.seenExternalIds ?? [])]
              const closed = ctx.jobs.markClosedMissing(board.source, board.atsToken, seen)
              closedIds.push(...closed)
              changed.push(...closed)
            }
          }
        }
        if (board) {
          const rel = ctx.boards.relevance(board.source, board.atsToken)
          ctx.boards.recordCheck(board.companyId, {
            status: result.unchanged ? 304 : 200,
            etag: result.etag,
            lastModified: result.lastModified,
            listHash: result.listHash,
            jobCount: rel.live,
            relevantCount: rel.relevant,
            newRelevant: rel.newRelevant
          })
        }
        if (task.searchId) ctx.searches.markRun(task.searchId)
        if (task.searchSource && result.jobs.length > 0) answeredSearches.add(task.searchSource)
      } catch (err) {
        if (!signal.aborted) {
          const status = err instanceof HttpError ? err.status : null
          if (board && status === 429) {
            // Too many requests is the host's limit, not a broken board. Try again later without a failure.
            waiting += 1
            ctx.boards.recordCheck(board.companyId, {
              status,
              error: (err as Error).message,
              deferUntil: (err as HttpError).retryAt ?? Date.now() + DEFER_FALLBACK_MS
            })
          } else {
            stats.errors += 1
            const outcome = board ? ctx.boards.recordCheck(board.companyId, { status, error: (err as Error).message }) : null
            if (board) boardErrors += 1
            if (!board || boardErrors <= BOARD_ERROR_EVENTS) ctx.events.add('error', `Could not read ${task.name}: ${(err as Error).message}`)
            if (outcome?.unwatched) ctx.events.add('error', `Stopped watching ${task.name}: ${(err as Error).message}`)
          }
        }
      }
      if (changed.length) ctx.emit('jobs:changed', { jobIds: changed })
      done += 1
      if (board) boardsDone += 1
      report()
    })
    if (boardErrors > BOARD_ERROR_EVENTS) {
      const more = boardErrors - BOARD_ERROR_EVENTS
      ctx.events.add('error', `${count(more)} more ${more === 1 ? 'board' : 'boards'} could not be read.`)
    }
    if (waiting > 0) {
      ctx.events.add('discovered', `Left ${plural(waiting, 'board')} for a later run because the site asked us to slow down.`)
    }
    noteStartedWatching(ctx, startedWatching)
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
    return outcome(stats, done)
  }

  // -------------------------------------------------------------------------
  // Free filters and keyword pre-score
  // -------------------------------------------------------------------------

  /** Runs the free filters and the keyword pre-score. `did` is the number of jobs whose stage changed. */
  filterStep(): StepOutcome {
    const { ctx } = this
    const stats = emptyStats()
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
      return outcome(stats, 0)
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
    return outcome(stats, changed.length)
  }

  // -------------------------------------------------------------------------
  // AI fit scoring
  // -------------------------------------------------------------------------

  /**
   * Scores up to `limit` waiting jobs, best pre-score first. Stops early, with a pause hint, when the
   * budget runs out (a free scoring model is never held back by it), the provider's limit is reached,
   * no model is set up, or the provider keeps failing.
   */
  async scoreStep(limit: number, signal: AbortSignal): Promise<StepOutcome> {
    const { ctx } = this
    const stats = emptyStats()
    if (limit <= 0) return outcome(stats, 0)
    // A job whose scoring failed three times with this profile waits for a profile change or "Score now".
    const jobs = ctx.jobs.listByStage('new', { orderBy: 'prescore', limit, skipRepeatedTriageFailures: true })
    if (jobs.length === 0) return outcome(stats, 0)

    // The budget limits money spent. A free or local scoring model is not held back by it.
    const status = ctx.llm.isFreeStage('triage') ? { ok: true, reason: null } : ctx.llm.budgetStatus()
    if (!status.ok) {
      stats.stoppedForBudget = true
      ctx.events.add('budget_stop', `${status.reason} ${plural(jobs.length, 'job')} waiting to be scored.`)
      return outcome(stats, 0, budgetPause(status.reason))
    }
    if (!ctx.llm.isConfigured()) {
      stats.errors += 1
      ctx.events.add('error', `No AI model is set up, so ${plural(jobs.length, 'job')} could not be scored. Add one in Settings.`)
      return outcome(stats, 0, { kind: 'no_model', until: null, message: 'No AI model is set up.' })
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
    let pause: PauseHint | null = null
    if (result.stoppedForBudget) {
      stats.stoppedForBudget = true
      ctx.events.add('budget_stop', `${result.budgetMessage} Scoring stopped after ${plural(result.scored, 'job')}.`, null, { scored: result.scored })
      pause = budgetPause(result.budgetMessage)
    }
    if (result.stoppedForRateLimit) {
      stats.stoppedForRateLimit = true
      this.addRateLimitStop(jobs.length - result.scored - result.errors, 'job', result.rateLimitMessage)
      pause ??= rateLimitPause(result.rateLimitMessage, result.rateLimitRetryAfterMs)
    }
    if (result.noModel) pause ??= { kind: 'no_model', until: null, message: 'No AI model is set up.' }
    // Provider errors are counted across steps, so a loop that scores a few jobs at a time still stops after three in a row.
    this.scoreStreak = result.scored > 0 ? result.providerErrors : this.scoreStreak + result.providerErrors
    if (result.stoppedForProviderErrors || this.scoreStreak >= MAX_PROVIDER_ERRORS) {
      this.scoreStreak = 0
      pause ??= providerPause('Scoring stopped after three errors from your AI provider.')
    }
    if (result.scored > 0) {
      ctx.events.add('scored', `Scored ${plural(result.scored, 'job')}. ${result.shortlisted} made the shortlist.`)
    }
    ctx.emit('jobs:changed', { jobIds: jobs.map((j) => j.id) })
    return outcome(stats, result.scored, pause)
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

  /** Lets the next provider limit write its note again. The work loop calls it when a limit pause ends. */
  resetRateLimitNote(): void {
    this.rateLimitNoted = false
  }

  // -------------------------------------------------------------------------
  // Prepare and submit, through hooks
  // -------------------------------------------------------------------------

  /**
   * Prepares up to `limit` shortlisted jobs at or above the auto-prepare score, best fit first, with
   * `concurrency` drafts at once. Each job is checked again right before its draft starts.
   */
  async prepareStep(limit: number, concurrency: number, signal: AbortSignal): Promise<StepOutcome> {
    const { ctx } = this
    const stats = emptyStats()
    const { autopilot, thresholds } = ctx.settings.get()
    const hook = this.hooks.prepare
    if (!autopilot.autoPrepare || !hook || limit <= 0) return outcome(stats, 0)
    const jobs: Job[] = ctx.jobs
      // A job whose draft failed twice for another reason is left to the Prepare button.
      .listByStage('shortlisted', { orderBy: 'fit', skipRepeatedPrepareFailures: true })
      .filter((j) => !j.applicationId && (j.fit?.score ?? 0) >= thresholds.autoPrepareScore)
      // A posting no source has listed for a month is probably gone. Don't spend the writing model on it.
      .filter((j) => !ctx.jobs.isUnseen(j.id))
      .slice(0, limit)
    if (jobs.length === 0) return outcome(stats, 0)
    this.setProgress('preparing', `Preparing ${plural(jobs.length, 'application')}`, 0, jobs.length)
    let done = 0
    let halted = false
    let pause: PauseHint | null = null
    const stop = (hint: PauseHint): void => {
      halted = true
      pause ??= hint
    }
    await mapLimit(jobs, Math.max(1, concurrency), async (job) => {
      if (signal.aborted || halted) return
      // The user may have prepared, dismissed or applied while this run was going.
      const fresh = ctx.jobs.get(job.id)
      if (!fresh || fresh.stage !== 'shortlisted' || ctx.applications.getByJob(job.id)) {
        done += 1
        return
      }
      try {
        await withLimit(hook(job.id), this.limits.prepareMs)
        stats.prepared += 1
        this.prepareStreak = 0
      } catch (err) {
        if (err instanceof TimeLimitError) {
          // The draft keeps running in the background. The run does not wait for it.
          stats.errors += 1
          ctx.events.add('error', `Preparing ${job.title} at ${job.company} took more than ${Math.round(this.limits.prepareMs / 60_000)} minutes, so the run moved on.`, job.id)
          done += 1
          return
        }
        if (err instanceof BudgetExceededError) {
          stats.stoppedForBudget = true
          ctx.events.add('budget_stop', `${err.message} Preparing stopped after ${plural(stats.prepared, 'application')}.`, job.id)
          stop(budgetPause(err.message))
          return
        }
        if (err instanceof RateLimitedError) {
          stats.stoppedForRateLimit = true
          this.addRateLimitStop(jobs.length - done, 'application', err.message, job.id)
          stop(rateLimitPause(err.message, err.retryAfterMs))
          return
        }
        stats.errors += 1
        ctx.events.add('error', `Could not prepare ${job.title} at ${job.company}: ${(err as Error).message}`, job.id)
        if (err instanceof NoModelConfiguredError) {
          stop({ kind: 'no_model', until: null, message: 'No AI model is set up.' })
          return
        }
        // A refusal or an unreadable reply means the provider answered, so it breaks the row.
        this.prepareStreak = isProviderError(err) ? this.prepareStreak + 1 : 0
        if (this.prepareStreak >= MAX_PROVIDER_ERRORS) {
          this.prepareStreak = 0
          ctx.events.add('error', `Preparing stopped after ${MAX_PROVIDER_ERRORS} errors in a row. Check that your AI provider is running and the key works, then run again.`)
          stop(providerPause('Preparing stopped after three errors from your AI provider.'))
          return
        }
      }
      done += 1
      this.setProgress('preparing', `Prepared ${done} of ${jobs.length}`, done, jobs.length)
    })
    ctx.emit('jobs:changed', { jobIds: jobs.map((j) => j.id) })
    return outcome(stats, stats.prepared, pause)
  }

  /** The batch rule: send up to what is left of today's cap, and say so when nothing is left. */
  private async submitPhase(stats: RunStats, signal: AbortSignal): Promise<void> {
    const { ctx } = this
    const { autopilot } = ctx.settings.get()
    if (!autopilot.autoSubmit || !this.hooks.submit) return
    const left = autopilot.dailySubmitCap - ctx.applications.countSubmittedSince(startOfToday())
    if (left <= 0) {
      ctx.events.add('submitted', `Daily limit of ${autopilot.dailySubmitCap} applications reached, so nothing more was sent today.`)
      return
    }
    addStats(stats, (await this.submitStep(left, signal)).stats)
  }

  /** Applications being filled right now, so two slots never take the same one or two from one company. */
  submitClaims(): ReadonlyMap<string, SubmitClaim> {
    return this.claims
  }

  /**
   * Sends up to `limit` ready applications, best fit first. It tries them in order until enough went
   * out, so an application that is skipped or fails does not use up one of the sends. With `maxAttempts`
   * it stops after that many tries, which is how the work loop takes one application at a time.
   * `skipFamilies` leaves out applications on those form families (a paused or capped family).
   */
  async submitStep(limit: number, signal: AbortSignal, options: SubmitStepOptions = {}): Promise<SubmitOutcome> {
    const { ctx } = this
    const stats = emptyStats()
    const attempts: SubmitAttempt[] = []
    const finish = (pause: PauseHint | null = null): SubmitOutcome => ({ stats, did: attempts.length, pause, attempts })
    const { autopilot, thresholds } = ctx.settings.get()
    const hook = this.hooks.submit
    if (!autopilot.autoSubmit || !hook || limit <= 0) return finish()
    // Every eligible application is a candidate. The loop runs until enough go out, not until enough were tried,
    // so an application that is skipped or fails does not use up one of the day's sends.
    const ready = ctx.applications
      .listReady({ skipDryRun: autopilot.dryRun })
      .filter((a) => !this.claims.has(a.id))
      .filter((a) => (a.fitScore ?? 0) >= thresholds.autoSubmitScore && a.flaggedCount === 0 && a.guessCount === 0)
    if (ready.length === 0) return finish()
    this.setProgress('submitting', `Submitting up to ${plural(limit, 'application')}`, 0, limit)

    // Forms that were sent to, or clicked, before this run or during it.
    const sentForms = new Set(ctx.applications.sentTargets().map((t) => normalizeApplyUrl(applyUrlFor(t))))
    /** Sends to a company before this step started, read once, and the ones this step made itself. */
    const before = new Map<string, number>()
    const madeNow = new Map<string, number>()
    const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY
    let sent = 0
    let skipped = 0
    let pause: PauseHint | null = null
    for (const app of ready) {
      if (signal.aborted || sent >= limit || attempts.length >= maxAttempts) break
      // Check again right before sending. The user may have edited, withdrawn or dismissed it,
      // paused autopilot or turned auto-submit off, or the daily cap may have been reached by a manual submit.
      const now = ctx.settings.get()
      const current = ctx.applications.get(app.id)
      const job = current ? ctx.jobs.get(current.jobId) : null
      const sentToday = ctx.applications.countSubmittedSince(startOfToday())
      if (
        this.claims.has(app.id) ||
        !now.autopilot.enabled ||
        !now.autopilot.autoSubmit ||
        sentToday >= now.autopilot.dailySubmitCap ||
        !current ||
        !job ||
        current.status !== 'ready' ||
        current.submitMode !== null ||
        current.submitClickedAt !== null ||
        (now.autopilot.dryRun && current.dryRunAt !== null) ||
        job.stage !== 'ready' ||
        current.flaggedCount > 0 ||
        current.guessCount > 0 ||
        (job.fit?.score ?? 0) < now.thresholds.autoSubmitScore
      ) {
        continue
      }
      const family = job.ats
      if (options.skipFamilies?.has(family)) continue
      // A company gets `perCompanyLimit` applications inside the cooldown, and a form is sent once. A repost
      // of a job, or another role at the same company, would otherwise go out within minutes of the first.
      const company = normalizeCompany(job.company)
      const form = normalizeApplyUrl(applyUrlFor(job))
      const cooldownDays = now.preferences.companyCooldownDays
      const perCompany = Math.max(1, Math.floor(now.preferences.perCompanyLimit ?? 1))
      let companyFull = false
      if (cooldownDays > 0) {
        if (!before.has(company)) {
          before.set(company, ctx.applications.countSentToCompanySince(company, new Date(Date.now() - cooldownDays * DAY_MS).toISOString()))
        }
        const open = [...this.claims.values()].filter((c) => c.company === company).length
        companyFull = before.get(company)! + (madeNow.get(company) ?? 0) + open >= perCompany
      }
      const formTaken = sentForms.has(form) || [...this.claims.values()].some((c) => c.form === form)
      if (formTaken || companyFull) {
        skipped += 1
        continue
      }
      this.claims.set(app.id, { company, form, family })
      const attempt: SubmitAttempt = { applicationId: app.id, jobId: app.jobId, family, result: 'failed' }
      const markSent = (): void => {
        madeNow.set(company, (madeNow.get(company) ?? 0) + 1)
        sentForms.add(form)
      }
      try {
        const result = await withLimit(hook(app.id), this.limits.submitMs)
        this.submitStreak = 0
        attempts.push(attempt)
        if (result.ok && result.status === 'submitted') {
          stats.submitted += 1
          sent += 1
          attempt.result = 'sent'
        } else if (!result.ok) {
          stats.errors += 1
          attempt.result = CAPTCHA.test(result.message) ? 'captcha' : SIGN_IN_WALL.test(result.message) ? 'sign_in' : 'failed'
        } else {
          attempt.result = 'other'
        }
        // A click with no confirmation counts too, since the form may have gone through.
        const after = ctx.applications.get(app.id)
        if ((result.ok && result.status === 'submitted') || after?.submittedAt || after?.submitClickedAt) {
          markSent()
          if (attempt.result !== 'sent') attempt.result = 'clicked'
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          stats.stoppedForBudget = true
          ctx.events.add('budget_stop', `${err.message} Submitting stopped after ${plural(sent, 'application')}.`, app.jobId)
          pause = budgetPause(err.message)
          break
        }
        if (err instanceof RateLimitedError) {
          stats.stoppedForRateLimit = true
          this.addRateLimitStop(ready.length - sent, 'application', err.message, app.jobId)
          pause = rateLimitPause(err.message, err.retryAfterMs)
          break
        }
        attempts.push(attempt)
        if (err instanceof TimeLimitError) {
          // The tab may still be filling the form. Taking the application out of 'submitting' makes a late
          // Submit click fail its check, so nothing is clicked after the run moved on.
          const latest = ctx.applications.get(app.id)
          const clicked = latest?.submitClickedAt != null
          const message = clicked
            ? 'Timed out after clicking Submit. Check the company site or your email. If it went through, click "I submitted it myself".'
            : 'Timed out while filling the form.'
          if (latest && latest.status !== 'submitted') ctx.applications.update(app.id, { status: 'needs_attention', error: message })
          if (clicked) {
            markSent()
            attempt.result = 'clicked'
          }
          stats.errors += 1
          ctx.events.add('submit_failed', `${app.title} at ${app.company}: ${message}`, app.jobId)
          this.submitStreak = 0
        } else {
          stats.errors += 1
          ctx.events.add('submit_failed', `Could not submit ${app.title} at ${app.company}: ${(err as Error).message}`, app.jobId)
          this.submitStreak += 1
          if (this.submitStreak >= MAX_CONSECUTIVE_SUBMIT_EXCEPTIONS) {
            this.submitStreak = 0
            ctx.events.add('error', `Submitting stopped after ${MAX_CONSECUTIVE_SUBMIT_EXCEPTIONS} failures in a row. Check that Chrome or Edge opens and the site loads, then run again.`)
            pause = { kind: 'browser_errors', until: new Date(Date.now() + PROVIDER_PAUSE_MS).toISOString(), message: 'Submitting stopped after two failures in a row.' }
            break
          }
        }
      } finally {
        this.claims.delete(app.id)
      }
      this.setProgress('submitting', `Submitted ${sent} of up to ${limit}`, sent, limit)
    }
    if (skipped > 0 && !options.loop) {
      ctx.events.add('submitted', `Left ${plural(skipped, 'application')} for later because the company or the form already had an application recently.`)
    }
    if (options.loop) {
      if (attempts.length > 0) {
        ctx.emit('applications:changed', { applicationIds: attempts.map((a) => a.applicationId) })
        ctx.emit('jobs:changed', { jobIds: attempts.map((a) => a.jobId) })
      }
    } else {
      ctx.emit('applications:changed', { applicationIds: ready.map((a) => a.id) })
      ctx.emit('jobs:changed', { jobIds: ready.map((a) => a.jobId) })
    }
    return finish(pause)
  }
}
