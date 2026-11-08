import type { AtsKind, FormField, Job, LintReport, PreparedAnswer, Settings } from '@shared/types'
import type { Page } from 'playwright-core'
import type { LlmService } from '../llm/service'
import { normalizeCompany } from '../pipeline/dedupe'
import { detectAts } from '../sources/detect'
import { answerFields, type AnswerDeps } from './answers'
import { BrowserManager, botCheckShown, readForm, withTimeout } from './browser'
import { isCoverLetterField } from './fieldMap'
import { readComboboxOptions, toFormField } from './fill'
import { fetchGreenhouseFields } from './greenhouseForm'
import { isJobBoardUrl } from './jobBoards'

type UrlJob = Pick<Job, 'url' | 'applyUrl' | 'ats'> & { externalId?: string; atsToken?: string | null; source: Job['source'] }

/** Board token and job id for a Greenhouse posting, read from its URL or, failing that, the stored ids. */
export function greenhouseIds(job: Pick<UrlJob, 'url' | 'applyUrl' | 'ats' | 'externalId' | 'atsToken' | 'source'>): { token: string; id: string } | null {
  const urls = [job.url, job.applyUrl ?? '']
  for (const u of urls) {
    const m = u.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)\/jobs\/(\d+)/i)
    if (m) return { token: m[1], id: m[2] }
    const embed = u.match(/greenhouse\.io\/embed\/job_app\?for=([\w-]+)&token=(\d+)/i)
    if (embed) return { token: embed[1], id: embed[2] }
  }
  if (job.ats !== 'greenhouse' || !job.atsToken) return null
  // Company sites that embed Greenhouse put the job id in the query as gh_jid.
  for (const u of urls) {
    const jid = u.match(/[?&]gh_jid=(\d+)/i)
    if (jid) return { token: job.atsToken, id: jid[1] }
  }
  // The external id is the Greenhouse job id only for a posting that came from Greenhouse itself.
  if (job.source === 'greenhouse' && job.externalId && /^\d+$/.test(job.externalId)) return { token: job.atsToken, id: job.externalId }
  return null
}

/** The URL that shows the application form, which differs from the posting URL on some boards. */
export function applyUrlFor(job: UrlJob): string {
  // The embedded form always shows the full application. Hosted pages can redirect to the company's own site.
  const gh = greenhouseIds(job)
  if (gh) {
    const eu = [job.url, job.applyUrl ?? ''].some((u) => /\.eu\.greenhouse\.io/i.test(u))
    return `https://job-boards${eu ? '.eu' : ''}.greenhouse.io/embed/job_app?for=${gh.token}&token=${gh.id}`
  }
  if (job.applyUrl) return job.applyUrl
  const url = job.url.replace(/[?#].*$/, '').replace(/\/$/, '')
  if (job.ats === 'lever' && /jobs(\.eu)?\.lever\.co\//.test(url) && !url.endsWith('/apply')) return `${url}/apply`
  if (job.ats === 'ashby' && /jobs\.ashbyhq\.com\//.test(url) && !url.endsWith('/application')) return `${url}/application`
  // Breezy opens the form at /apply. Personio's form is on the posting page, behind the #apply anchor.
  // Rippling's posting page holds the apply button and the form, so its URL is used as it is.
  if (job.ats === 'breezy' && /\.breezy\.hr\/p\//.test(url) && !url.endsWith('/apply')) return `${url}/apply`
  if (job.ats === 'personio' && /\.jobs\.personio\.(?:de|com)\/job\//.test(url)) return `${url}#apply`
  if (job.ats === 'rippling' && /ats\.rippling\.com\//.test(url)) return url
  return job.url
}

export type FormSource = 'greenhouse_api' | 'browser' | 'none'

/** Where the application form really lives, when the posting was on a job board. */
export interface ResolvedApply {
  applyUrl: string
  ats: AtsKind
  atsToken: string | null
  /** The posting's id on that system, when the address names it. */
  atsJobId?: string | null
}

export interface FormRead {
  fields: FormField[]
  via: FormSource
  error: string | null
  resolved: ResolvedApply | null
}

const BOT_CHECK_ERROR = 'The site showed a bot check to the background browser. jobpls reads the form when you open it.'
const NO_EMPLOYER_LINK_ERROR = "This job board doesn't link to the employer's form. Open the posting and apply on the company's site."
const NOT_AN_APPLICATION_ERROR = "The page jobpls found doesn't look like an application form. Open the posting and apply on the company's site."

/**
 * True when the fields look like a job application: an upload, or an email box among at least four
 * fields. A newsletter signup or a site search on a company page has neither.
 */
export function looksLikeApplication(fields: FormField[]): boolean {
  if (fields.some((f) => f.type === 'file')) return true
  const email = fields.some((f) => f.type === 'email' || /\be-?mail\b/i.test(f.label))
  return email && fields.length >= 4
}

/** Lowercase letters and digits only, so "Lemon.io", "lemon-io" and "Lemon IO" compare equal. */
const slug = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The apply link that leaves the job board, in page order. A link to a known application system
 * (Greenhouse, Lever, Ashby and the like) comes first only when its board token is the job's company.
 * Another company's board never wins on being an ATS link. The link text needs the word "apply", so
 * "applying" and "application" don't count. Links with no address, mail links and links back to a
 * board don't count. With `onlyIfSingle`, a link is returned only when exactly one address qualifies.
 */
export function chooseEmployerLink(links: Array<{ text: string; href: string }>, company: string, options: { onlyIfSingle?: boolean } = {}): string | null {
  const candidates = links.filter((link) => /\bapply\b/i.test(link.text) && /^https?:\/\//i.test(link.href) && !isJobBoardUrl(link.href))
  if (options.onlyIfSingle && new Set(candidates.map((link) => link.href)).size !== 1) return null
  const name = slug(normalizeCompany(company))
  const ownBoard = name ? candidates.find((link) => slug(detectAts(link.href)?.token ?? '') === name) : undefined
  return (ownBoard ?? candidates[0])?.href ?? null
}

/** Opens a page and waits for redirects that happen after the first load. */
async function finalUrlOf(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  if (isJobBoardUrl(page.url())) {
    await page.waitForURL((u) => !isJobBoardUrl(u.toString()), { timeout: 5000 }).catch(() => {})
  }
  return page.url()
}

/** Follows a job board posting to the employer's own application page. Returns its final address or null. */
async function findEmployerApplication(browser: BrowserManager, settings: Settings, job: Job): Promise<string | null> {
  const page = await browser.headlessPage(settings.browser)
  try {
    const boardUrl = applyUrlFor(job)
    let host = ''
    try {
      host = new URL(boardUrl).hostname.replace(/^www\./, '')
    } catch {
      // Leave host empty and use the generic path.
    }
    if ((job.source === 'remoteok' || /^remoteok\.(com|io)$/.test(host)) && /^\d+$/.test(job.externalId)) {
      const final = await finalUrlOf(page, `https://remoteok.com/l/${job.externalId}`)
      return isJobBoardUrl(final) ? null : final
    }
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    const links = await withTimeout(
      page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).flatMap((a) => {
          const el = a as HTMLAnchorElement
          const style = window.getComputedStyle(el)
          const r = el.getBoundingClientRect()
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && (r.width > 0 || r.height > 0)
          const raw = el.getAttribute('href') ?? ''
          if (!raw.trim() || raw.trim() === '#') return []
          return [{ text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), href: el.href, visible }]
        })
      )
    )
    // Visible links first. Remotive's visible Apply button has no address, and the employer link
    // sits in a hidden copy of the same button. A hidden link is trusted only when it is the one hidden apply link.
    const target = chooseEmployerLink(links.filter((l) => l.visible), job.company) ?? chooseEmployerLink(links.filter((l) => !l.visible), job.company, { onlyIfSingle: true })
    if (!target) return null
    const final = await finalUrlOf(page, target)
    return isJobBoardUrl(final) ? null : final
  } finally {
    await page.close().catch(() => {})
  }
}

/** Reads the form at a URL with the background browser. */
async function readWithBrowser(browser: BrowserManager, settings: Settings, url: string): Promise<{ fields: FormField[]; botCheck: boolean }> {
  const page = await browser.headlessPage(settings.browser)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    const snap = await readForm(page)
    if (await botCheckShown(page)) return { fields: [], botCheck: true }
    await readComboboxOptions(snap.frame, snap.fields)
    return { fields: snap.fields.map(toFormField), botCheck: false }
  } finally {
    await page.close().catch(() => {})
  }
}

/**
 * Reads the application form ahead of time with a background browser. For a Greenhouse job whose
 * page can't be read, it falls back to the Greenhouse API, whose copy of the form can be out of date.
 * A posting on a job board is followed to the employer's application first.
 */
export async function readFormForJob(browser: BrowserManager, settings: Settings, job: Job): Promise<FormRead> {
  let target: Job & { atsToken?: string | null } = job
  let resolved: ResolvedApply | null = null

  if (isJobBoardUrl(applyUrlFor(job))) {
    let employerUrl: string | null
    try {
      employerUrl = await findEmployerApplication(browser, settings, job)
    } catch (err) {
      return { fields: [], via: 'none', error: (err as Error).message.split('\n')[0], resolved: null }
    }
    if (!employerUrl) return { fields: [], via: 'none', error: NO_EMPLOYER_LINK_ERROR, resolved: null }
    const detected = detectAts(employerUrl)
    target = {
      ...job,
      url: employerUrl,
      applyUrl: null,
      ats: detected?.ats ?? 'unknown',
      atsToken: detected?.token ?? null,
      externalId: detected?.jobId ?? ''
    }
    // Greenhouse company sites carry the posting id as gh_jid, which only greenhouseIds reads.
    const atsJobId = target.ats === 'greenhouse' ? (greenhouseIds(target)?.id ?? detected?.jobId ?? null) : (detected?.jobId ?? null)
    resolved = { applyUrl: applyUrlFor(target), ats: target.ats, atsToken: target.atsToken ?? null, atsJobId }
  }

  let fields: FormField[] = []
  let error: string | null = null
  try {
    const read = await readWithBrowser(browser, settings, applyUrlFor(target))
    if (read.botCheck) return { fields: [], via: 'none', error: BOT_CHECK_ERROR, resolved }
    fields = read.fields
  } catch (err) {
    error = (err as Error).message.split('\n')[0]
  }
  // The page isn't an application, so what was found is not saved as the job's apply target.
  if (fields.length && !looksLikeApplication(fields)) return { fields: [], via: 'none', error: NOT_AN_APPLICATION_ERROR, resolved: null }
  if (fields.length) return { fields, via: 'browser', error: null, resolved }

  if (target.ats === 'greenhouse') {
    const ids = greenhouseIds(target)
    if (ids) {
      try {
        const apiFields = await fetchGreenhouseFields(ids.token, ids.id)
        if (apiFields && apiFields.length) return { fields: apiFields, via: 'greenhouse_api', error: null, resolved }
      } catch {
        // Keep the browser's result.
      }
    }
  }
  return { fields: [], via: 'none', error, resolved }
}

export interface DraftResult {
  fields: FormField[]
  formSource: FormSource
  formError: string | null
  /** Set when the posting was on a job board and the employer's form was found. */
  resolved: ResolvedApply | null
  answers: PreparedAnswer[]
  coverLetter: string | null
  coverLetterLint: LintReport | null
  coverLetterNeedsInput: string | null
  costUsd: number
}

/**
 * True when a cover letter should be written: the form has a cover letter field or upload that is
 * required, or Settings says to always write one. An optional field gets no letter and stays blank.
 * A form that could not be read ahead of time gets one, since the live form may ask for it.
 */
export function needsCoverLetter(fields: FormField[], via: FormSource, settings: Settings): boolean {
  if (settings.writing.alwaysCoverLetter) return true
  // A form that could not be read ahead of time gets its letter at fill time, once the live form shows a cover letter field.
  if (via === 'none') return false
  return fields.some((f) => (isCoverLetterField(f) || f.fileHint === 'cover_letter') && f.required)
}

/**
 * Drafts a whole application: reads the form, writes the cover letter when it is needed and
 * answers every field.
 */
export async function draftApplication(
  deps: AnswerDeps & { browser: BrowserManager; llm: LlmService },
  job: Job,
  options: { existingCoverLetter?: string | null; formRead?: FormRead } = {}
): Promise<DraftResult> {
  // A caller that already read the form, to resolve a job-board posting, passes it in so the page is not opened twice.
  const { fields, via, error, resolved } = options.formRead ?? (await readFormForJob(deps.browser, deps.settings, job))
  const wantsLetter = needsCoverLetter(fields, via, deps.settings)

  // The letter is written inside answerFields, in the same call as the open answers when there are any.
  const existing = options.existingCoverLetter ?? null
  const { answers, costUsd, letter } = await answerFields(deps, job, fields, existing, { writeCoverLetter: wantsLetter && !existing })
  const coverLetter = existing ?? (letter && !letter.needsInput ? letter.text : null)
  const coverLetterLint = letter && !letter.needsInput ? letter.lint : null
  const coverLetterNeedsInput = letter?.needsInput ?? null

  return { fields, formSource: via, formError: error, resolved, answers, coverLetter, coverLetterLint, coverLetterNeedsInput, costUsd }
}
