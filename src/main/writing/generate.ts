import { z } from 'zod'
import type { LintReport, LlmTask, Profile, Settings } from '@shared/types'
import { LlmFormatError, LlmRefusalError } from '../llm/errors'
import type { LlmService } from '../llm/service'
import { firstName, fitWholeSentences, trimDescription } from '../util/text'
import { asksAboutEmployer, GROUNDING_RULES, groundingIssues, groundingSource, isBetterLint, issuesToInstructions, lintPasses, lintText, type GroundingSource, type LintOptions } from './lint'
import {
  allowedTermsFor,
  answerGuidance,
  answerPrompt,
  answersBatchPrompt,
  buildCandidateContext,
  buildWritingSystem,
  coverLetterPrompt,
  type JobForWriting,
  LENGTH_TARGETS,
  type LinkRequest,
  PROMPT_VERSIONS,
  questionLimits,
  renderProfile,
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
  /**
   * Set when the text is longer than its field allows and no whole sentences fit (or it is a cover letter, which is
   * never cut). `text` is then the full draft. The caller flags the field and does not send it.
   */
  overLimit?: boolean
}

/** "NEEDS_INPUT: what is missing" anywhere in the text, also written "NEEDS INPUT:" or inside bold marks. */
const NEEDS_INPUT = /\bNEEDS[_ -]INPUT\b\**\s*:\**\s*(.+)/

/** What the writing and the style check need to know about one job. Built once per job and handed to every text written for it. */
export interface JobWritingContext {
  /** Banned terms the posting or the profile uses in a plain sense. They come off the banned list in the prompt and in the linter. */
  allowedTerms: string[]
  /** What the grounding checks hold a text against. */
  grounding: GroundingSource
}

export function jobWritingContext(job: JobForWriting, profile: Profile): JobWritingContext {
  return {
    allowedTerms: allowedTermsFor(job, profile),
    grounding: groundingSource({ title: job.title, company: job.company, description: job.description, profile: renderProfile(profile, 'writing'), notes: profile.notesForAi, experience: profile.experience })
  }
}

/** True when a text has a grounding issue: it names nothing from the posting, repeats the resume, or has numbers or names from neither source. */
function ungrounded(lint: LintReport): boolean {
  return groundingIssues(lint).length > 0
}

/**
 * The problems to hand a revision. A revision that has to tie the text to the posting also needs the posting, since
 * the revise prompt carries only the draft.
 */
function revisionProblems(lint: LintReport, description: string): string {
  const problems = issuesToInstructions(lint)
  if (!groundingIssues(lint).some((i) => i.rule === GROUNDING_RULES.noDetail)) return problems
  return `${problems}\n\nThe posting, to take details from. Use only what is true for the candidate.\n"""\n${trimDescription(description, 2500)}\n"""`
}

/**
 * Picks between the best text so far and a revision. A revision that fits replaces one that is too long. A revision
 * that is too long never replaces one that fits. Otherwise the better style result wins.
 */
function keepRevision(best: string, bestLint: LintReport, candidate: string, candidateLint: LintReport, maxChars: number | null, minLintScore: number): boolean {
  const fits = maxChars === null || candidate.length <= maxChars
  const bestFits = maxChars === null || best.length <= maxChars
  if (fits && !bestFits) return true
  if (!fits && bestFits) return false
  return isBetterLint(candidateLint, bestLint, minLintScore)
}

/** A revision this much shorter than the text it replaces dropped content. When the draft is over the limit, the limit sets the bar. */
function droppedContent(candidate: string, best: string, maxChars: number | null): boolean {
  return candidate.length < Math.min(best.length, maxChars ?? Infinity) * 0.4
}

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

/**
 * Fixes that need no model: dashes become commas, and over-limit text is cut at a sentence end. When not even the first
 * sentence fits, or `canCut` is false, the text stays as it is and `overLimit` is set.
 */
function applyLastResortFixes(
  text: string,
  lint: LintReport,
  lintOptions: LintOptions,
  maxChars: number | null,
  canCut = true
): { text: string; lint: LintReport; overLimit: boolean } {
  let best = text
  let bestLint = lint
  if (bestLint.issues.some((i) => i.rule === 'em-dash')) {
    best = replaceDashes(best)
    bestLint = lintText(best, lintOptions)
  }
  let overLimit = false
  if (maxChars !== null && best.length > maxChars) {
    const fitted = canCut ? fitWholeSentences(best, maxChars) : null
    if (fitted) {
      best = fitted
      bestLint = lintText(best, lintOptions)
    } else {
      overLimit = true
    }
  }
  return { text: best, lint: bestLint, overLimit }
}

interface DraftOptions {
  task: LlmTask
  jobId: string
  prompt: string
  promptVersion: string
  lintOptions: LintOptions
  /** Banned terms the posting or the profile uses in a plain sense. */
  allowedTerms: string[]
  /** The posting's text, for a revision that has to name something from it. */
  description: string
  maxChars: number | null
  /** False for a cover letter, which loses its sign-off if cut. */
  canCut?: boolean
  regenerate: boolean
  /** The question being answered, for the revision prompt. */
  question?: string | null
  /** The form's instruction for the question, for the revision prompt. */
  hint?: string | null
}

/**
 * Writes a draft, checks it with the linter and sends it back for targeted revision until it
 * passes the user's minimum score or the revision limit is reached. Keeps the best version.
 */
async function draftWithReview(llm: LlmService, inputs: WritingInputs, opts: DraftOptions): Promise<WrittenText> {
  const system = buildWritingSystem(inputs.settings, opts.allowedTerms)
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

  while ((!lintPasses(bestLint, minLintScore) || ungrounded(bestLint) || tooLong()) && revisions < maxRevisions) {
    revisions++
    let problems = revisionProblems(bestLint, opts.description)
    if (tooLong()) problems += `\n- It is ${best.length} characters. The limit is ${opts.maxChars}.`
    const revised = await llm.text({
      task: 'revise',
      stage: 'writing',
      jobId: opts.jobId,
      promptVersion: PROMPT_VERSIONS.revise,
      system,
      context,
      prompt: revisePrompt(best, problems, opts.maxChars, opts.question ?? null, opts.hint ?? null),
      effort: 'medium',
      useCache: !opts.regenerate
    })
    cost += revised.costUsd
    const candidate = cleanOutput(revised.value)
    if (NEEDS_INPUT.test(candidate) || droppedContent(candidate, best, opts.maxChars)) break
    const candidateLint = lintText(candidate, opts.lintOptions)
    if (keepRevision(best, bestLint, candidate, candidateLint, opts.maxChars, minLintScore)) {
      best = candidate
      bestLint = candidateLint
    }
  }

  const fixed = applyLastResortFixes(best, bestLint, opts.lintOptions, opts.maxChars, opts.canCut ?? true)
  return { text: fixed.text, lint: fixed.lint, needsInput: null, revisions, costUsd: cost, ...(fixed.overLimit ? { overLimit: true } : {}) }
}

/**
 * The style check options for a cover letter. The same options lint a letter the person edits. `allowedTerms` are the
 * banned terms the posting or the profile uses in a plain sense, from allowedTermsFor. `grounding` holds the letter
 * against the posting and the profile.
 */
export function coverLetterLintOptions(
  inputs: Pick<WritingInputs, 'settings'>,
  maxChars: number | null = null,
  allowedTerms: string[] = [],
  grounding?: LintOptions['grounding']
): LintOptions {
  const target = LENGTH_TARGETS[inputs.settings.writing.coverLetterLength]
  // The greeting and sign-off add a few words on top of the body target.
  let min = Math.round(target.min * 0.85)
  let max = Math.round(target.max * 1.15) + 10
  if (maxChars !== null) {
    // A text box with a character limit sets the length, so a short letter is not "too short".
    max = Math.min(max, Math.floor(maxChars / 5.5))
    min = Math.min(min, Math.round(max * 0.3))
  }
  return { extraBanned: inputs.settings.writing.bannedPhrases, targetWords: { min, max }, ...(allowedTerms.length ? { allowedTerms } : {}), ...(grounding ? { grounding } : {}) }
}

/** The style check options for an open answer. An answer adapted from the person's saved one is their own words, so it is not held against the profile. */
function answerLintOptions(inputs: Pick<WritingInputs, 'settings'>, ctx: JobWritingContext, label: string, guidance: string | null, adapted: boolean, maxWords: number | null = null): LintOptions {
  return {
    extraBanned: inputs.settings.writing.bannedPhrases,
    // A word limit the form states caps the answer. A field's character limit alone does not set a word target.
    ...(maxWords ? { targetWords: { min: 0, max: maxWords } } : {}),
    ...(ctx.allowedTerms.length ? { allowedTerms: ctx.allowedTerms } : {}),
    ...(adapted ? {} : { grounding: { source: ctx.grounding, kind: asksAboutEmployer(label) ? ('company' as const) : ('general' as const), extra: `${label}\n${guidance ?? ''}` } })
  }
}

export async function writeCoverLetter(
  llm: LlmService,
  inputs: WritingInputs,
  job: JobForWriting,
  options: { guidance?: string | null; regenerate?: boolean; maxChars?: number | null; context?: JobWritingContext } = {}
): Promise<WrittenText> {
  const length = inputs.settings.writing.coverLetterLength
  const maxChars = options.maxChars ?? null
  const ctx = options.context ?? jobWritingContext(job, inputs.profile)
  return draftWithReview(llm, inputs, {
    task: 'cover_letter',
    jobId: job.id,
    prompt: coverLetterPrompt(job, length, firstName(inputs.profile.fullName), options.guidance ?? null, maxChars),
    promptVersion: PROMPT_VERSIONS.coverLetter,
    lintOptions: coverLetterLintOptions(inputs, maxChars, ctx.allowedTerms, { source: ctx.grounding, kind: 'letter', extra: options.guidance ?? '' }),
    allowedTerms: ctx.allowedTerms,
    description: job.description,
    maxChars,
    canCut: false,
    regenerate: options.regenerate ?? false
  })
}

export async function writeAnswer(
  llm: LlmService,
  inputs: WritingInputs,
  job: JobForWriting,
  question: { label: string; maxLength: number | null; long: boolean; hint?: string | null; required?: boolean; link?: LinkRequest | null },
  options: { guidance?: string | null; regenerate?: boolean; context?: JobWritingContext; /** The guidance carries the person's own saved answer. */ adapted?: boolean } = {}
): Promise<WrittenText> {
  const ctx = options.context ?? jobWritingContext(job, inputs.profile)
  // The stricter of the field's own limit and the one its label or hint states.
  const limits = questionLimits(question)
  return draftWithReview(llm, inputs, {
    task: 'answers',
    jobId: job.id,
    prompt: answerPrompt(job, question, options.guidance ?? null),
    promptVersion: PROMPT_VERSIONS.answer,
    lintOptions: answerLintOptions(inputs, ctx, question.label, options.guidance ?? null, options.adapted ?? false, limits.maxWords),
    allowedTerms: ctx.allowedTerms,
    description: job.description,
    maxChars: limits.maxChars,
    regenerate: options.regenerate ?? false,
    question: question.label,
    hint: question.hint ?? null
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
  /** The form's own instruction for the question, such as "In 100 words or less". It is shown as quoted form text. */
  hint?: string | null
  required?: boolean
  /** Set when the form asks for a link. The prompt carries the owner's link, or tells the model there is none. */
  link?: LinkRequest | null
}

export interface BatchOptions {
  /** The job's allowed terms and grounding source, when the caller has built them. Built here otherwise. */
  context?: JobWritingContext
  regenerate?: boolean
  /** Also write the cover letter, in the same call when more than one text is needed. */
  coverLetter?: { guidance?: string | null; /** The character limit of the text box the letter goes into. */ maxChars?: number | null } | null
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
  const letterMaxChars = options.coverLetter?.maxChars ?? null
  const result: BatchResult = { answers: new Map(), refused: new Set(), letter: null, costUsd: 0 }
  // Worked out once for the job and shared by every text written for it.
  const ctx = options.context ?? jobWritingContext(job, inputs.profile)

  const writeSingle = async (q: BatchQuestion) => {
    try {
      const written = await writeAnswer(llm, inputs, job, q, { guidance: answerGuidance(q.baseAnswer ?? null, q.guidance ?? null), regenerate, context: ctx, adapted: Boolean(q.baseAnswer) })
      result.costUsd += written.costUsd
      result.answers.set(q.key, written)
    } catch (err) {
      if (!(err instanceof LlmRefusalError)) throw err
      result.refused.add(q.key)
    }
  }
  const writeLetterSingle = async () => {
    const written = await writeCoverLetter(llm, inputs, job, { guidance: options.coverLetter?.guidance ?? null, regenerate, maxChars: letterMaxChars, context: ctx })
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

  const system = buildWritingSystem(inputs.settings, ctx.allowedTerms)
  const context = buildCandidateContext(inputs.profile, inputs.samples)
  const { minLintScore, maxRevisions, coverLetterLength } = inputs.settings.writing
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
        [...ids].map(([id, q]) => ({ id, label: q.label, maxLength: q.maxLength, long: q.long, baseAnswer: q.baseAnswer ?? null, guidance: q.guidance ?? null, hint: q.hint ?? null, required: q.required, link: q.link ?? null })),
        wantsLetter ? { length: coverLetterLength, firstName: firstName(inputs.profile.fullName), guidance: options.coverLetter?.guidance ?? null, maxChars: letterMaxChars } : null
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
    const limits = questionLimits(q)
    items.push(toItem(entry.key, q, entry.answer, answerLintOptions(inputs, ctx, q.label, q.guidance ?? null, Boolean(q.baseAnswer), limits.maxWords), limits.maxChars))
  }
  const letterRaw = reply?.letter?.trim()
  if (wantsLetter && letterRaw) items.push(
      toItem(LETTER_ID, null, letterRaw, coverLetterLintOptions(inputs, letterMaxChars, ctx.allowedTerms, { source: ctx.grounding, kind: 'letter', extra: options.coverLetter?.guidance ?? '' }), letterMaxChars)
    )

  // Texts under the minimum score are revised together, one call per round.
  const tooLong = (i: BatchItem) => i.maxChars !== null && i.text.length > i.maxChars
  for (let round = 0; round < maxRevisions; round++) {
    const failing = items.filter((i) => !i.stuck && (!lintPasses(i.lint, minLintScore) || ungrounded(i.lint) || tooLong(i)))
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
            let problems = revisionProblems(i.lint, job.description)
            if (tooLong(i)) problems += `\n- It is ${i.text.length} characters. The limit is ${i.maxChars}.`
            return { id: i.id, question: i.question?.label ?? null, draft: i.text, problems, maxChars: i.maxChars, hint: i.question?.hint ?? null }
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
      if (NEEDS_INPUT.test(candidate) || droppedContent(candidate, item.text, item.maxChars)) {
        item.stuck = true
        continue
      }
      const candidateLint = lintText(candidate, item.lintOptions)
      if (keepRevision(item.text, item.lint, candidate, candidateLint, item.maxChars, minLintScore)) {
        item.text = candidate
        item.lint = candidateLint
      }
    }
  }

  for (const item of items) {
    // A cover letter is never cut. It loses its sign-off, so a letter that is still too long is flagged instead.
    const fixed = item.needsInput ? { text: item.text, lint: item.lint, overLimit: false } : applyLastResortFixes(item.text, item.lint, item.lintOptions, item.maxChars, item.question !== null)
    const out: WrittenText = { text: fixed.text, lint: fixed.lint, needsInput: item.needsInput, revisions: item.revisions, costUsd: 0, ...(fixed.overLimit ? { overLimit: true } : {}) }
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
