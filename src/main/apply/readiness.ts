import { answerNeedsUser, isUnreviewedLive } from '@shared/answers'
import type { Application, ApplicationStatus, PreparedAnswer } from '@shared/types'
import { COVER_LETTER_PDF } from './answers'

type Opened = Pick<Application, 'status' | 'submitMode' | 'submitClickedAt' | 'formFields'>

/**
 * The status an edited draft should have, or null to leave it alone. A draft moves between 'ready'
 * and 'needs_attention' by how many answers still need the person. It never moves when the
 * application was opened for sending (the user may have sent it by hand, and a flip back to ready
 * could send it twice), or when the form was never read. It doesn't become ready while an answer
 * points at a cover letter that doesn't exist, and it goes back to 'needs_attention' when the letter
 * is cleared while an answer still points at it. An answer written on the live form that no person has
 * saved yet also keeps it from being ready, since autopilot would stop at it anyway.
 */
export function statusAfterEdit(app: Opened, answers: PreparedAnswer[], coverLetter: string | null): ApplicationStatus | null {
  if (app.status !== 'ready' && app.status !== 'needs_attention') return null
  if (app.submitMode !== null || app.submitClickedAt !== null) return null
  if (app.formFields.length === 0) return null
  // An answer that attaches a cover letter nobody wrote keeps the draft from being ready.
  const missingLetter = !coverLetter?.trim() && answers.some((a) => a.value === COVER_LETTER_PDF)
  const next = answers.some(answerNeedsUser) || answers.some(isUnreviewedLive) || missingLetter ? 'needs_attention' : 'ready'
  return next === app.status ? null : next
}
