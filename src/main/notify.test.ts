import { describe, expect, it, vi } from 'vitest'
import type { EventRecord, EventType } from '@shared/types'
import { Cooldown, NOTIFY_COOLDOWN_MS, Notifier, type Note, notificationFor } from './notify'

function event(type: EventType, message: string, data: Record<string, unknown> | null = null, jobId: string | null = null): EventRecord {
  return { id: 'e', at: '2026-11-07T10:00:00.000Z', type, jobId, message, data }
}

describe('notificationFor', () => {
  it('asks for a sign-in and names the company', () => {
    const e = event('submit_failed', 'Engineer at Acme: This site wants you to sign in first. Sign in in the browser window, then press Fill again.')
    expect(notificationFor(e, 'Acme')).toEqual({
      title: 'JobPilot needs you to sign in',
      body: 'Acme wants you to sign in before JobPilot can apply. Open JobPilot to finish it.'
    })
  })

  it('reports a captcha', () => {
    const e = event('submit_failed', 'Engineer at Acme: The site asked for a captcha. Solve it in the browser window and press submit.')
    expect(notificationFor(e, 'Acme')?.title).toBe('A captcha stopped an application')
    expect(notificationFor(e, 'Acme')?.body).toContain('Acme')
  })

  it('falls back to a generic name when the company is unknown', () => {
    const e = event('submit_failed', 'x: captcha')
    expect(notificationFor(e)?.body).toContain('A job site')
  })

  it('ignores other submit failures', () => {
    expect(notificationFor(event('submit_failed', 'Engineer at Acme: "Desired salary" needs your answer.'), 'Acme')).toBeNull()
  })

  it('reports budget and rate limit stops', () => {
    expect(notificationFor(event('budget_stop', 'Daily budget used.'))?.title).toBe('AI budget reached for today')
    expect(notificationFor(event('rate_limit_stop', 'Limit.'))?.title).toBe('AI provider limit reached')
  })

  it('sends a digest only when a run sent applications', () => {
    const none = event('run_finished', 'Run finished.', { submitted: 0, newJobs: 4 })
    expect(notificationFor(none)).toBeNull()
    const some = event('run_finished', 'Run finished.', { submitted: 3, newJobs: 12, shortlisted: 5, prepared: 4 })
    expect(notificationFor(some)).toEqual({ title: 'Sent 3 applications', body: 'This run found 12 new jobs, shortlisted 5 and prepared 4.' })
    expect(notificationFor(event('run_finished', '', { submitted: 1, newJobs: 1 }))?.title).toBe('Sent 1 application')
  })

  it('tells about crashes but not ordinary errors', () => {
    expect(notificationFor(event('error', 'Could not prepare a job.'))).toBeNull()
    expect(notificationFor(event('error', 'A background task failed. boom', { process: true }))).toEqual({
      title: 'JobPilot hit an unexpected error',
      body: 'A background task failed. boom'
    })
  })

  it('ignores routine events', () => {
    for (const type of ['discovered', 'scored', 'prepared', 'submitted', 'run_started'] as const) expect(notificationFor(event(type, 'x'))).toBeNull()
  })
})

describe('Cooldown', () => {
  it('holds a key back for 30 minutes and then lets it through', () => {
    let t = 1_000_000
    const c = new Cooldown(NOTIFY_COOLDOWN_MS, () => t)
    expect(c.take('a')).toBe(true)
    expect(c.take('a')).toBe(false)
    t += NOTIFY_COOLDOWN_MS - 1
    expect(c.take('a')).toBe(false)
    t += 1
    expect(c.take('a')).toBe(true)
  })

  it('keeps keys apart', () => {
    const c = new Cooldown(NOTIFY_COOLDOWN_MS, () => 5)
    expect(c.take('a')).toBe(true)
    expect(c.take('b')).toBe(true)
  })
})

describe('Notifier', () => {
  function setup(canNotify = true) {
    let t = 0
    const shown: Note[] = []
    const notifier = new Notifier({
      canNotify: () => canNotify,
      show: (n) => shown.push(n),
      companyFor: (id) => (id === 'job1' ? 'Acme' : null),
      now: () => t
    })
    return { notifier, shown, advance: (ms: number) => (t += ms) }
  }

  it('sends one notification for a burst of the same kind', () => {
    const { notifier, shown, advance } = setup()
    const captcha = event('submit_failed', 'x: captcha', null, 'job1')
    expect(notifier.handle(captcha)).toBe(true)
    expect(notifier.handle(captcha)).toBe(false)
    advance(10 * 60_000)
    expect(notifier.handle(captcha)).toBe(false)
    advance(21 * 60_000)
    expect(notifier.handle(captcha)).toBe(true)
    expect(shown).toHaveLength(2)
    expect(shown[0].body).toContain('Acme')
  })

  it('does not let one kind silence another', () => {
    const { notifier, shown } = setup()
    notifier.handle(event('submit_failed', 'x: captcha'))
    notifier.handle(event('budget_stop', 'Budget.'))
    notifier.handle(event('submit_failed', 'x: This site wants you to sign in first.'))
    expect(shown.map((n) => n.title)).toEqual(['A captcha stopped an application', 'AI budget reached for today', 'JobPilot needs you to sign in'])
  })

  it('treats digests with different counts as one kind', () => {
    const { notifier, shown } = setup()
    notifier.handle(event('run_finished', '', { submitted: 2 }))
    notifier.handle(event('run_finished', '', { submitted: 5 }))
    expect(shown).toHaveLength(1)
  })

  it('stays quiet when notifications are off, and does not start a cooldown', () => {
    let on = false
    const shown: Note[] = []
    const notifier = new Notifier({ canNotify: () => on, show: (n) => shown.push(n), companyFor: () => null, now: () => 0 })
    expect(notifier.handle(event('budget_stop', 'Budget.'))).toBe(false)
    on = true
    expect(notifier.handle(event('budget_stop', 'Budget.'))).toBe(true)
    expect(shown).toHaveLength(1)
  })

  it('survives a notification that fails to show', () => {
    const notifier = new Notifier({
      canNotify: () => true,
      show: vi.fn(() => {
        throw new Error('no toast')
      }),
      companyFor: () => null
    })
    expect(notifier.handle(event('budget_stop', 'Budget.'))).toBe(false)
  })
})

describe('notificationFor an auto-submit pause', () => {
  it('shows the message under a fixed title, even when the note mentions a captcha or a sign-in', () => {
    const message = 'Auto-submit paused. You reported a wrong submission to Acme for Engineer. The captcha page said sign in.'
    expect(notificationFor(event('submit_failed', message), 'Acme')).toEqual({ title: 'Auto-submit paused', body: message })
  })

  it('only matches messages that start with the pause', () => {
    expect(notificationFor(event('submit_failed', 'Engineer at Acme: Auto-submit paused.'), 'Acme')).toBeNull()
  })
})
