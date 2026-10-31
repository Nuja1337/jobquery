import type { FormField, Job, LintReport, PreparedAnswer, Settings } from '@shared/types'
import type { LlmService } from '../llm/service'
import { writeCoverLetter } from '../writing/generate'
import { answerFields, type AnswerDeps } from './answers'
import { BrowserManager, readForm } from './browser'
import { isCoverLetterField } from './fieldMap'
import { readComboboxOptions, toFormField } from './fill'
import { fetchGreenhouseFields } from './greenhouseForm'

/** The URL that shows the application form, which differs from the posting URL on some boards. */
export function applyUrlFor(job: Pick<Job, 'url' | 'applyUrl' | 'ats'>): string {
  if (job.applyUrl) return job.applyUrl
  const url = job.url.replace(/[?#].*$/, '').replace(/\/$/, '')
  if (job.ats === 'lever' && /jobs\.lever\.co\//.test(url) && !url.endsWith('/apply')) return `${url}/apply`
  if (job.ats === 'ashby' && /jobs\.ashbyhq\.com\//.test(url) && !url.endsWith('/application')) return `${url}/application`
  return job.url
}

/** Board token and job id for a Greenhouse posting, read from its URL. */
export function greenhouseIds(job: Pick<Job, 'url' | 'applyUrl' | 'externalId'>): { token: string; id: string } | null {
  for (const u of [job.url, job.applyUrl ?? '']) {
    const m = u.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)\/jobs\/(\d+)/i)
    if (m) return { token: m[1], id: m[2] }
    const embed = u.match(/greenhouse\.io\/embed\/job_app\?for=([\w-]+)&token=(\d+)/i)
    if (embed) return { token: embed[1], id: embed[2] }
  }
  return null
}

export type FormSource = 'greenhouse_api' | 'browser' | 'none'

/** Reads the application form ahead of time: from the Greenhouse API when possible, otherwise with a background browser. */
export async function readFormForJob(browser: BrowserManager, settings: Settings, job: Job): Promise<{ fields: FormField[]; via: FormSource; error: string | null }> {
  if (job.ats === 'greenhouse') {
    const ids = greenhouseIds(job)
    if (ids) {
      try {
        const fields = await fetchGreenhouseFields(ids.token, ids.id)
        if (fields && fields.length) return { fields, via: 'greenhouse_api', error: null }
      } catch {
        // Fall through to the browser.
      }
    }
  }
  try {
    const page = await browser.headlessPage(settings.browser)
    try {
      await page.goto(applyUrlFor(job), { waitUntil: 'domcontentloaded', timeout: 45_000 })
      const snap = await readForm(page)
      await readComboboxOptions(snap.frame, snap.fields)
      const fields = snap.fields.map(toFormField)
      return { fields, via: fields.length ? 'browser' : 'none', error: null }
    } finally {
      await page.close()
    }
  } catch (err) {
    return { fields: [], via: 'none', error: (err as Error).message.split('\n')[0] }
  }
}

export interface DraftResult {
  fields: FormField[]
  formSource: FormSource
  formError: string | null
  answers: PreparedAnswer[]
  coverLetter: string | null
  coverLetterLint: LintReport | null
  coverLetterNeedsInput: string | null
  costUsd: number
}

/**
 * Drafts a whole application: reads the form, writes the cover letter when the form wants one
 * (or the user always wants one) and answers every field.
 */
export async function draftApplication(
  deps: AnswerDeps & { browser: BrowserManager; llm: LlmService },
  job: Job,
  options: { existingCoverLetter?: string | null } = {}
): Promise<DraftResult> {
  const { fields, via, error } = await readFormForJob(deps.browser, deps.settings, job)
  const wantsLetter =
    deps.settings.writing.alwaysCoverLetter ||
    fields.some((f) => isCoverLetterField(f) || f.fileHint === 'cover_letter') ||
    // When the form can't be read ahead of time, write one anyway so the fill step has it.
    via === 'none'

  let costUsd = 0
  let coverLetter = options.existingCoverLetter ?? null
  let coverLetterLint: LintReport | null = null
  let coverLetterNeedsInput: string | null = null
  if (wantsLetter && !coverLetter) {
    const written = await writeCoverLetter(deps.llm, { profile: deps.profile, samples: deps.samples, settings: deps.settings }, job)
    costUsd += written.costUsd
    coverLetter = written.needsInput ? null : written.text
    coverLetterLint = written.needsInput ? null : written.lint
    coverLetterNeedsInput = written.needsInput
  }

  const { answers, costUsd: answerCost } = await answerFields(deps, job, fields, coverLetter)
  costUsd += answerCost

  return { fields, formSource: via, formError: error, answers, coverLetter, coverLetterLint, coverLetterNeedsInput, costUsd }
}
