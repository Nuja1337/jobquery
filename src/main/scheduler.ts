import type { AppContext } from './context'
import type { WorkLoop } from './pipeline/loop'
import type { Pipeline } from './pipeline/orchestrator'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** Shortest wait before a run that is already due, so the app finishes starting first. */
const DUE_DELAY_MS = MINUTE_MS
/** setTimeout cannot wait longer than this. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * While autopilot is on, runs the pipeline every `autopilot.intervalHours` (interval mode), or starts
 * the work loop that keeps going all day (continuous mode).
 * Call `reschedule()` whenever settings change.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private next: number | null = null
  private started = false
  private listener: (() => void) | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly pipeline: Pipeline,
    private readonly loop: WorkLoop | null = null
  ) {}

  /** Starts watching the settings. Safe to call twice. */
  start(): void {
    this.started = true
    this.reschedule()
  }

  /** Called after every reschedule, so the tray can show the new next run time. */
  onChange(listener: (() => void) | null): void {
    this.listener = listener
  }

  /**
   * Call when the computer wakes from sleep. Timers don't count the time asleep, so a run that
   * came due meanwhile would otherwise wait for the old timer. This works the time out again from
   * the last run, and a run that is overdue starts within a minute.
   */
  resume(): void {
    this.reschedule()
  }

  /** Stops the timer and the work loop. Resolves when the loop's workers have ended. */
  stop(): Promise<void> {
    this.started = false
    this.clear()
    return this.loop?.stop() ?? Promise.resolve()
  }

  /** Picks the next run time from the current settings and the time of the last run. */
  reschedule(): void {
    this.clear()
    if (!this.started) return
    const { autopilot } = this.ctx.settings.get()
    if (autopilot.enabled && autopilot.mode === 'continuous' && this.loop) {
      // The loop has no timer here. A settings change wakes it so a new model, budget or cap applies at once.
      if (this.loop.isRunning()) this.loop.wake()
      else if (!this.pipeline.isRunning()) this.loop.start()
      else this.arm(DUE_DELAY_MS)
      this.listener?.()
      return
    }
    void this.loop?.stop()
    if (!autopilot.enabled) {
      this.listener?.()
      return
    }
    const hours = Number.isFinite(autopilot.intervalHours) ? autopilot.intervalHours : 6
    const interval = Math.max(hours, 0.25) * HOUR_MS
    const last = this.ctx.runs.list(1)[0]
    const lastStart = last ? Date.parse(last.startedAt) : NaN
    const due = Number.isFinite(lastStart) ? lastStart + interval : Date.now() + DUE_DELAY_MS
    const delay = Math.max(due - Date.now(), DUE_DELAY_MS)
    this.arm(delay)
    this.listener?.()
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
    // Continuous mode has no batch runs. If the mode changed since this timer was set, reschedule starts the loop.
    if (autopilot.enabled && autopilot.mode !== 'continuous' && !this.pipeline.isRunning()) {
      try {
        await this.pipeline.run({ discover: true, triage: true, prepare: autopilot.autoPrepare, submit: autopilot.autoSubmit, trigger: 'schedule' })
      } catch {
        // The pipeline already logged the failure. Catching it keeps the timer chain alive.
      }
    }
    this.reschedule()
  }
}
