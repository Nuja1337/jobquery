import type { LoopStatus, PauseHint, PauseKind, PipelinePhase, PipelineProgress, RunStats, WorkerName, WorkerStatus } from '@shared/types'
import type { AppContext } from '../context'
import { emptyStats } from '../db/repos/runs'
import { type SubmitAttempt, type StepOutcome, type Pipeline, addStats, nextLocalMidnight } from './orchestrator'

/** Time and waiting, so tests can run the loop without real delays. */
export interface LoopClock {
  /** Epoch milliseconds. */
  now(): number
  /** Resolves after ms, or early when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realLoopClock: LoopClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const timer = setTimeout(done, Math.min(ms, 2 ** 31 - 1))
      function done(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
}

export const WORKERS: WorkerName[] = ['discover', 'score', 'prepare', 'submit']

/** Most applications one form family may get in a clock hour. Lever shows hCaptcha when automation moves fast. */
export const FAMILY_HOURLY_CAP: Record<string, number> = { lever: 15 }
export const DEFAULT_FAMILY_HOURLY_CAP = 60
export const familyHourlyCap = (family: string): number => FAMILY_HOURLY_CAP[family] ?? DEFAULT_FAMILY_HOURLY_CAP

export const SCORE_BATCH = 20
export const PREPARE_BATCH = 2
export const PREPARE_CONCURRENCY = 2
export const DISCOVER_MIN_GAP_MS = 60_000
export const BACKOFF_MIN_MS = 30_000
export const BACKOFF_MAX_MS = 5 * 60_000
/** A short rest between two steps that both found work. */
export const WORK_GAP_MS = 500
/** How long a slot waits when the day's or hour's cap is only used up by applications still open in the browser. */
const SLOT_WAIT_MS = 10_000
const OFF_WAIT_MS = 60_000
export const CAPTCHAS_BEFORE_PAUSE = 3
export const SIGN_INS_BEFORE_PAUSE = 2
export const FAMILY_PAUSE_MS = 2 * 3_600_000
const HOUR_MS = 3_600_000
const MAX_SUBMIT_SLOTS = 3
/** The same error message from one worker is logged at most this often. */
const ERROR_REPEAT_MS = 10 * 60_000
/** How long the day's counts in the status are reused. */
const TODAY_CACHE_MS = 3_000

const DOING: Record<WorkerName, string> = { discover: 'finding jobs', score: 'scoring', prepare: 'preparing', submit: 'submitting' }
const PHASE: Record<WorkerName, PipelinePhase> = { discover: 'discovering', score: 'scoring', prepare: 'preparing', submit: 'submitting' }
/** The activity log type that suits each worker's cap note. */
const CAP_EVENT: Record<WorkerName, 'discovered' | 'scored' | 'prepared' | 'submitted'> = { discover: 'discovered', score: 'scored', prepare: 'prepared', submit: 'submitted' }
const NEXT: Partial<Record<WorkerName, WorkerName>> = { discover: 'score', score: 'prepare', prepare: 'submit' }

const pad = (n: number): string => String(n).padStart(2, '0')

function localDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function localHour(ms: number): number {
  const d = new Date(ms)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

/** "09:00" for a time today, with the weekday for a later day. */
function clock(ms: number, nowMs: number): string {
  const at = new Date(ms)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return at.toDateString() === new Date(nowMs).toDateString() ? time : `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

interface ActivePause {
  kind: PauseKind
  untilMs: number | null
  message: string
}

interface Runtime {
  /** Steps running right now. */
  active: number
  /** Items those steps are working on, for the status line. */
  items: number
  pause: ActivePause | null
  /** Paused by the person. Only resumeWorker lifts it. */
  manual: boolean
  backoff: number
  sleepers: Set<AbortController>
  lastError: { message: string; at: number } | null
}

interface FamilyPause {
  untilMs: number
  kind: 'captcha' | 'sign_in'
}

interface Tick {
  did: number
  pause: PauseHint | null
}

/**
 * Keeps the pipeline working all day. Four workers each take small steps while there is work:
 * discover (with the free filters), score, prepare and submit. Prepare and submit overlap, and a
 * limit stops only the worker that hit it. Caps are read from the database, so they hold across restarts.
 * Only stop() ends the loop. A worker that fails logs one event and keeps going.
 */
export class WorkLoop {
  private running = false
  private since: string | null = null
  private stop$: AbortController | null = null
  private finished: Array<Promise<void>> = []
  private readonly rt: Record<WorkerName, Runtime> = {
    discover: this.freshRuntime(),
    score: this.freshRuntime(),
    prepare: this.freshRuntime(),
    submit: this.freshRuntime()
  }
  private readonly familyPause = new Map<string, FamilyPause>()
  private readonly captchaStreak = new Map<string, number>()
  private readonly signInStreak = new Map<string, number>()
  /** The hour whose run record is being filled. */
  private hour: { id: string; start: number; stats: RunStats } | null = null
  private lastProgress = ''
  private lastStatus = ''
  /** Today's counts from the database. Reused for a few seconds, and dropped when a step ends. */
  private todayCache: { day: string; at: number; value: LoopStatus['today']; counts: Record<WorkerName, number> } | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly pipeline: Pipeline,
    private readonly clock: LoopClock = realLoopClock
  ) {
    pipeline.attachLoop(this)
  }

  private freshRuntime(): Runtime {
    return { active: 0, items: 0, pause: null, manual: false, backoff: BACKOFF_MIN_MS, sleepers: new Set(), lastError: null }
  }

  isRunning(): boolean {
    return this.running
  }

  /** Starts the workers. Does nothing when they are already going. */
  start(): void {
    if (this.running) return
    this.running = true
    this.since = new Date(this.clock.now()).toISOString()
    this.todayCache = null
    this.stop$ = new AbortController()
    const signal = this.stop$.signal
    for (const name of WORKERS) Object.assign(this.rt[name], this.freshRuntime(), { manual: this.rt[name].manual })
    this.ctx.events.add('run_started', 'Continuous mode started.')
    const slots: Array<[WorkerName, number]> = [['discover', 0], ['score', 0], ['prepare', 0]]
    for (let slot = 0; slot < MAX_SUBMIT_SLOTS; slot++) slots.push(['submit', slot])
    this.finished = slots.map(([name, slot]) => this.work(name, slot, signal))
    this.touch()
  }

  /** Ends every worker after its current step and resolves once they have all stopped. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.stop$?.abort()
    this.stop$ = null
    const finished = this.finished
    this.finished = []
    this.since = null
    this.familyPause.clear()
    this.captchaStreak.clear()
    this.signInStreak.clear()
    this.lastProgress = ''
    this.todayCache = null
    await Promise.all(finished)
    // Started again while the workers were ending: the new run owns the state from here.
    if (this.running) return
    this.closeHour()
    this.ctx.events.add('run_finished', 'Continuous mode stopped.')
    this.pipeline.publish({ runId: null, phase: 'idle', message: 'Idle', done: 0, total: 0 })
    this.emitStatus()
  }

  /**
   * Makes workers look for work now instead of waiting out a pause or a nap. A change to the settings
   * lifts the pauses that a setting can fix (no model, budget, caps). With `retry` every pause lifts,
   * including provider limits and form families, but not one the person set.
   */
  wake(worker?: WorkerName, options: { retry?: boolean } = {}): void {
    for (const name of worker ? [worker] : WORKERS) {
      const w = this.rt[name]
      const p = w.pause
      if (p && (options.retry || p.kind === 'no_model' || p.kind === 'budget' || p.kind === 'cap')) {
        w.pause = null
        if (p.kind === 'rate_limit') this.pipeline.resetRateLimitNote()
      }
      this.nudge(name)
    }
    if (options.retry) this.familyPause.clear()
    this.touch()
  }

  /** The person stops one worker. It finishes its current step and then waits. */
  pauseWorker(name: WorkerName): void {
    this.rt[name].manual = true
    this.touch()
  }

  resumeWorker(name: WorkerName): void {
    const w = this.rt[name]
    w.manual = false
    w.pause = null
    if (name === 'submit') this.familyPause.clear()
    this.nudge(name)
    this.touch()
  }

  // -------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------

  private nudge(name: WorkerName): void {
    for (const ctl of [...this.rt[name].sleepers]) ctl.abort()
  }

  private async nap(name: WorkerName, ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const w = this.rt[name]
    const ctl = new AbortController()
    w.sleepers.add(ctl)
    const onStop = (): void => ctl.abort()
    signal.addEventListener('abort', onStop, { once: true })
    try {
      await this.clock.sleep(Math.max(ms, 1), ctl.signal)
    } finally {
      signal.removeEventListener('abort', onStop)
      w.sleepers.delete(ctl)
    }
  }

  private async work(name: WorkerName, slot: number, signal: AbortSignal): Promise<void> {
    const w = this.rt[name]
    while (!signal.aborted) {
      try {
        const wait = this.gate(name, slot)
        if (wait !== null) {
          await this.nap(name, wait, signal)
          continue
        }
        const tick = await this.step(name, slot, signal)
        if (signal.aborted) break
        let rest: number
        if (tick.did > 0) {
          w.backoff = BACKOFF_MIN_MS
          const next = NEXT[name]
          if (next) this.nudge(next)
          rest = name === 'discover' ? DISCOVER_MIN_GAP_MS : WORK_GAP_MS
        } else {
          rest = name === 'discover' ? Math.max(DISCOVER_MIN_GAP_MS, w.backoff) : w.backoff
          w.backoff = Math.min(w.backoff * 2, BACKOFF_MAX_MS)
        }
        if (tick.pause) {
          // The top of the loop waits the pause out.
          this.setPause(name, tick.pause)
          continue
        }
        await this.nap(name, rest, signal)
      } catch (err) {
        this.logFailure(name, err)
        if (signal.aborted) break
        const rest = w.backoff
        w.backoff = Math.min(w.backoff * 2, BACKOFF_MAX_MS)
        await this.nap(name, rest, signal)
      }
    }
  }

  /** Why a worker cannot take a step now, as the time to wait in milliseconds, or null when it can go ahead. */
  private gate(name: WorkerName, slot: number): number | null {
    const w = this.rt[name]
    const now = this.clock.now()
    if (name === 'submit' && slot >= this.slots()) return OFF_WAIT_MS
    if (w.manual) return OFF_WAIT_MS * 60
    if (w.pause) {
      if (w.pause.untilMs === null) return OFF_WAIT_MS * 60
      if (w.pause.untilMs > now) return w.pause.untilMs - now
      if (w.pause.kind === 'rate_limit') this.pipeline.resetRateLimitNote()
      w.pause = null
      this.touch()
    }
    if (this.isOff(name)) return OFF_WAIT_MS
    const cap = this.capPause(name, now)
    if (cap === 'wait') return SLOT_WAIT_MS
    if (cap) {
      this.setPause(name, cap)
      return cap.until ? Math.max(Date.parse(cap.until) - now, 1) : OFF_WAIT_MS
    }
    return null
  }

  private slots(): number {
    const n = Math.round(this.ctx.settings.get().autopilot.submitConcurrency)
    return Number.isFinite(n) ? Math.min(MAX_SUBMIT_SLOTS, Math.max(1, n)) : 1
  }

  private isOff(name: WorkerName): boolean {
    const { autopilot } = this.ctx.settings.get()
    if (name === 'prepare') return !autopilot.autoPrepare
    if (name === 'submit') return !autopilot.autoSubmit
    return false
  }

  /** A cap that is used up, as a pause, or 'wait' when only applications still open in the browser use it up. */
  private capPause(name: WorkerName, now: number): PauseHint | 'wait' | null {
    const { budget, autopilot } = this.ctx.settings.get()
    const day = new Date(localDay(now)).toISOString()
    const midnight = new Date(nextLocalMidnight(now)).toISOString()
    if (name === 'score') {
      if (this.scoredSince(day) >= budget.maxTriagePerDay) {
        return { kind: 'cap', until: midnight, message: `The daily scoring limit of ${budget.maxTriagePerDay} jobs is reached.` }
      }
    } else if (name === 'prepare') {
      if (this.ctx.applications.countCreatedSince(day) >= budget.maxPreparePerDay) {
        return { kind: 'cap', until: midnight, message: `The daily limit of ${budget.maxPreparePerDay} prepared applications is reached.` }
      }
    } else if (name === 'submit') {
      const open = this.pipeline.submitClaims().size
      const today = this.ctx.applications.countSubmittedSince(day)
      if (today >= autopilot.dailySubmitCap) {
        return { kind: 'cap', until: midnight, message: `The daily limit of ${autopilot.dailySubmitCap} applications is reached.` }
      }
      const hourStart = localHour(now)
      const hour = this.ctx.applications.countSubmittedSince(new Date(hourStart).toISOString())
      if (hour >= autopilot.hourlySubmitCap) {
        return { kind: 'cap', until: new Date(hourStart + HOUR_MS).toISOString(), message: `The hourly limit of ${autopilot.hourlySubmitCap} applications is reached.` }
      }
      if (today + open >= autopilot.dailySubmitCap || hour + open >= autopilot.hourlySubmitCap) return 'wait'
    }
    return null
  }

  /** Form families a submit step must leave out: paused ones and ones at their hourly cap. */
  private skippedFamilies(now: number): Set<string> {
    const skip = new Set<string>()
    for (const [family, pause] of this.familyPause) {
      if (pause.untilMs > now) skip.add(family)
      else this.familyPause.delete(family)
    }
    const sent = this.ctx.applications.countSentByAtsSince(new Date(localHour(now)).toISOString())
    const open = new Map<string, number>()
    for (const claim of this.pipeline.submitClaims().values()) open.set(claim.family, (open.get(claim.family) ?? 0) + 1)
    for (const family of new Set([...Object.keys(sent), ...open.keys()])) {
      if ((sent[family] ?? 0) + (open.get(family) ?? 0) >= familyHourlyCap(family)) skip.add(family)
    }
    return skip
  }

  private async step(name: WorkerName, slot: number, signal: AbortSignal): Promise<Tick> {
    const w = this.rt[name]
    const { pipeline, ctx } = this
    const { budget } = ctx.settings.get()
    const now = this.clock.now()
    const day = new Date(localDay(now)).toISOString()
    let items = 1
    let run: () => Promise<Tick>
    switch (name) {
      case 'discover':
        run = async () => {
          const found = await pipeline.discoverStep(signal)
          this.record(found.stats)
          if (signal.aborted) return { did: found.did, pause: null }
          const filtered = pipeline.filterStep()
          this.record(filtered.stats)
          return { did: found.did + filtered.did, pause: null }
        }
        break
      case 'score': {
        const limit = Math.min(SCORE_BATCH, budget.maxTriagePerDay - this.scoredSince(day))
        items = Math.max(limit, 0)
        run = () => this.take(pipeline.scoreStep(limit, signal))
        break
      }
      case 'prepare': {
        const limit = Math.min(PREPARE_BATCH, budget.maxPreparePerDay - ctx.applications.countCreatedSince(day))
        items = Math.max(Math.min(limit, PREPARE_CONCURRENCY), 0)
        run = () => this.take(pipeline.prepareStep(limit, PREPARE_CONCURRENCY, signal))
        break
      }
      default:
        run = async () => {
          const out = await pipeline.submitStep(1, signal, { maxAttempts: 1, skipFamilies: this.skippedFamilies(now), loop: true })
          this.record(out.stats)
          for (const attempt of out.attempts) this.noteAttempt(attempt)
          return { did: out.did, pause: out.pause }
        }
    }
    w.active += 1
    w.items += items
    this.touch()
    try {
      return await run()
    } finally {
      w.active -= 1
      w.items -= items
      this.todayCache = null
      this.touch()
    }
  }

  private async take(work: Promise<StepOutcome>): Promise<Tick> {
    const out = await work
    this.record(out.stats)
    return { did: out.did, pause: out.pause }
  }

  /** Counts captchas and sign-in walls in a row for the attempt's form family, and pauses the family at the limit. */
  private noteAttempt(attempt: SubmitAttempt): void {
    const { family } = attempt
    const captchas = attempt.result === 'captcha' ? (this.captchaStreak.get(family) ?? 0) + 1 : 0
    const signIns = attempt.result === 'sign_in' ? (this.signInStreak.get(family) ?? 0) + 1 : 0
    this.captchaStreak.set(family, captchas)
    this.signInStreak.set(family, signIns)
    const now = this.clock.now()
    const name = family === 'unknown' ? 'These sites' : family[0].toUpperCase() + family.slice(1)
    const until = now + FAMILY_PAUSE_MS
    if (captchas >= CAPTCHAS_BEFORE_PAUSE) {
      this.captchaStreak.set(family, 0)
      this.familyPause.set(family, { untilMs: until, kind: 'captcha' })
      this.ctx.events.add(
        'submit_failed',
        `${name} showed a captcha ${captchas} times in a row, so ${family === 'unknown' ? 'sites like these are' : `${name} applications are`} paused until ${clock(until, now)}. Other sites keep going.`,
        attempt.jobId
      )
    } else if (signIns >= SIGN_INS_BEFORE_PAUSE) {
      this.signInStreak.set(family, 0)
      this.familyPause.set(family, { untilMs: until, kind: 'sign_in' })
      this.ctx.events.add(
        'submit_failed',
        `${name} asked you to sign in ${signIns} times in a row, so ${family === 'unknown' ? 'sites like these are' : `${name} applications are`} paused until ${clock(until, now)}. Other sites keep going.`,
        attempt.jobId
      )
    }
  }

  private setPause(name: WorkerName, hint: PauseHint): void {
    const w = this.rt[name]
    const untilMs = hint.until ? Date.parse(hint.until) : null
    const fresh = !w.pause || w.pause.kind !== hint.kind
    w.pause = { kind: hint.kind, untilMs: Number.isFinite(untilMs) ? untilMs : null, message: hint.message }
    // The steps write their own notes for budget, provider and browser stops. A cap has none, so the loop writes it.
    if (fresh && hint.kind === 'cap') {
      const again = untilMs !== null ? ` ${DOING[name][0].toUpperCase()}${DOING[name].slice(1)} resumes at ${clock(untilMs, this.clock.now())}.` : ''
      this.ctx.events.add(CAP_EVENT[name], `${hint.message}${again}`)
    }
    this.touch()
  }

  private logFailure(name: WorkerName, err: unknown): void {
    const w = this.rt[name]
    const message = (err as Error)?.message ?? String(err)
    const now = this.clock.now()
    if (w.lastError && w.lastError.message === message && now - w.lastError.at < ERROR_REPEAT_MS) return
    w.lastError = { message, at: now }
    this.todayCache = null
    try {
      this.ctx.events.add('error', `The ${DOING[name]} worker hit a problem and will try again. ${message}`)
    } catch {
      // The database may be closing. The worker still must not end.
    }
  }

  // -------------------------------------------------------------------------
  // Run records
  // -------------------------------------------------------------------------

  /** Adds a step's counts to the run record of the current hour. */
  private record(stats: RunStats): void {
    const now = this.clock.now()
    const start = localHour(now)
    if (this.hour && this.hour.start !== start) this.closeHour()
    const any = Object.values(stats).some((v) => (typeof v === 'number' ? v > 0 : v))
    if (!any) return
    if (!this.hour) {
      const record = this.ctx.runs.start('loop')
      this.hour = { id: record.id, start, stats: emptyStats() }
      this.pipeline.publish({ ...this.progressNow(), runId: record.id })
    }
    addStats(this.hour.stats, stats)
    this.saveHour()
  }

  private saveHour(): void {
    if (!this.hour) return
    const row = this.ctx.db.get<{ usd: number | null; tokens: number | null }>(
      `SELECT SUM(cost_usd) AS usd, SUM(input_tokens + output_tokens + cached_input_tokens) AS tokens
       FROM llm_calls WHERE at >= :since AND cache_hit = 0`,
      { since: new Date(this.hour.start).toISOString() }
    )
    this.hour.stats.costUsd = row?.usd ?? 0
    this.hour.stats.tokens = row?.tokens ?? 0
    this.ctx.runs.finish(this.hour.id, this.hour.stats)
  }

  private closeHour(): void {
    if (!this.hour) return
    try {
      this.saveHour()
    } catch {
      // The database may be closing.
    }
    this.hour = null
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  private count(sql: string, since: string): number {
    return this.ctx.db.get<{ n: number }>(sql, { since })?.n ?? 0
  }

  /**
   * Jobs sent to AI scoring since the given time, from the cost log: one row for each paid call and one
   * for each batch on a free model, so a free model's count is lower than its jobs.
   */
  private scoredSince(since: string): number {
    return this.count("SELECT COUNT(*) AS n FROM llm_calls WHERE stage = 'triage' AND task = 'triage' AND cache_hit = 0 AND ok = 1 AND at >= :since", since)
  }

  private activePause(name: WorkerName, now: number): ActivePause | null {
    const p = this.rt[name].pause
    return p && (p.untilMs === null || p.untilMs > now) ? p : null
  }

  status(): LoopStatus {
    const now = this.clock.now()
    const day = new Date(localDay(now)).toISOString()
    const { today, done } = this.todayCounts(day)
    const workers = {} as Record<WorkerName, WorkerStatus>
    for (const name of WORKERS) {
      const w = this.rt[name]
      const pause = this.activePause(name, now)
      let state: WorkerStatus['state'] = 'idle'
      let until: string | null = null
      let reason: string | null = null
      if (!this.running) state = 'off'
      else if (w.manual) {
        state = 'paused'
        reason = 'Paused by you.'
      } else if (pause) {
        state = 'paused'
        until = pause.untilMs === null ? null : new Date(pause.untilMs).toISOString()
        reason = pause.message
      } else if (this.isOff(name)) {
        state = 'off'
        reason = name === 'prepare' ? 'Auto-prepare is off.' : 'Auto-submit is off.'
      } else if (w.active > 0) state = 'working'
      if (name === 'submit' && this.running && state !== 'paused') {
        const held = [...this.familyPause].filter(([, p]) => p.untilMs > now)
        if (held.length > 0) {
          reason = held.map(([family, p]) => `${family} paused until ${clock(p.untilMs, now)} (${p.kind === 'captcha' ? 'captcha' : 'sign-in'})`).join(', ')
        }
      }
      const active = w.active === 0 ? 0 : name === 'prepare' || name === 'score' ? w.items : w.active
      workers[name] = { state, until, reason, doneToday: done[name], active }
    }
    return { running: this.running, since: this.since, workers, today: { ...today } }
  }

  /**
   * The day's counts. Six queries run on every status read, and the status is read often, so the
   * result is reused for TODAY_CACHE_MS. A step that ends, a failure and a start or stop drop it,
   * and so does a new day. Changes made outside the loop, such as a manual submit, show up within the window.
   */
  private todayCounts(day: string): { today: LoopStatus['today']; done: Record<WorkerName, number> } {
    const at = Date.now()
    const cached = this.todayCache
    if (cached && cached.day === day && at >= cached.at && at - cached.at < TODAY_CACHE_MS) return { today: cached.value, done: cached.counts }
    const { ctx } = this
    const discovered = this.count('SELECT COUNT(*) AS n FROM jobs WHERE discovered_at >= :since', day)
    const scored = this.scoredSince(day)
    const prepared = ctx.applications.countCreatedSince(day)
    const submitted = ctx.applications.countSubmittedSince(day)
    const errors = this.count("SELECT COUNT(*) AS n FROM events WHERE at >= :since AND type IN ('error', 'submit_failed')", day)
    const spend = ctx.db.get<{ usd: number | null }>('SELECT SUM(cost_usd) AS usd FROM llm_calls WHERE at >= :since AND cache_hit = 0', { since: day })
    const value = { discovered, scored, prepared, submitted, errors, costUsd: spend?.usd ?? 0 }
    const counts: Record<WorkerName, number> = { discover: discovered, score: scored, prepare: prepared, submit: submitted }
    this.todayCache = { day, at, value, counts }
    return { today: value, done: counts }
  }

  /** The one line for the top bar, such as "Continuous: 2 preparing, 1 submitting, scoring paused until 09:00". */
  private progressNow(): PipelineProgress {
    const now = this.clock.now()
    const parts: string[] = []
    let phase: PipelinePhase = 'discovering'
    let rank = -1
    for (const name of WORKERS) {
      const w = this.rt[name]
      if (w.active > 0) {
        const n = name === 'submit' ? w.active : name === 'discover' ? 0 : w.items
        parts.push(n > 0 ? `${n} ${DOING[name]}` : DOING[name])
        if (WORKERS.indexOf(name) > rank) {
          rank = WORKERS.indexOf(name)
          phase = PHASE[name]
        }
      }
    }
    for (const name of WORKERS) {
      const pause = this.activePause(name, now)
      if (this.rt[name].manual) parts.push(`${DOING[name]} paused`)
      else if (pause) parts.push(`${DOING[name]} paused${pause.untilMs !== null ? ` until ${clock(pause.untilMs, now)}` : ''}`)
    }
    return {
      runId: this.hour?.id ?? null,
      phase,
      message: parts.length > 0 ? `Continuous: ${parts.join(', ')}` : 'Continuous: waiting for work',
      done: 0,
      total: 0
    }
  }

  /** Pushes the progress line and the worker status when either changed. */
  private touch(): void {
    if (!this.running) return
    const progress = this.progressNow()
    const key = `${progress.phase}|${progress.message}`
    if (key !== this.lastProgress) {
      this.lastProgress = key
      this.pipeline.publish(progress)
    }
    this.emitStatus()
  }

  private emitStatus(): void {
    let status: LoopStatus
    try {
      status = this.status()
    } catch {
      return
    }
    const key = JSON.stringify(status)
    if (key === this.lastStatus) return
    this.lastStatus = key
    this.ctx.emit('loop:status', status)
  }
}
