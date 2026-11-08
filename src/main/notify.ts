// Decides which activity log entries deserve a system notification. Electron's Notification is
// passed in by index.ts, so the rules and the cooldown can be tested without Electron.
import type { EventRecord } from '@shared/types'

/** After one notification, the same kind stays quiet for this long. */
export const NOTIFY_COOLDOWN_MS = 30 * 60_000

export interface Note {
  title: string
  body: string
}

const SIGN_IN = /sign[ -]?in|log[ -]?in/i
const CAPTCHA = /captcha/i

const count = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * The notification for an activity log entry, or null when it isn't worth one. `company` is the
 * employer of the entry's job, when known. Each rule has a fixed title, except the run digest, whose
 * title carries the count.
 */
export function notificationFor(event: Pick<EventRecord, 'type' | 'message' | 'data'>, company: string | null = null): Note | null {
  const who = company?.trim() || 'A job site'
  switch (event.type) {
    case 'submit_failed':
      // The person's own report. It comes first, because the note they wrote can mention anything.
      if (event.message.startsWith('Auto-submit paused')) return { title: 'Auto-submit paused', body: event.message }
      if (CAPTCHA.test(event.message)) {
        return { title: 'A captcha stopped an application', body: `${who} showed a captcha. Open JobPilot and solve it in the browser window.` }
      }
      if (SIGN_IN.test(event.message)) {
        return { title: 'JobPilot needs you to sign in', body: `${who} wants you to sign in before JobPilot can apply. Open JobPilot to finish it.` }
      }
      return null
    case 'budget_stop':
      return { title: 'AI budget reached for today', body: 'JobPilot paused its AI work. Raise the budget in Settings or wait for it to reset.' }
    case 'rate_limit_stop':
      return { title: 'AI provider limit reached', body: 'Your AI provider turned requests away, so JobPilot paused its AI work. It tries again on the next run.' }
    case 'run_finished': {
      const submitted = num(event.data?.submitted)
      if (submitted <= 0) return null
      const newJobs = num(event.data?.newJobs)
      const shortlisted = num(event.data?.shortlisted)
      const prepared = num(event.data?.prepared)
      return {
        title: `Sent ${count(submitted, 'application')}`,
        body: `This run found ${count(newJobs, 'new job')}, shortlisted ${shortlisted} and prepared ${prepared}.`
      }
    }
    case 'error':
      // Only the crash handlers mark their entries. Ordinary errors are too frequent to interrupt anyone.
      return event.data?.process === true ? { title: 'JobPilot hit an unexpected error', body: event.message } : null
    default:
      return null
  }
}

/** The cooldown group of a notification. Digests with different counts share one. */
function kindOf(note: Note): string {
  return note.title.startsWith('Sent ') ? 'run_finished' : note.title
}

/** Keys that were last used less than `cooldownMs` ago are held back. */
export class Cooldown {
  private readonly last = new Map<string, number>()

  constructor(
    private readonly cooldownMs: number = NOTIFY_COOLDOWN_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** True, and starts the cooldown, when the key may go out now. */
  take(key: string): boolean {
    const at = this.now()
    const before = this.last.get(key)
    if (before !== undefined && at - before < this.cooldownMs) return false
    this.last.set(key, at)
    return true
  }
}

export interface NotifierDeps {
  /** Reads `system.notifications` and `Notification.isSupported()` at the moment of the call. */
  canNotify: () => boolean
  /** Shows the notification. The click handler is index.ts's job. */
  show: (note: Note) => void
  /** The employer's name for an event's job. */
  companyFor: (jobId: string) => string | null
  now?: () => number
}

export class Notifier {
  private readonly cooldown: Cooldown

  constructor(private readonly deps: NotifierDeps) {
    this.cooldown = new Cooldown(NOTIFY_COOLDOWN_MS, deps.now)
  }

  /** Shows a notification for the event when a rule matches and its cooldown has passed. Returns whether one was shown. */
  handle(event: EventRecord): boolean {
    if (!this.deps.canNotify()) return false
    const note = notificationFor(event, event.jobId ? this.deps.companyFor(event.jobId) : null)
    if (!note || !this.cooldown.take(kindOf(note))) return false
    try {
      this.deps.show(note)
    } catch {
      // A notification that can't be shown must not break the run that caused it.
      return false
    }
    return true
  }
}
