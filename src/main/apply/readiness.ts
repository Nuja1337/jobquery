import { answerNeedsUser, isUnreviewedLive } from '@shared/answers'
import type { Application, ApplicationStatus, FormField, LintReport, PreparedAnswer, Profile, Settings } from '@shared/types'
import { coverLetterLintOptions, jobWritingContext } from '../writing/generate'
import { failureReason, HELD_LETTER_NOTE, lettersCheckPasses, lintText } from '../writing/lint'
import { questionLimits, type JobForWriting } from '../writing/prompts'
import { COVER_LETTER_PDF, HELD_UPLOAD_NOTE } from './answers'
import { isCoverLetterField } from './fieldMap'

type Opened = Pick<Application, 'status' | 'submitMode' | 'submitClickedAt' | 'formFields'>

/** The style check result for the cover letter, and the score it needs. Without a report the letter is not held. */
export interface LetterCheck {
  lint: LintReport | null
  minLintScore: number
}

/** True when the letter has a report that fails: under the minimum score, a blocking issue, or a grounding issue. */
export function letterHeld(letter: LetterCheck | null | undefined): boolean {
  return Boolean(letter?.lint) && !lettersCheckPasses(letter!.lint!, letter!.minLintScore)
}

/**
 * Checks the letter an application carries again, held against the job and the profile like a letter just written.
 * No model is called. An application made ready before the grounding hold existed can carry a letter that the check
 * now holds back. Null when the application has no letter.
 */
export function recheckLetter(app: Pick<Application, 'coverLetter' | 'formFields'>, job: JobForWriting, profile: Profile, settings: Settings): LetterCheck | null {
  const text = app.coverLetter?.trim()
  if (!text) return null
  const writing = jobWritingContext(job, profile)
  // A letter that goes into a text box with a character limit was written to fit the smallest one.
  const limits = app.formFields.flatMap((f) => (f.type !== 'file' && isCoverLetterField(f) ? [questionLimits(f).maxChars] : [])).filter((n): n is number => n !== null)
  const maxChars = limits.length ? Math.min(...limits) : null
  const lint = lintText(text, coverLetterLintOptions({ settings }, maxChars, writing.allowedTerms, { source: writing.grounding, kind: 'letter' }))
  return { lint, minLintScore: settings.writing.minLintScore }
}

/**
 * True when the form needs the letter: a required upload attaches it as a PDF, or a cover letter box holds its text.
 * An optional upload does not count. A held letter is left off it and the application goes on.
 */
export function letterInUse(fields: FormField[], answers: PreparedAnswer[]): boolean {
  const needed = (a: PreparedAnswer) => fields.find((f) => f.key === a.fieldKey)?.required ?? a.required
  return answers.some((a) => a.value === COVER_LETTER_PDF && needed(a)) || fields.some((f) => (f.type === 'textarea' || f.type === 'text') && isCoverLetterField(f))
}

/**
 * Keeps optional cover letter uploads in step with the letter. A letter the style check holds back is dropped
 * from them, with a note. A letter that passes is attached again where an earlier hold left one empty.
 * Required uploads and text boxes are not touched here, since a held letter holds those applications.
 */
export function syncOptionalLetterUploads(fields: FormField[], answers: PreparedAnswer[], letterText: string | null | undefined, held: boolean): PreparedAnswer[] {
  if (!letterText?.trim()) return answers
  const optional = new Set(fields.filter((f) => f.type === 'file' && f.fileHint === 'cover_letter' && !f.required).map((f) => f.key))
  let changed = false
  const out = answers.map((a) => {
    if (!optional.has(a.fieldKey)) return a
    if (held && a.value === COVER_LETTER_PDF) {
      changed = true
      return { ...a, value: '', note: HELD_UPLOAD_NOTE }
    }
    if (!held && a.value === '' && a.note === HELD_UPLOAD_NOTE) {
      changed = true
      return { ...a, value: COVER_LETTER_PDF, note: 'Your cover letter is attached as a PDF.' }
    }
    return a
  })
  return changed ? out : answers
}

/** The note shown to the person when a letter is held. It names the top issue. */
export function heldLetterNote(letter: LetterCheck): string {
  const why = letter.lint ? failureReason(letter.lint, letter.minLintScore) : ''
  return `${HELD_LETTER_NOTE} ${why} Edit it until it passes, or send this application yourself from Review.`.replace('  ', ' ')
}

/**
 * The status an edited draft should have, or null to leave it alone. A draft moves between 'ready'
 * and 'needs_attention' by how many answers still need the person. It never moves when the
 * application was opened for sending (the user may have sent it by hand, and a flip back to ready
 * could send it twice), or when the form was never read. It doesn't become ready while an answer
 * points at a cover letter that doesn't exist, and it goes back to 'needs_attention' when the letter
 * is cleared while an answer still points at it. An answer written on the live form that no person has
 * saved yet also keeps it from being ready, since autopilot would stop at it anyway. A cover letter the
 * style check holds back keeps it in 'needs_attention' too, until an edit makes the letter pass.
 */
export function statusAfterEdit(app: Opened, answers: PreparedAnswer[], coverLetter: string | null, letter?: LetterCheck | null): ApplicationStatus | null {
  if (app.status !== 'ready' && app.status !== 'needs_attention') return null
  if (app.submitMode !== null || app.submitClickedAt !== null) return null
  if (app.formFields.length === 0) return null
  // An answer that attaches a cover letter nobody wrote keeps the draft from being ready.
  const missingLetter = !coverLetter?.trim() && answers.some((a) => a.value === COVER_LETTER_PDF)
  const held = Boolean(coverLetter?.trim()) && letterHeld(letter) && letterInUse(app.formFields, answers)
  const next = answers.some(answerNeedsUser) || answers.some(isUnreviewedLive) || missingLetter || held ? 'needs_attention' : 'ready'
  return next === app.status ? null : next
}
