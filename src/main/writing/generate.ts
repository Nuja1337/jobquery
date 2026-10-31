import type { LintReport, LlmTask, Profile, Settings } from '@shared/types'
import type { LlmService } from '../llm/service'
import { firstName, fitToLength } from '../util/text'
import { issuesToInstructions, lintText, type LintOptions } from './lint'
import {
  answerPrompt,
  buildCandidateContext,
  buildWritingSystem,
  coverLetterPrompt,
  type JobForWriting,
  LENGTH_TARGETS,
  PROMPT_VERSIONS,
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

  // Last-resort fixes that need no model: dashes become commas, and over-limit text is cut at a sentence end.
  if (bestLint.issues.some((i) => i.rule === 'em-dash')) {
    best = replaceDashes(best)
    bestLint = lintText(best, opts.lintOptions)
  }
  if (opts.maxChars !== null && best.length > opts.maxChars) {
    best = fitToLength(best, opts.maxChars)
    bestLint = lintText(best, opts.lintOptions)
  }

  return { text: best, lint: bestLint, needsInput: null, revisions, costUsd: cost }
}

export async function writeCoverLetter(
  llm: LlmService,
  inputs: WritingInputs,
  job: JobForWriting,
  options: { guidance?: string | null; regenerate?: boolean } = {}
): Promise<WrittenText> {
  const length = inputs.settings.writing.coverLetterLength
  const target = LENGTH_TARGETS[length]
  return draftWithReview(llm, inputs, {
    task: 'cover_letter',
    jobId: job.id,
    prompt: coverLetterPrompt(job, length, firstName(inputs.profile.fullName), options.guidance ?? null),
    promptVersion: PROMPT_VERSIONS.coverLetter,
    // The greeting and sign-off add a few words on top of the body target.
    lintOptions: { extraBanned: inputs.settings.writing.bannedPhrases, targetWords: { min: Math.round(target.min * 0.85), max: Math.round(target.max * 1.15) + 10 } },
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
