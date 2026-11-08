// The rules for running unattended, kept apart from Electron so tests can reach them.
import type { LoopStatus, PipelinePhase, PipelineProgress, Settings } from '@shared/types'

const PHASE_LABEL: Record<PipelinePhase, string> = {
  idle: 'Starting',
  discovering: 'Finding jobs',
  filtering: 'Filtering jobs',
  scoring: 'Scoring jobs',
  preparing: 'Preparing',
  submitting: 'Submitting'
}

export interface StatusInput {
  autopilotEnabled: boolean
  /** True from the start of a run to its end. */
  running: boolean
  progress: PipelineProgress
  /** ISO time of the next scheduled run. */
  nextRunAt: string | null
  /** The work loop's status while continuous mode runs. */
  loop?: LoopStatus | null
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "14:30" for a time today, "Tue 14:30" for a later day. */
export function clockLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (at.toDateString() === now.toDateString()) return time
  return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

/** Continuous mode: what the workers are doing, or why every one of them waits. */
function loopLine(loop: LoopStatus): string {
  const workers = Object.values(loop.workers)
  const on = workers.filter((w) => w.state !== 'off')
  if (on.length > 0 && on.every((w) => w.state === 'paused')) {
    const reason = on.find((w) => w.reason)?.reason
    return reason ? `Paused: ${reason.replace(/\.$/, '')}` : 'Paused'
  }
  const { prepare, submit } = loop.workers
  return `Running continuously: ${prepare.active} preparing, ${submit.active} submitting`
}

/** The one-line state shown in the tray menu. */
export function statusLine(input: StatusInput, now: Date = new Date()): string {
  if (input.loop?.running) return loopLine(input.loop)
  if (input.running) {
    const { phase, done, total } = input.progress
    const label = PHASE_LABEL[phase]
    return total > 0 ? `Running: ${label} ${done} of ${total}` : `Running: ${label}`
  }
  if (!input.autopilotEnabled) return 'Autopilot off'
  return input.nextRunAt ? `Autopilot on, next run ${clockLabel(input.nextRunAt, now)}` : 'Autopilot on'
}

/** The computer stays awake during a run, and while autopilot is waiting for its next one. */
export function shouldKeepAwake(settings: Pick<Settings, 'system' | 'autopilot'>, running: boolean): boolean {
  return settings.system.keepAwake && (running || settings.autopilot.enabled)
}

/** The part of Electron's powerSaveBlocker that KeepAwake uses. */
export interface SleepBlocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/** Holds at most one sleep blocker, and drops it as soon as it isn't wanted. */
export class KeepAwake {
  private id: number | null = null

  constructor(private readonly blocker: SleepBlocker) {}

  get active(): boolean {
    return this.id !== null && this.blocker.isStarted(this.id)
  }

  set(wanted: boolean): void {
    if (wanted && !this.active) {
      this.id = this.blocker.start('prevent-app-suspension')
    } else if (!wanted && this.id !== null) {
      if (this.blocker.isStarted(this.id)) this.blocker.stop(this.id)
      this.id = null
    }
  }
}
