import type { PreparedAnswer } from './types'

// One definition of "needs you" and "a guess", used by the Review page, the application list and
// auto mode, so the app never shows an application as ready that auto mode would refuse.

/** AI answers below this confidence count as guesses. Auto mode never clicks Submit on a guess. */
export const AUTO_SUBMIT_MIN_CONFIDENCE = 0.7

/**
 * True when the person has to answer or check this before the application can go out: flagged for
 * them, or required and still empty. A required box left unticked counts as empty, since the form
 * won't accept it, and so does a required multiple choice with nothing picked.
 */
export function answerNeedsUser(a: Pick<PreparedAnswer, 'needsUser' | 'required' | 'value' | 'type'>): boolean {
  if (a.needsUser) return true
  if (!a.required || a.type === 'file') return false
  const value = a.value.trim()
  if (a.type === 'checkbox') return value !== 'true'
  if (a.type === 'multiselect' || a.type === 'checkboxes') return value === '' || value === '[]'
  return value === ''
}

/** True for an AI answer that is filled in but below the confidence auto mode needs. */
export function isGuess(a: Pick<PreparedAnswer, 'needsUser' | 'value' | 'source' | 'confidence' | 'type'>): boolean {
  return a.type !== 'file' && !a.needsUser && a.value !== '' && a.source === 'ai' && a.confidence < AUTO_SUBMIT_MIN_CONFIDENCE
}
