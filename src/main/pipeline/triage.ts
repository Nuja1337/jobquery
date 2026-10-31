import { z } from 'zod'
import { bucketFor } from '@shared/defaults'
import type { FitAssessment, Job, JobPreferences, JobStage, Profile } from '@shared/types'
import type { AppContext } from '../context'
import { BudgetExceededError, NoModelConfiguredError } from '../llm/errors'
import { trimDescription } from '../util/text'
import { renderProfile } from '../writing/prompts'

/** Bump when the rubric or the prompt layout changes, so cached scores from the old one aren't reused. */
export const TRIAGE_PROMPT_VERSION = 'triage-v1'

export const TRIAGE_CONCURRENCY = 4
const DESCRIPTION_CHARS = 4000

/**
 * Number bounds are left out of the schema because some providers reject them.
 * Values are clamped after parsing instead.
 */
export const fitSchema = z.object({
  score: z.number(),
  summary: z.string(),
  matches: z.array(z.string()),
  gaps: z.array(z.string()),
  dealbreakers: z.array(z.string()),
  seniorityFit: z.enum(['under', 'match', 'over', 'unknown']),
  keywords: z.array(z.string())
})

/** Identical for every job, so providers can cache it. */
export const TRIAGE_SYSTEM = `You score how well one job posting fits one candidate. The score decides whether the candidate ever sees the job, so be accurate and honest. Never inflate a score to be kind.

How to score, from 0 to 100
- 85 to 100: a rare close match. The candidate meets nearly every hard requirement, the level is right, the work is what they are aiming for, and nothing in their preferences conflicts. Most good-looking jobs do not belong here.
- 70 to 84: a strong fit. The candidate meets the core requirements and has one or two gaps they could close quickly.
- 55 to 69: a possible fit. They meet about half of the core requirements, or the match is real but the level or the focus is a bit off.
- 40 to 54: a stretch. Some overlap, but a main requirement is missing or the day-to-day work is different from what they do.
- 0 to 39: not a fit. Wrong field, wrong level by a wide margin, or a dealbreaker.

Dealbreakers
A dealbreaker caps the score at 35. List each one in "dealbreakers". Only count a requirement when the posting states it as required, not as preferred or a plus.
- A security clearance the candidate does not hold.
- A degree, licence or certification the posting requires and the candidate lacks.
- A location or work authorization the candidate does not have, or a posting that refuses visa sponsorship when the candidate needs it.
- A language the candidate does not speak, when the posting requires it.
- A different profession, for example a nursing role for a software engineer.
A role far from the candidate's level, such as asking for ten years when they have two, caps the score at 50.

Rules
- Judge only from the candidate profile. Do not assume skills, tools or experience that are not listed. A closely related tool counts for part of a match.
- Separate "required" and "must have" from "preferred" and "nice to have". Missing a preferred item costs a few points at most.
- Check what the work is, not only the keywords. A posting that lists the candidate's tools but describes a different job is not a good fit.
- The candidate's preferences are soft. A posting that conflicts with them, such as on-site when they want remote, lowers the score by 10 to 20 points. It is a dealbreaker only if the posting makes it a hard requirement.
- If the posting lacks the detail to judge, score what you can see and say so in the summary. Do not guess in the candidate's favor.

Fields
- score: a whole number from 0 to 100.
- summary: one or two plain sentences that name the biggest reasons for the score.
- matches: up to 5 short phrases for requirements the candidate meets, in the posting's words.
- gaps: up to 5 short phrases for requirements they lack or cannot show.
- dealbreakers: hard dealbreakers only. Empty when there are none.
- seniorityFit: "match" when the level fits. "over" when the role is more senior than the candidate. "under" when the role is more junior than the candidate. "unknown" when the posting does not say.
- keywords: up to 8 terms from the posting that are true for the candidate and worth repeating in an application.`

function list(label: string, items: string[]): string | null {
  return items.length ? `${label}: ${items.join(', ')}` : null
}

/** The part of the preferences that bears on fit. Keep the order fixed so the text is the same every time. */
export function preferencesSummary(prefs: JobPreferences): string {
  const lines = [
    list('Target roles', prefs.targetTitles),
    list('Work types wanted', prefs.remote),
    list('Seniority wanted', prefs.seniority),
    list('Locations', prefs.locations),
    list('Keywords that matter', prefs.includeKeywords),
    prefs.minSalary !== null ? `Minimum pay: ${prefs.minSalary} ${prefs.salaryCurrency} a year` : null,
    prefs.needsVisaSponsorship ? 'Needs visa sponsorship: yes' : null
  ].filter((l): l is string => l !== null)
  return lines.length ? lines.join('\n') : 'No stated preferences.'
}

/** The candidate and their preferences. Stable across jobs. */
export function triageContext(profile: Profile, prefs: JobPreferences): string {
  return `CANDIDATE PROFILE\n${renderProfile(profile)}\n\nCANDIDATE PREFERENCES\n${preferencesSummary(prefs)}`
}

/** The only part that changes from job to job. */
export function triagePrompt(job: Pick<Job, 'company' | 'title' | 'location' | 'remote' | 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'employmentType' | 'postedAt' | 'description'>): string {
  const lines = [`Company: ${job.company}`, `Title: ${job.title}`]
  if (job.location) lines.push(`Location: ${job.location}`)
  if (job.remote !== 'unknown') lines.push(`Work type: ${job.remote}`)
  if (job.salaryMin !== null || job.salaryMax !== null) {
    const range = job.salaryMin !== null && job.salaryMax !== null && job.salaryMin !== job.salaryMax ? `${job.salaryMin} to ${job.salaryMax}` : String(job.salaryMax ?? job.salaryMin)
    lines.push(`Pay: ${range} ${job.salaryCurrency ?? ''} a year`.trimEnd())
  }
  if (job.employmentType) lines.push(`Employment type: ${job.employmentType}`)
  if (job.postedAt) lines.push(`Posted: ${job.postedAt.slice(0, 10)}`)
  lines.push(`Posting:\n"""\n${trimDescription(job.description, DESCRIPTION_CHARS)}\n"""`)
  return `JOB\n${lines.join('\n')}\n\nScore this job for the candidate.`
}

function clip(items: string[], max: number): string[] {
  return items.map((s) => s.trim()).filter(Boolean).slice(0, max)
}

/** Clamps and trims what the model returned, and adds the bucket. */
export function toAssessment(raw: z.infer<typeof fitSchema>, shortlistScore: number): FitAssessment {
  const score = Math.round(Math.max(0, Math.min(100, Number.isFinite(raw.score) ? raw.score : 0)))
  return {
    score,
    bucket: bucketFor(score, shortlistScore),
    summary: raw.summary.trim().slice(0, 600),
    matches: clip(raw.matches, 6),
    gaps: clip(raw.gaps, 6),
    dealbreakers: clip(raw.dealbreakers, 6),
    seniorityFit: raw.seniorityFit,
    keywords: clip(raw.keywords, 10)
  }
}

/** Stages a score may move a job out of. Jobs in later stages keep their stage. */
const MOVABLE: JobStage[] = ['new', 'filtered_out', 'prescored_out', 'duplicate', 'scored', 'shortlisted']

export interface ScoreResult {
  job: Job
  /** False when the job already had a score for the current profile and nothing was sent. */
  called: boolean
  cached: boolean
  costUsd: number
  tokens: number
}

/**
 * Scores one job. A job already scored against the current profile version is not sent again unless
 * `force` is set. Moves the job to shortlisted or scored when it is still in an early stage.
 */
export async function scoreJobWithAi(ctx: AppContext, job: Job, options: { force?: boolean } = {}): Promise<ScoreResult> {
  const { profile, version } = ctx.profile.get()
  const { thresholds, preferences } = ctx.settings.get()
  const stageFor = (score: number): JobStage | undefined =>
    MOVABLE.includes(job.stage) ? (score >= thresholds.shortlistScore ? 'shortlisted' : 'scored') : undefined

  if (!options.force && job.fit && ctx.jobs.scoredProfileVersion(job.id) === version) {
    const stage = stageFor(job.fit.score)
    if (stage && stage !== job.stage) ctx.jobs.setStage(job.id, stage)
    return { job: ctx.jobs.get(job.id)!, called: false, cached: true, costUsd: 0, tokens: 0 }
  }

  const outcome = await ctx.llm.json({
    task: 'triage',
    stage: 'triage',
    jobId: job.id,
    promptVersion: TRIAGE_PROMPT_VERSION,
    system: TRIAGE_SYSTEM,
    context: triageContext(profile, preferences),
    prompt: triagePrompt(job),
    schema: fitSchema,
    schemaName: 'job_fit',
    effort: 'low'
  })
  const fit = toAssessment(outcome.value, thresholds.shortlistScore)
  ctx.jobs.saveFit(job.id, fit, version, stageFor(fit.score))
  return { job: ctx.jobs.get(job.id)!, called: true, cached: outcome.cached, costUsd: outcome.costUsd, tokens: outcome.tokens }
}

export interface TriageSummary {
  scored: number
  shortlisted: number
  errors: number
  costUsd: number
  tokens: number
  stoppedForBudget: boolean
  budgetMessage: string | null
  noModel: boolean
  /** First few error messages, for the activity log. */
  errorMessages: string[]
}

/** Scores jobs four at a time. Stops starting new jobs when the budget runs out or no model is set up. */
export async function triageJobs(
  ctx: AppContext,
  jobs: Job[],
  options: { signal?: AbortSignal; concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<TriageSummary> {
  const summary: TriageSummary = {
    scored: 0,
    shortlisted: 0,
    errors: 0,
    costUsd: 0,
    tokens: 0,
    stoppedForBudget: false,
    budgetMessage: null,
    noModel: false,
    errorMessages: []
  }
  let next = 0
  let done = 0
  let halted = false
  const worker = async () => {
    while (!halted && !options.signal?.aborted && next < jobs.length) {
      const job = jobs[next++]
      try {
        const result = await scoreJobWithAi(ctx, job)
        summary.scored += 1
        summary.costUsd += result.costUsd
        summary.tokens += result.tokens
        const fit = result.job.fit
        if (fit && result.job.stage === 'shortlisted') {
          summary.shortlisted += 1
          ctx.events.add('shortlisted', `${job.title} at ${job.company} scored ${fit.score}. ${fit.summary}`, job.id, { score: fit.score })
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          halted = true
          summary.stoppedForBudget = true
          summary.budgetMessage = err.message
        } else if (err instanceof NoModelConfiguredError) {
          halted = true
          summary.noModel = true
          summary.errorMessages.push(err.message)
        } else {
          summary.errors += 1
          if (summary.errorMessages.length < 3) summary.errorMessages.push(`${job.title} at ${job.company}: ${(err as Error).message}`)
        }
      }
      done += 1
      options.onProgress?.(done, jobs.length)
    }
  }
  const count = Math.max(1, Math.min(options.concurrency ?? TRIAGE_CONCURRENCY, jobs.length))
  await Promise.all(Array.from({ length: count }, worker))
  return summary
}
