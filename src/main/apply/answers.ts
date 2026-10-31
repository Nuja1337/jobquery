import { z } from 'zod'
import type { FormField, PreparedAnswer, Profile, Settings, SourceKind } from '@shared/types'
import { LlmRefusalError } from '../llm/errors'
import type { LlmService } from '../llm/service'
import { writeAnswer, type WritingInputs } from '../writing/generate'
import { renderProfile, type JobForWriting, type WritingSample } from '../writing/prompts'
import { trimDescription } from '../util/text'
import { isCoverLetterField, isLongAnswer, mapKnownField, mustAskUser, pickOption } from './fieldMap'

export interface SavedAnswer {
  id: string
  answer: string
  kind: 'fact' | 'template'
}

export interface AnswerDeps {
  llm: LlmService
  settings: Settings
  profile: Profile
  samples: WritingSample[]
  findSavedAnswer: (question: string) => SavedAnswer | null
  markAnswerUsed: (id: string) => void
  resumePath: string | null
}

export interface JobForAnswers extends JobForWriting {
  source: SourceKind
}

/** Marker stored as the value of a cover letter upload. The PDF is rendered right before filling. */
export const COVER_LETTER_PDF = '::cover-letter-pdf::'

const FormAnswersSchema = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      confidence: z.number(),
      needsUser: z.boolean(),
      note: z.string()
    })
  )
})

const FORM_SYSTEM = `You fill in short fields on a job application for one candidate.

- Use only facts from the candidate profile and the facts they gave. Never guess.
- For a field with options, the value must be one of the options, copied exactly. For fields that allow several options, join the chosen options with " | ".
- Yes/no questions about skills, tools or experience: answer from the profile. If the profile doesn't say, set needsUser to true and value to "".
- Never answer salary, start date, legal history, age, demographic or health questions unless the candidate's facts state the answer. Otherwise needsUser true.
- Never answer questions about whether or how the candidate used AI, and never agree to, certify or consent to anything for them. Set needsUser true.
- confidence is 0 to 1: how sure you are that the answer is correct and true for this candidate.
- note: empty, or a few words on what the candidate should check.
- Return one entry per field, using the field's key.`

function blank(field: FormField, patch: Partial<PreparedAnswer>): PreparedAnswer {
  return {
    fieldKey: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    value: '',
    source: 'ai',
    confidence: 0,
    needsUser: false,
    note: null,
    lint: null,
    ...patch
  }
}

function fromChoiceText(field: FormField, raw: string): string | null {
  if (field.type === 'multiselect' || field.type === 'checkboxes') {
    const picks = raw
      .split('|')
      .map((s) => pickOption(field.options, s.trim()))
      .filter((x): x is string => Boolean(x))
    return picks.length ? JSON.stringify([...new Set(picks)]) : null
  }
  if (field.options.length === 0) return raw
  return pickOption(field.options, raw)
}

/**
 * Answers every field on a form. Order of preference: the profile and settings (free),
 * the user's saved answers (free), one batched call to the cheap model for short fields,
 * and the writing model with the style check for open-ended questions.
 */
export async function answerFields(
  deps: AnswerDeps,
  job: JobForAnswers,
  fields: FormField[],
  coverLetter: string | null,
  options: { regenerateKeys?: Set<string>; guidance?: Map<string, string> } = {}
): Promise<{ answers: PreparedAnswer[]; costUsd: number }> {
  const results = new Map<string, PreparedAnswer>()
  const forModel: FormField[] = []
  const forWriting: Array<{ field: FormField; template: string | null }> = []
  let costUsd = 0

  for (const field of fields) {
    if (field.type === 'file') {
      if (field.fileHint === 'resume') {
        results.set(field.key, blank(field, { value: deps.resumePath ?? '', source: 'file', confidence: deps.resumePath ? 1 : 0, needsUser: !deps.resumePath && field.required, note: deps.resumePath ? null : 'Upload a resume in Profile first.' }))
      } else if (field.fileHint === 'cover_letter') {
        results.set(field.key, blank(field, { value: COVER_LETTER_PDF, source: 'file', confidence: 1, note: 'Your cover letter is attached as a PDF.' }))
      } else {
        results.set(field.key, blank(field, { source: 'file', needsUser: field.required, note: field.required ? 'This form wants another file. Attach it in the browser.' : null }))
      }
      continue
    }

    if (isCoverLetterField(field) && (field.type === 'textarea' || field.type === 'text')) {
      results.set(field.key, blank(field, { value: coverLetter ?? '', source: 'ai', confidence: coverLetter ? 0.9 : 0, needsUser: !coverLetter && field.required }))
      continue
    }

    // AI-use, legal and consent questions: only the user's own saved answer may fill them.
    // This runs before regenerate on purpose, so a click on Regenerate can't hand them to the AI.
    const ask = mustAskUser(field)
    if (ask) {
      const own = deps.findSavedAnswer(field.label)
      const value = own?.kind === 'fact' ? (isLongAnswer(field) ? own.answer : field.type === 'checkbox' ? (/^(yes|true|1|checked|agree)/i.test(own.answer) ? 'true' : 'false') : fromChoiceText(field, own.answer)) : null
      if (own && value) {
        deps.markAnswerUsed(own.id)
        results.set(field.key, blank(field, { value, source: 'answer_bank', confidence: 0.9, note: 'From your saved answers.' }))
      } else {
        results.set(field.key, blank(field, { source: 'settings', needsUser: true, note: ask }))
      }
      continue
    }

    const known = mapKnownField(field, { profile: deps.profile, settings: deps.settings, jobSource: job.source, jobLocation: job.location, company: job.company })
    if (known && !options.regenerateKeys?.has(field.key)) {
      results.set(field.key, blank(field, known))
      continue
    }

    const saved = deps.findSavedAnswer(field.label)
    if (saved && saved.kind === 'fact' && !options.regenerateKeys?.has(field.key)) {
      const value = isLongAnswer(field) ? saved.answer : fromChoiceText(field, saved.answer)
      if (value) {
        deps.markAnswerUsed(saved.id)
        results.set(field.key, blank(field, { value, source: 'answer_bank', confidence: 0.9 }))
        continue
      }
    }

    if (isLongAnswer(field)) forWriting.push({ field, template: saved?.kind === 'template' ? saved.answer : null })
    else forModel.push(field)
  }

  // One cheap call covers every short field that's left.
  if (forModel.length > 0) {
    try {
      const res = await deps.llm.json({
        task: 'form_map',
        stage: 'extraction',
        jobId: job.id,
        promptVersion: 'form-v1',
        system: FORM_SYSTEM,
        context: `CANDIDATE PROFILE\n${renderProfile(deps.profile)}`,
        prompt: `JOB\n${job.company}, ${job.title}${job.location ? `, ${job.location}` : ''}\n${trimDescription(job.description, 1500)}\n\nFIELDS\n${JSON.stringify(
          forModel.map((f) => ({ key: f.key, question: f.label, type: f.type, required: f.required, options: f.options.length ? f.options : undefined, maxLength: f.maxLength ?? undefined }))
        )}`,
        schema: FormAnswersSchema,
        schemaName: 'form_answers',
        effort: 'low',
        useCache: !forModel.some((f) => options.regenerateKeys?.has(f.key))
      })
      costUsd += res.costUsd
      const byKey = new Map(res.value.answers.map((a) => [a.key, a]))
      for (const field of forModel) {
        const a = byKey.get(field.key)
        if (!a || a.needsUser || !a.value.trim()) {
          results.set(field.key, blank(field, { needsUser: field.required, note: a?.note || (field.required ? 'The profile doesn\'t answer this. Fill it in.' : null) }))
          continue
        }
        const isChoice = ['select', 'radio', 'combobox', 'multiselect', 'checkboxes'].includes(field.type)
        const value = isChoice ? fromChoiceText(field, a.value) : field.type === 'checkbox' ? (/^(yes|true|1)$/i.test(a.value) ? 'true' : 'false') : a.value
        if (value === null) {
          results.set(field.key, blank(field, { needsUser: field.required, note: `The suggested answer "${a.value}" isn't one of the options.` }))
          continue
        }
        const confidence = Math.max(0, Math.min(1, a.confidence))
        results.set(field.key, blank(field, { value, confidence, note: a.note || null, needsUser: field.required && confidence < 0.5 }))
      }
    } catch (err) {
      if (!(err instanceof LlmRefusalError)) throw err
      for (const field of forModel) results.set(field.key, blank(field, { needsUser: field.required, note: 'The model declined this one. Fill it in.' }))
    }
  }

  // Open-ended questions go through the writing model and the style check, one at a time.
  const inputs: WritingInputs = { profile: deps.profile, samples: deps.samples, settings: deps.settings }
  for (const { field, template } of forWriting) {
    const userGuidance = options.guidance?.get(field.key) ?? null
    const guidance = [template ? `Their saved answer to a similar question, adapt it to ${job.company}:\n"${template}"` : null, userGuidance].filter(Boolean).join('\n\n') || null
    try {
      const written = await writeAnswer(deps.llm, inputs, job, { label: field.label, maxLength: field.maxLength, long: field.type === 'textarea' }, { guidance, regenerate: options.regenerateKeys?.has(field.key) })
      costUsd += written.costUsd
      if (written.needsInput) {
        results.set(field.key, blank(field, { needsUser: true, note: `Needs your input: ${written.needsInput}` }))
      } else {
        results.set(field.key, blank(field, { value: written.text, confidence: written.lint.score >= deps.settings.writing.minLintScore ? 0.85 : 0.6, lint: written.lint }))
      }
    } catch (err) {
      if (!(err instanceof LlmRefusalError)) throw err
      results.set(field.key, blank(field, { needsUser: true, note: 'The model declined this one. Write it yourself.' }))
    }
  }

  return { answers: fields.map((f) => results.get(f.key)!).filter(Boolean), costUsd }
}
