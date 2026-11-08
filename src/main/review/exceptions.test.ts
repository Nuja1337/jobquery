import { describe, expect, it } from 'vitest'
import type { FieldType, PreparedAnswer } from '@shared/types'
import { ingestRaw } from '../pipeline/ingest'
import { makeRaw, makeTestEnv } from '../testing'
import { buildExceptions, canRetryLater, classifyReason, cleanLabel, groupCouldNotSend, groupNeedsYou } from './exceptions'
import type { ReviewRow } from '../db/repos/applications'

const DAY = 86_400_000

function answer(label: string, patch: Partial<PreparedAnswer> = {}): PreparedAnswer {
  return {
    fieldKey: label.toLowerCase().replace(/\W+/g, '_'),
    label,
    type: 'text' as FieldType,
    required: true,
    options: [],
    value: '',
    source: 'ai',
    confidence: 0,
    needsUser: true,
    note: null,
    lint: null,
    ...patch
  }
}

function row(id: string, company: string, answers: PreparedAnswer[], patch: Partial<ReviewRow> = {}): ReviewRow {
  return { id, jobId: `job-${id}`, company, title: 'Engineer', status: 'needs_attention', answers, error: null, screenshotPath: null, submitMode: null, submitClickedAt: null, ...patch }
}

describe('groupNeedsYou', () => {
  it('groups the same salary question in USD across companies, whatever the wording', () => {
    const groups = groupNeedsYou([
      row('1', 'Acme', [answer('Expected salary (USD)')]),
      row('2', 'Globex', [answer('Salary expectations in USD *')])
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ topic: 'salary_expectation', scope: 'USD', count: 2 })
    expect(groups[0].applications.map((a) => a.company)).toEqual(['Acme', 'Globex'])
  })

  it('keeps opposite wordings of a user-only topic in separate groups', () => {
    const yesNo = { type: 'radio' as FieldType, options: ['Yes', 'No'] }
    const groups = groupNeedsYou([
      row('1', 'Acme', [answer('Have you been convicted of a felony?', yesNo)]),
      row('2', 'Globex', [answer('Do you consent to a criminal background check?', yesNo)]),
      row('3', 'Initech', [answer('Have you been convicted of a felony? *', yesNo)])
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => [g.label, g.count, g.userOnly])).toEqual([
      ['Have you been convicted of a felony?', 2, true],
      ['Do you consent to a criminal background check?', 1, true]
    ])
    expect(groups.every((g) => g.key.startsWith('label:') && g.wordings.length === 1)).toBe(true)
  })

  it('groups a yes/no or choice question by its wording even when it has a topic', () => {
    const yesNo = { type: 'radio' as FieldType, options: ['Yes', 'No'] }
    const groups = groupNeedsYou([
      row('1', 'Acme', [answer('Will you now or in the future require visa sponsorship?', yesNo)]),
      row('2', 'Globex', [answer('Do you agree to relocate at your own cost? Will you require sponsorship?', yesNo)])
    ])
    expect(groups).toHaveLength(2)
  })

  it('lists every distinct wording in a text group that shares a topic', () => {
    const groups = groupNeedsYou([
      row('1', 'Acme', [answer('Expected salary (USD)')]),
      row('2', 'Globex', [answer('Salary expectations in USD *')]),
      row('3', 'Initech', [answer('Expected salary (USD) (required)')])
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].wordings).toEqual(['Expected salary (USD)', 'Salary expectations in USD'])
  })

  it('keeps a salary question in GBP apart', () => {
    const groups = groupNeedsYou([row('1', 'Acme', [answer('Expected salary (USD)')]), row('2', 'Globex', [answer('Expected salary (GBP)')]), row('3', 'Initech', [answer('Expected salary (USD)')])])
    expect(groups.map((g) => [g.scope, g.count])).toEqual([
      ['USD', 2],
      ['GBP', 1]
    ])
  })

  it('groups a question without a topic by its normalized label', () => {
    const groups = groupNeedsYou([
      row('1', 'Acme', [answer("What's your favorite editor? *")]),
      row('2', 'Globex', [answer("what's your favorite editor (required)")]),
      row('3', 'Initech', [answer('Favorite shell')])
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ topic: null, scope: null, count: 2, label: expect.stringMatching(/favorite editor/i) })
    expect(groups[0].key.startsWith('label:')).toBe(true)
  })

  it('sets options only when every field offers the same list, and falls back to text otherwise', () => {
    const same = groupNeedsYou([
      row('1', 'Acme', [answer('T-shirt size', { type: 'select', options: ['S', 'M', 'L'] })]),
      row('2', 'Globex', [answer('T-shirt size', { type: 'select', options: ['S', 'M', 'L'] })])
    ])
    expect(same[0]).toMatchObject({ options: ['S', 'M', 'L'], type: 'select' })

    const differ = groupNeedsYou([
      row('1', 'Acme', [answer('T-shirt size', { type: 'select', options: ['S', 'M', 'L'] })]),
      row('2', 'Globex', [answer('T-shirt size', { type: 'select', options: ['Small', 'Large'] })])
    ])
    expect(differ[0]).toMatchObject({ options: null, type: 'text', count: 2 })
  })

  it('flags questions only the person may answer', () => {
    const groups = groupNeedsYou([
      row('1', 'Acme', [answer('Have you ever been convicted of a felony?', { type: 'radio', options: ['Yes', 'No'] })]),
      row('2', 'Globex', [answer('Favorite editor')])
    ])
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g]))
    expect(byLabel['Have you ever been convicted of a felony?'].userOnly).toBe(true)
    expect(byLabel['Favorite editor'].userOnly).toBe(false)
  })

  it('leaves out answers that do not need the person and applications that are not open', () => {
    const groups = groupNeedsYou([
      row('1', 'Acme', [answer('Favorite editor', { needsUser: false, value: 'vim' }), answer('Optional thing', { required: false })]),
      row('2', 'Globex', [answer('Favorite editor')], { status: 'submitted' }),
      row('3', 'Initech', [answer('Favorite editor')], { status: 'ready' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].applications.map((a) => a.id)).toEqual(['3'])
  })

  it('counts an application once when two of its fields fall in one group', () => {
    const groups = groupNeedsYou([row('1', 'Acme', [answer('Favorite editor', { fieldKey: 'a' }), answer('Favorite editor', { fieldKey: 'b' })])])
    expect(groups[0].count).toBe(1)
    expect(groups[0].applications.map((a) => a.fieldKey)).toEqual(['a', 'b'])
  })

  it('orders the biggest group first', () => {
    const groups = groupNeedsYou([row('1', 'A', [answer('Zebra question')]), row('2', 'B', [answer('Alpha question')]), row('3', 'C', [answer('Alpha question')])])
    expect(groups.map((g) => g.count)).toEqual([2, 1])
  })
})

describe('cleanLabel', () => {
  it('drops the required marker', () => {
    expect(cleanLabel('Your name *')).toBe('Your name')
    expect(cleanLabel('Your name (required)')).toBe('Your name')
  })
})

describe('classifyReason', () => {
  // The messages come from submitRun.ts, orchestrator.ts and ipc.ts.
  const cases: Array<[string, string]> = [
    ['captcha', 'The site asked for a captcha. Solve it in the browser window and press submit.'],
    ['sign_in', 'This site wants you to sign in first. Sign in in the browser window, then press Fill again. The browser remembers the login next time.'],
    ['multi_page', 'This form has more than one page. Use Fill and let me submit, then press Next and Submit in the browser.'],
    ['job_board', "This page is a job board, not the employer's form. Open the posting and apply on the company's site."],
    ['no_submit_button', "Couldn't find the submit button. Press it in the browser window."],
    ['form_rejected', 'The form rejected the submission. Phone number is invalid. Fix it in the browser and press submit.'],
    ['no_confirmation', 'No confirmation page appeared. Check the browser window to see what happened.'],
    ['no_confirmation', 'No confirmation page was seen. If you submitted it, click "I submitted it myself". Otherwise open it again.'],
    ['no_confirmation', 'The browser window closed before a confirmation page appeared. If you submitted it, click "I submitted it myself". Otherwise open it again.'],
    ['timed_out', 'Timed out while filling the form.'],
    ['timed_out', 'Timed out after clicking Submit. Check the company site or your email. If it went through, click "I submitted it myself".'],
    ['browser', "Couldn't open or fill the form. Could not open a browser. Install Chrome or Edge."],
    ['gave_up', "Couldn't open or fill the form. The page would not load. It failed 3 times, so autopilot left it for you."],
    ['other', 'The app closed while this was open in the browser. If you submitted it, click "I submitted it myself". Otherwise open it again.'],
    ['other', 'Preparing was interrupted. Check the answers or prepare it again.']
  ]
  it.each(cases)('reads %s', (reason, message) => {
    expect(classifyReason(message)).toBe(reason)
  })

  it('treats a missing error as other', () => {
    expect(classifyReason(null)).toBe('other')
  })

  it('does not call a captcha mentioned in a rejection a captcha', () => {
    expect(classifyReason('The form rejected the submission. Captcha is required. Fix it in the browser and press submit.')).toBe('form_rejected')
  })
})

describe('groupCouldNotSend', () => {
  it('groups needs-attention applications with no open answers by reason, biggest first', () => {
    const groups = groupCouldNotSend([
      row('1', 'A', [], { error: 'Timed out while filling the form.' }),
      row('2', 'B', [], { error: 'Timed out while filling the form.' }),
      row('3', 'C', [], { error: 'The site asked for a captcha. Solve it in the browser window and press submit.' }),
      row('4', 'D', [answer('Favorite editor')], { error: 'Timed out while filling the form.' }),
      row('5', 'E', [], { status: 'ready', error: 'Timed out while filling the form.' })
    ])
    expect(groups.map((g) => [g.reason, g.count])).toEqual([
      ['timed_out', 2],
      ['captcha', 1]
    ])
    expect(groups[0].applications[0]).toMatchObject({ id: '1', error: 'Timed out while filling the form.', screenshotPath: null, submitClickedAt: null })
  })
})

describe('canRetryLater', () => {
  const base = { status: 'needs_attention' as const, submitClickedAt: null, submitMode: null, lastAttemptBy: 'autopilot' as const }
  it('allows a passing reason with no click', () => {
    expect(canRetryLater({ ...base, error: 'Timed out while filling the form.' })).toBe(true)
    expect(canRetryLater({ ...base, error: "Couldn't open or fill the form. Could not open a browser." })).toBe(true)
  })
  it('refuses anything that was clicked or needs a person', () => {
    expect(canRetryLater({ ...base, submitClickedAt: '2026-01-01T00:00:00.000Z', error: 'No confirmation page appeared.' })).toBe(false)
    expect(canRetryLater({ ...base, error: 'The site asked for a captcha.' })).toBe(false)
    expect(canRetryLater({ ...base, error: "Couldn't open or fill the form. It failed 3 times, so autopilot left it for you." })).toBe(false)
    expect(canRetryLater({ ...base, status: 'ready', error: 'Timed out while filling the form.' })).toBe(false)
  })
  it('keeps a form the person opened in assist mode, since they may have sent it', () => {
    const message = 'The browser window closed before a confirmation page appeared.'
    expect(canRetryLater({ ...base, submitMode: 'assist', error: message })).toBe(false)
    expect(canRetryLater({ ...base, submitMode: null, error: message })).toBe(true)
  })
  it('keeps a form a person started, whatever the mode', () => {
    const timedOut = 'Timed out while filling the form.'
    expect(canRetryLater({ ...base, submitMode: 'auto', lastAttemptBy: 'user', error: timedOut })).toBe(false)
    expect(canRetryLater({ ...base, submitMode: 'auto', lastAttemptBy: 'autopilot', error: timedOut })).toBe(true)
    // An application from before the app recorded who started the attempt can still retry a timeout.
    expect(canRetryLater({ ...base, submitMode: 'auto', lastAttemptBy: null, error: timedOut })).toBe(true)
  })
  it('keeps a "no confirmation" unless autopilot made the attempt', () => {
    const message = 'No confirmation page appeared. Check the browser window.'
    expect(canRetryLater({ ...base, lastAttemptBy: 'user', submitMode: 'auto', error: message })).toBe(false)
    expect(canRetryLater({ ...base, lastAttemptBy: null, submitMode: 'auto', error: message })).toBe(false)
  })
})

describe('buildExceptions', () => {
  it('counts what was sent and samples at most five from today', async () => {
    const { ctx } = await makeTestEnv()
    const add = (n: number) => ctx.applications.create(ingestRaw(ctx, makeRaw({ company: `Co${n}`, externalId: `x${n}` })).job.id).id
    const now = new Date()
    const noon = new Date(now)
    noon.setHours(12, 0, 0, 0)
    const today = noon > now ? new Date(now.getTime() - 1000) : noon
    const todayIds = Array.from({ length: 7 }, (_, i) => add(i))
    for (const id of todayIds) ctx.applications.update(id, { status: 'submitted', submittedAt: today.toISOString(), screenshotPath: `/shots/${id}.png` })
    const lastWeek = add(20)
    ctx.applications.update(lastWeek, { status: 'submitted', submittedAt: new Date(now.getTime() - 3 * DAY).toISOString() })
    const old = add(21)
    ctx.applications.update(old, { status: 'submitted', submittedAt: new Date(now.getTime() - 30 * DAY).toISOString() })
    const waiting = add(22)
    ctx.applications.update(waiting, { status: 'ready' })
    const stuck = add(23)
    ctx.applications.update(stuck, { status: 'needs_attention', error: 'Timed out while filling the form.' })

    const report = buildExceptions(ctx.applications, now)
    expect(report.sent.today).toBe(7)
    expect(report.sent.week).toBe(8)
    expect(report.sent.sample).toHaveLength(5)
    expect(new Set(report.sent.sample.map((s) => s.id)).size).toBe(5)
    for (const s of report.sent.sample) {
      expect(todayIds).toContain(s.id)
      expect(s.screenshotPath).toBe(`/shots/${s.id}.png`)
    }
    expect(report.totals).toEqual({ ready: 1, needsAttention: 1 })
    expect(report.couldNotSend.map((g) => g.reason)).toEqual(['timed_out'])
  })

  it('returns fewer than five when fewer went out', async () => {
    const { ctx } = await makeTestEnv()
    const id = ctx.applications.create(ingestRaw(ctx, makeRaw({ externalId: 'only' })).job.id).id
    ctx.applications.update(id, { status: 'submitted' })
    const report = buildExceptions(ctx.applications)
    expect(report.sent.sample.map((s) => s.id)).toEqual([id])
  })
})
