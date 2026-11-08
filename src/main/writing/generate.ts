import { z } from 'zod'
import type { LintReport, LlmTask, Profile, Settings } from '@shared/types'
import { LlmFormatError, LlmRefusalError } from '../llm/errors'
import type { LlmService } from '../llm/service'
import { firstName, fitToLength } from '../util/text'
import { issuesToInstructions, lintText, type LintOptions } from './lint'
import {
  answerGuidance,
  answerPrompt,
  answersBatchPrompt,
  buildCandidateContext,
  buildWritingSystem,
  coverLetterPrompt,
  type JobForWriting,
  LENGTH_TARGETS,
  PROMPT_VERSIONS,
  reviseBatchPrompt,
  revisePrompt,
  type WritingSample
} from './prompts'
import { replaceDashes } from './rules'

export interface WritingInputs {
  profile: Profile
  samples: WritingSample[]
  settings: Settings
}

export interface WrittenText {
  text: string
  lint: LintReport
  /** Set when the model said it can't answer truthfully from the profile. */
  needsInput: string | null
  revisions: number
  costUsd: number
}

const NEEDS_INPUT = /^\s*NEEDS_INPUT:\s*(.+)$/im

/** Strips wrappers models sometimes add despite instructions. */
export function cleanOutput(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^```[a-z]*\n?|```$/g, '').trim()
  // A first line like "Here is the cover letter:" or "Sure!" is chatter, not content.
  text = text.replace(/^(?:here(?:'s| is)[^\n]*:|sure[!.,][^\n]*)\n+/i, '').trim()
  if (/^"[\s\S]*"$/.test(text) && !text.slice(1, -1).includes('"')) text = text.slice(1, -1).trim()
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
  return text.replace(/\n{3,}/g, '\n\n')
}

/** Fixes that need no model: dashes become commas, and over-limit text is cut at a sentence end. */
function applyLastResortFixes(text: string, lint: LintReport, lintOptions: LintOptions, maxChars: number | null): { text: string; lint: LintReport } {
  let best = text
  let bestLint = lint
  if (bestLint.issues.some((i) => i.rule === 'em-dash')) {
    best = replaceDashes(best)
    bestLint = lintText(best, lintOptions)
  }
  if (maxChars !== null && best.length > maxChars) {
    best = fitToLength(best, maxChars)
    bestLint = lintText(best, lintOptions)
  }
  return { text: best, lint: bestLint }
}

interface DraftOptions {
  task: LlmTask
  jobId: string
  prompt: string
  promptVersion: string
  lintOptions: LintOptions
  maxChars: number | null
  regenerate: boolean
}

/**
 * Writes a draft, checks it with the linter and sends it back for targeted revision until it
 * passes the user's minimum score or the revision limit is reached. Keeps the best version.
 */
async function draftWithReview(llm: LlmService, inputs: WritingInputs, opts: DraftOptions): Promise<WrittenText> {
  const system = buildWritingSystem(inputs.settings)
  const context = buildCandidateContext(inputs.profile, inputs.samples)
  const { minLintScore, maxRevisions } = inputs.settings.writing

  const first = await llm.text({
    task: opts.task,
    stage: 'writing',
    jobId: opts.jobId,
    promptVersion: opts.promptVersion,
    system,
    context,
    prompt: opts.prompt,
    effort: 'medium',
    useCache: !opts.regenerate
  })
  let cost = first.costUsd

  const needs = first.value.match(NEEDS_INPUT)
  if (needs) {
    return { text: '', lint: lintText(''), needsInput: needs[1].trim(), revisions: 0, costUsd: cost }
  }

  let best = cleanOutput(first.value)
  let bestLint = lintText(best, opts.lintOptions)
  let revisions = 0
  const tooLong = () => opts.maxChars !== null && best.length > opts.maxChars

  while ((bestLint.score < minLintScore || tooLong()) && revisions < maxRevisions) {
    revisions++
    let problems = issuesToInstructions(bestLint)
    if (tooLong()) problems += `\n- It is ${best.length} characters. The limit is ${opts.maxChars}.`
    const revised = await llm.text({
      task: 'revise',
      stage: 'writing',
      jobId: opts.jobId,
      promptVersion: PROMPT_VERSIONS.revise,
      system,
      context,
      prompt: revisePrompt(best, problems, opts.maxChars),
      effort: 'medium',
      useCache: !opts.regenerate
    })
    cost += revised.costUsd
    const candidate = cleanOutput(revised.value)
    if (NEEDS_INPUT.test(candidate) || candidate.length < best.length * 0.4) break
    const candidateLint = lintText(candidate, opts.lintOptions)
    const fits = opts.maxChars === null || candidate.length <= opts.maxChars
    if (candidateLint.score >= bestLint.score || (fits && tooLong())) {
      best = candidate
      bestLint = candidateLint
    }
  }

  const fixed = applyLastResortFixes(best, bestLint, opts.lintOptions, opts.maxChars)
  return { text: fixed.text, lint: fixed.lint, needsInput: null, revisions, costUsd: cost }
}

function coverLetterLintOptions(inputs: WritingInputs): LintOptions {
  const target = LENGTH_TARGETS[inputs.settings.writing.coverLetterLength]
  // The greeting and sign-off add a few words on top of the body target.
  return { extraBanned: inputs.settings.writing.bannedPhrases, targetWords: { min: Math.round(target.min * 0.85), max: Math.round(target.max * 1.15) + 10 } }
}

export async function writeCoverLetter(
  llm: LlmService,
  inputs: WritingInputs,
  job: JobForWriting,
  options: { guidance?: string | null; regenerate?: boolean } = {}
): Promise<WrittenText> {
  const length = inputs.settings.writing.coverLetterLength
  return draftWithReview(llm, inputs, {
    task: 'cover_letter',
    jobId: job.id,
    prompt: coverLetterPrompt(job, length, firstName(inputs.profile.fullName), options.guidance ?? null),
    promptVersion: PROMPT_VERSIONS.coverLetter,
    lintOptions: coverLetterLintOptions(inputs),
    maxChars: null,
    regenerate: options.regenerate ?? false
  })
}

export async function writeAnswer(
  llm: LlmService,
  inputs: WritingInputs,
  job: JobForWriting,
  question: { label: string; maxLength: number | null; long: boolean },
  options: { guidance?: string | null; regenerate?: boolean } = {}
): Promise<WrittenText> {
  return draftWithReview(llm, inputs, {
    task: 'answers',
    jobId: job.id,
    prompt: answerPrompt(job, question, options.guidance ?? null),
    promptVersion: PROMPT_VERSIONS.answer,
    lintOptions: { extraBanned: inputs.settings.writing.bannedPhrases },
    maxChars: question.maxLength,
    regenerate: options.regenerate ?? false
  })
}

// ---------------------------------------------------------------------------
// One call for all the open answers of an application
// ---------------------------------------------------------------------------

export interface BatchQuestion {
  key: string
  label: string
  maxLength: number | null
  long: boolean
  /** The person's own earlier answer. The model keeps its facts and wording and adapts a sentence or two. */
  baseAnswer?: string | null
  guidance?: string | null
}

export interface BatchOptions {
  regenerate?: boolean
  /** Also write the cover letter, in the same call when more than one text is needed. */
  coverLetter?: { guidance?: string | null } | null
}

export interface BatchResult {
  /** By question key. A question the model declined is in `refused` instead. */
  answers: Map<string, WrittenText>
  refused: Set<string>
  /** Null when no letter was asked for. */
  letter: WrittenText | null
  /** Everything the calls cost. The costUsd on each batched text is left at 0 so nothing is counted twice. */
  costUsd: number
}

const LETTER_ID = 'letter'

const BatchAnswersSchema = z.object({
  answers: z.array(z.object({ key: z.string(), answer: z.string() })),
  letter: z.string().nullable().optional()
})

const BatchRevisionSchema = z.object({
  answers: z.array(z.object({ key: z.string(), answer: z.string() }))
})

interface BatchItem {
  id: string
  /** Null for the cover letter. */
  question: BatchQuestion | null
  text: string
  lint: LintReport
  needsInput: string | null
  revisions: number
  lintOptions: LintOptions
  maxChars: number | null
  /** The last revision was unusable, so this text is not sent again. */
  stuck: boolean
}

function toItem(id: string, question: BatchQuestion | null, raw: string, lintOptions: LintOptions, maxChars: number | null): BatchItem {
  const needs = raw.match(NEEDS_INPUT)
  if (needs) return { id, question, text: '', lint: lintText(''), needsInput: needs[1].trim(), revisions: 0, lintOptions, maxChars, stuck: true }
  const text = cleanOutput(raw)
  return { id, question, text, lint: lintText(text, lintOptions), needsInput: null, revisions: 0, lintOptions, maxChars, stuck: false }
}

/**
 * Writes every open-ended answer of one application in a single call, with the cover letter in the
 * same call when one is wanted. Each text goes through the linter on its own. The ones under the
 * minimum score are revised together, one call per round, up to the revision limit, and the best
 * version of each is kept. A text the reply leaves out, or all of them when the reply can't be
 * read, is written again with the single-answer path. A lone question with no letter skips the batch.
 */
export async function writeApplicationAnswers(
  llm: LlmService,
  inputs: WritingInputs,
  job: JobForWriting,
  questions: BatchQuestion[],
  options: BatchOptions = {}
): Promise<BatchResult> {
  const regenerate = options.regenerate ?? false
  const wantsLetter = Boolean(options.coverLetter)
  const result: BatchResult = { answers: new Map(), refused: new Set(), letter: null, costUsd: 0 }

  const writeSingle = async (q: BatchQuestion) => {
    try {
      const written = await writeAnswer(llm, inputs, job, q, { guidance: answerGuidance(q.baseAnswer ?? null, q.guidance ?? null), regenerate })
      result.costUsd += written.costUsd
      result.answers.set(q.key, written)
    } catch (err) {
      if (!(err instanceof LlmRefusalError)) throw err
      result.refused.add(q.key)
    }
  }
  const writeLetterSingle = async () => {
    const written = await writeCoverLetter(llm, inputs, job, { guidance: options.coverLetter?.guidance ?? null, regenerate })
    result.costUsd += written.costUsd
    result.letter = written
  }

  if (questions.length === 0 && !wantsLetter) return result
  if (questions.length === 0) {
    await writeLetterSingle()
    return result
  }
  if (questions.length === 1 && !wantsLetter) {
    await writeSingle(questions[0])
    return result
  }

  const system = buildWritingSystem(inputs.settings)
  const context = buildCandidateContext(inputs.profile, inputs.samples)
  const { minLintScore, maxRevisions, coverLetterLength, bannedPhrases } = inputs.settings.writing
  const ids = new Map(questions.map((q, i) => [`q${i + 1}`, q]))

  let reply: z.infer<typeof BatchAnswersSchema> | null = null
  try {
    const first = await llm.json({
      task: 'answers',
      stage: 'writing',
      jobId: job.id,
      promptVersion: PROMPT_VERSIONS.answersBatch,
      system,
      context,
      prompt: answersBatchPrompt(
        job,
        [...ids].map(([id, q]) => ({ id, label: q.label, maxLength: q.maxLength, long: q.long, baseAnswer: q.baseAnswer ?? null, guidance: q.guidance ?? null })),
        wantsLetter ? { length: coverLetterLength, firstName: firstName(inputs.profile.fullName), guidance: options.coverLetter?.guidance ?? null } : null
      ),
      schema: BatchAnswersSchema,
      schemaName: 'application_answers',
      effort: 'medium',
      useCache: !regenerate
    })
    result.costUsd += first.costUsd
    reply = first.value
  } catch (err) {
    // An unreadable or declined reply is not final. Each text is asked for on its own below.
    if (!(err instanceof LlmFormatError) && !(err instanceof LlmRefusalError)) throw err
  }

  const items: BatchItem[] = []
  const seen = new Set<string>()
  for (const entry of reply?.answers ?? []) {
    const q = ids.get(entry.key)
    if (!q || seen.has(entry.key) || !entry.answer.trim()) continue
    seen.add(entry.key)
    items.push(toItem(entry.key, q, entry.answer, { extraBanned: bannedPhrases }, q.maxLength))
  }
  const letterRaw = reply?.letter?.trim()
  if (wantsLetter && letterRaw) items.push(toItem(LETTER_ID, null, letterRaw, coverLetterLintOptions(inputs), null))

  // Texts under the minimum score are revised together, one call per round.
  const tooLong = (i: BatchItem) => i.maxChars !== null && i.text.length > i.maxChars
  for (let round = 0; round < maxRevisions; round++) {
    const failing = items.filter((i) => !i.stuck && (i.lint.score < minLintScore || tooLong(i)))
    if (failing.length === 0) break
    let revised
    try {
      revised = await llm.json({
        task: 'revise',
        stage: 'writing',
        jobId: job.id,
        promptVersion: PROMPT_VERSIONS.reviseBatch,
        system,
        context,
        prompt: reviseBatchPrompt(
          failing.map((i) => {
            let problems = issuesToInstructions(i.lint)
            if (tooLong(i)) problems += `\n- It is ${i.text.length} characters. The limit is ${i.maxChars}.`
            return { id: i.id, draft: i.text, problems, maxChars: i.maxChars }
          })
        ),
        schema: BatchRevisionSchema,
        schemaName: 'revised_answers',
        effort: 'medium',
        useCache: !regenerate
      })
    } catch (err) {
      if (!(err instanceof LlmFormatError) && !(err instanceof LlmRefusalError)) throw err
      break
    }
    result.costUsd += revised.costUsd
    const byId = new Map(revised.value.answers.map((a) => [a.key, a.answer]))
    for (const item of failing) {
      item.revisions++
      const raw = byId.get(item.id)
      if (raw === undefined) continue
      const candidate = cleanOutput(raw)
      if (NEEDS_INPUT.test(candidate) || candidate.length < item.text.length * 0.4) {
        item.stuck = true
        continue
      }
      const candidateLint = lintText(candidate, item.lintOptions)
      const fits = item.maxChars === null || candidate.length <= item.maxChars
      if (candidateLint.score >= item.lint.score || (fits && tooLong(item))) {
        item.text = candidate
        item.lint = candidateLint
      }
    }
  }

  for (const item of items) {
    const fixed = item.needsInput ? { text: item.text, lint: item.lint } : applyLastResortFixes(item.text, item.lint, item.lintOptions, item.maxChars)
    const out: WrittenText = { ...fixed, needsInput: item.needsInput, revisions: item.revisions, costUsd: 0 }
    if (item.question) result.answers.set(item.question.key, out)
    else result.letter = out
  }

  // Whatever the reply left out is written on its own.
  for (const q of questions) {
    if (!result.answers.has(q.key)) await writeSingle(q)
  }
  if (wantsLetter && !result.letter) await writeLetterSingle()
  return result
}
