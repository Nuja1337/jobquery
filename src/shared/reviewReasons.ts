import type { ExceptionReason } from './types'

// Why an application could not be sent, read from the error text it was left with. The messages come
// from submitRun.ts (the form and the click), orchestrator.ts (time limits) and ipc.ts (the browser).

/** Rules in order. The first match wins, so the specific messages come before the general ones. */
const REASON_RULES: Array<[ExceptionReason, RegExp]> = [
  // "...It failed 3 times, so autopilot left it for you." wraps another message, so it comes first.
  ['gave_up', /failed \d+ times|autopilot left it for you/i],
  // The text of a rejection can quote anything the form said, so it comes before the others.
  ['form_rejected', /rejected the submission/i],
  ['captcha', /captcha/i],
  ['multi_page', /more than one page/i],
  ['job_board', /job board/i],
  ['sign_in', /sign[ -]?in|log[ -]?in/i],
  ['no_submit_button', /submit button/i],
  ['timed_out', /timed out/i],
  ['no_confirmation', /no confirmation|before a confirmation page/i],
  ['browser', /couldn't open or fill|could not open|browser (?:crashed|would not start)|would not load/i]
]

/** The reason an application could not be sent, read from the error text it was left with. */
export function classifyReason(error: string | null | undefined): ExceptionReason {
  const text = error ?? ''
  for (const [reason, pattern] of REASON_RULES) if (pattern.test(text)) return reason
  return 'other'
}

/** Reasons that come from a slow site or a browser that failed, where another try can work. */
export const TRANSIENT_REASONS: ExceptionReason[] = ['timed_out', 'browser', 'no_confirmation']
