import type { FieldType, PreparedAnswer } from './types'

// One definition of "needs you" and "a guess", used by the Review page, the application list and
// auto mode, so the app never shows an application as ready that auto mode would refuse.

/** AI answers below this confidence count as guesses. Auto mode never clicks Submit on a guess. */
export const AUTO_SUBMIT_MIN_CONFIDENCE = 0.7

/**
 * True when the person has to answer or check this before the application can go out: flagged for
 * them, or required and still empty. An optional question never counts, even if an older draft
 * flagged it, because the form accepts it blank. A required box left unticked counts as empty, since the form
 * won't accept it, and so does a required multiple choice with nothing picked.
 */
export function answerNeedsUser(a: Pick<PreparedAnswer, 'needsUser' | 'required' | 'value' | 'type'>): boolean {
  if (!a.required) return false
  if (a.needsUser) return true
  if (a.type === 'file') return false
  const value = a.value.trim()
  if (a.type === 'checkbox') return value !== 'true'
  if (a.type === 'multiselect' || a.type === 'checkboxes') return value === '' || value === '[]'
  return value === ''
}

/** True for an AI answer that is filled in but below the confidence auto mode needs. */
export function isGuess(a: Pick<PreparedAnswer, 'needsUser' | 'value' | 'source' | 'confidence' | 'type'>): boolean {
  return a.type !== 'file' && !a.needsUser && a.value !== '' && a.source === 'ai' && a.confidence < AUTO_SUBMIT_MIN_CONFIDENCE
}

/** True for an answer written on the live form that no person has saved since. */
export function isUnreviewedLive(a: Pick<PreparedAnswer, 'liveOnly' | 'value' | 'type'>): boolean {
  return a.liveOnly === true && a.type !== 'file' && a.value !== ''
}

/** Topics only the person may answer. A saved answer on one of them is reused for the same question only. */
export const USER_ONLY_TOPICS: readonly string[] = ['ai_use_disclosure', 'criminal_history']

/** Field types that take a yes/no or a pick from a list. The same topic can ask the opposite question. */
export const CHOICE_FIELD_TYPES: readonly FieldType[] = ['checkbox', 'radio', 'select', 'combobox', 'multiselect', 'checkboxes']

/** Wording that makes a question an agreement or an attestation, where "Yes" to one wording is "No" to another. */
const ATTESTATION_WORDING = /\b(consent\w*|certif\w*|agree\w*|authori[sz]\w*|acknowledg\w*|background[- ]checks?)\b/i

/**
 * True when a saved answer to `saved` may answer `target` by topic. It does not when one question
 * asks for consent, a certification or a background check and the other does not, since the same
 * topic then asks opposite things ("Have you been convicted?" and "Do you consent to a background check?").
 */
export function sameAttestationWording(target: string, saved: string): boolean {
  return ATTESTATION_WORDING.test(target) === ATTESTATION_WORDING.test(saved)
}
