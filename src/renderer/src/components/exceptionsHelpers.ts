import type { ExceptionReason, NeedsYouGroup } from '@shared/types'
import { plural } from '../lib/format'

/** The heading of each "Couldn't send" section, in the order the sections are meant to read. */
export const REASON_HEADINGS: Record<ExceptionReason, string> = {
  captcha: 'A captcha stopped these',
  sign_in: 'These sites want you to sign in',
  multi_page: 'Forms with more than one page',
  job_board: "Job board pages, not the employer's form",
  no_submit_button: 'No submit button was found',
  form_rejected: 'The form rejected the submission',
  no_confirmation: 'No confirmation page appeared',
  timed_out: 'Timed out',
  browser: 'The browser could not open them',
  gave_up: 'Autopilot gave up after 3 tries',
  other: 'Other'
}

/** One line under a heading that says what the person can do about it. */
export const REASON_HINTS: Record<ExceptionReason, string> = {
  captcha: 'Open one, solve the captcha in the browser window and send it there.',
  sign_in: 'Open one and sign in. The browser remembers the login for the next ones.',
  multi_page: 'Autopilot does not click through several pages. Open one and finish it in the browser.',
  job_board: 'The posting links to a job board. Apply on the employer’s own site.',
  no_submit_button: 'Open one and press the button yourself.',
  form_rejected: 'The site refused an answer. Open one to see which.',
  no_confirmation: 'The app clicked Submit and saw no confirmation. Check your email or the company site before you send it again.',
  timed_out: 'The site was too slow. Retrying later often works.',
  browser: 'The browser did not start or the page did not load. Retrying later often works.',
  gave_up: 'Each failed three times. Open one to see why.',
  other: 'Open one to see what happened.'
}

/** "3 applications ask: Expected salary (USD)" */
export function askHeading(count: number, label: string): string {
  return `${count} ${count === 1 ? 'application asks' : 'applications ask'}: ${label}`
}

export type InputKind = 'select' | 'multi' | 'yesno' | 'date' | 'textarea' | 'number' | 'text'

/** Which control a group of questions gets. */
export function inputKindFor(group: Pick<NeedsYouGroup, 'type' | 'options'>): InputKind {
  if (group.type === 'checkbox') return 'yesno'
  if (group.options && group.options.length > 0) {
    if (group.type === 'multiselect' || group.type === 'checkboxes') return 'multi'
    return 'select'
  }
  if (group.type === 'date') return 'date'
  if (group.type === 'textarea') return 'textarea'
  if (group.type === 'number') return 'number'
  return 'text'
}

/** Saving to the answer bank is on for a question with a topic, and off for one only the person may answer. */
export function defaultSaveToBank(group: Pick<NeedsYouGroup, 'topic' | 'userOnly'>): boolean {
  return group.topic !== null && !group.userOnly
}

/** The toast after answering a group. */
export function answeredMessage(result: { updated: number; ready: number; skipped: number }): string {
  if (result.updated === 0) return 'Nothing changed. Those applications may have moved on.'
  const parts = [`Answered ${plural(result.updated, 'application')}.`, result.ready === 0 ? 'None are ready yet.' : result.ready === 1 ? '1 became ready.' : `${result.ready} became ready.`]
  if (result.skipped > 0) parts.push(`${plural(result.skipped, 'application')} could not take this answer.`)
  return parts.join(' ')
}

/** The toast after Retry later. */
export function retryMessage(result: { updated: number; skipped: number }): string {
  if (result.updated === 0) return 'None of them could go back in the queue.'
  const base = `${plural(result.updated, 'application')} will be tried again on the next run.`
  return result.skipped > 0 ? `${base} ${result.skipped} stayed here because they need you.` : base
}
