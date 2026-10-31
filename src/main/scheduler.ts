import type { AppContext } from './context'
import type { Pipeline } from './pipeline/orchestrator'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** Shortest wait before a run that is already due, so the app finishes starting first. */
const DUE_DELAY_MS = MINUTE_MS
/** setTimeout cannot wait longer than this. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Runs the pipeline every `autopilot.intervalHours` while autopilot is on.
 * Call `reschedule()` whenever settings change.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private next: number | null = null
  private started = false

  constructor(
    private readonly ctx: AppContext,
    private readonly pipeline: Pipeline
  ) {}

  /** Starts watching the settings. Safe to call twice. */
  start(): void {
    this.started = true
    this.reschedule()
  }

  stop(): void {
    this.started = false
    this.clear()
  }

  /** Picks the next run time from the current settings and the time of the last run. */
  reschedule(): void {
    this.clear()
    if (!this.started) return
    const { autopilot } = this.ctx.settings.get()
    if (!autopilot.enabled) return
    const hours = Number.isFinite(autopilot.intervalHours) ? autopilot.intervalHours : 6
    const interval = Math.max(hours, 0.25) * HOUR_MS
    const last = this.ctx.runs.list(1)[0]
    const lastStart = last ? Date.parse(last.startedAt) : NaN
    const due = Number.isFinite(lastStart) ? lastStart + interval : Date.now() + DUE_DELAY_MS
    const delay = Math.max(due - Date.now(), DUE_DELAY_MS)
    this.arm(delay)
  }

  /** ISO time of the next scheduled run, or null when autopilot is off. */
  nextRunAt(): string | null {
    return this.next === null ? null : new Date(this.next).toISOString()
  }

  private arm(delay: number): void {
    const wait = Math.min(delay, MAX_TIMER_MS)
    this.next = Date.now() + wait
    this.timer = setTimeout(() => {
      this.timer = null
      // A long wait is split into steps; only act once the real time has come.
      if (delay > MAX_TIMER_MS) this.arm(delay - MAX_TIMER_MS)
      else void this.fire()
    }, wait)
    this.timer.unref?.()
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.next = null
  }

  private async fire(): Promise<void> {
    const { autopilot } = this.ctx.settings.get()
    if (autopilot.enabled && !this.pipeline.isRunning()) {
      try {
        await this.pipeline.run({ discover: true, triage: true, prepare: autopilot.autoPrepare, submit: autopilot.autoSubmit, trigger: 'schedule' })
      } catch {
        // The pipeline already logged the failure. Catching it keeps the timer chain alive.
      }
    }
    this.reschedule()
  }
}
