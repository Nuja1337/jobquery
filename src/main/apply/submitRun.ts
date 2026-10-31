import path from 'node:path'
import type { Page } from 'playwright-core'
import type { Application, ApplicationStatus, FormField, Job, PreparedAnswer, Settings } from '@shared/types'
import { answerFields, COVER_LETTER_PDF, type AnswerDeps } from './answers'
import { type BrowserManager, readForm } from './browser'
import type { ExtractedField } from './extractScript'
import { fillForm, matchAnswers, readComboboxOptions, toFormField } from './fill'
import { applyUrlFor } from './prepare'
import { captureBaseline, clickSubmit, waitForOutcome, waitForUserToFinish } from './submit'

/** AI answers below this confidence keep auto-submit from clicking. */
export const AUTO_SUBMIT_MIN_CONFIDENCE = 0.7

export interface SubmitRunDeps {
  browser: BrowserManager
  settings: Settings
  answerDeps: AnswerDeps
  /** Renders the cover letter PDF and returns its path. */
  renderCoverLetter: (text: string) => Promise<string>
  screenshotsDir: string
}

export interface SubmitRunResult {
  ok: boolean
  status: ApplicationStatus
  message: string
  screenshotPath: string | null
  confirmation: string | null
  /** Answers after the live fill, including any written for fields first seen on the live form. */
  answers: PreparedAnswer[]
  formFields: FormField[]
  costUsd: number
  /**
   * Settles when the user finishes in the browser (assist mode, a captcha, a fix). True means a
   * new confirmation page appeared. Null when there's nothing left to wait for.
   */
  completion: Promise<{ confirmed: boolean; screenshotPath: string | null; costUsd: number }> | null
}

const LOGIN_WALL = /sign in to (apply|continue)|log in to (apply|continue)|create (an )?account to apply|already have an account/i

async function screenshot(page: Page, dir: string, appId: string): Promise<string | null> {
  const file = path.join(dir, `${appId}-${Date.now()}.png`)
  return page.screenshot({ path: file, fullPage: true }).then(() => file).catch(() => null)
}

interface PageFill {
  fieldCount: number
  /** Required fields with no answer, and any answer flagged for the user. */
  flagged: string[]
  /** AI answers below the auto-submit confidence line. */
  unsure: string[]
  /** Fields first seen on the live form and answered by the AI, so nobody reviewed them. */
  unreviewed: string[]
  failures: string[]
}

/**
 * Opens the application in the visible browser, fills it and, in auto mode, submits it.
 * In assist mode it fills, hands over to the user and keeps watching, so multi-page forms
 * get filled page by page and the submission is recorded when a new confirmation shows up.
 */
export async function runSubmission(deps: SubmitRunDeps, job: Job, app: Application, mode: 'assist' | 'auto'): Promise<SubmitRunResult> {
  const page = await deps.browser.newVisiblePage(deps.settings.browser)
  await page.bringToFront().catch(() => {})
  await page.goto(applyUrlFor(job), { waitUntil: 'domcontentloaded', timeout: 60_000 })

  let costUsd = 0
  const answers = [...app.answers]
  const formFields = [...app.formFields]
  let coverPdf: string | null = null
  const files = async () => {
    if (!coverPdf && app.coverLetter) coverPdf = await deps.renderCoverLetter(app.coverLetter)
    return { resume: deps.answerDeps.resumePath, coverLetter: coverPdf }
  }

  // Fills every field on the current page that has an answer, writing answers for new fields first.
  const filledIds = new Set<string>()
  const fillCurrentPage = async (): Promise<PageFill> => {
    const snap = await readForm(page)
    await readComboboxOptions(snap.frame, snap.fields)
    const fresh: ExtractedField[] = snap.fields.filter((f) => !filledIds.has(f.jpId))
    const { matched, unmatched } = matchAnswers(fresh, answers)
    const unreviewed: string[] = []
    if (unmatched.length) {
      const newFields = unmatched.map(toFormField)
      const res = await answerFields(deps.answerDeps, job, newFields, app.coverLetter)
      costUsd += res.costUsd
      answers.push(...res.answers)
      formFields.push(...newFields)
      for (const field of unmatched) {
        const answer = res.answers.find((a) => a.fieldKey === field.key)
        if (!answer) continue
        matched.push({ field, answer })
        if (answer.source === 'ai' && answer.value !== '') unreviewed.push(field.label || field.key)
      }
    }
    const usesCoverPdf = matched.some((m) => m.answer.value === COVER_LETTER_PDF || m.field.fileHint === 'cover_letter')
    const fileSet = usesCoverPdf ? await files() : { resume: deps.answerDeps.resumePath, coverLetter: null }
    const failures = await fillForm(page, snap.frame, matched, fileSet)
    for (const f of fresh) filledIds.add(f.jpId)
    const label = (m: { field: ExtractedField }) => m.field.label || m.field.key
    const flagged = matched
      .filter((m) => m.field.type !== 'file' && (m.answer.needsUser || (m.field.required && m.answer.value === '')))
      .map(label)
    const unsure = matched
      .filter((m) => m.field.type !== 'file' && !m.answer.needsUser && m.answer.value !== '' && m.answer.source === 'ai' && m.answer.confidence < AUTO_SUBMIT_MIN_CONFIDENCE)
      .map(label)
    const missingFiles = matched.filter((m) => m.field.type === 'file' && m.field.required && failures.some((f) => f.label === label(m))).map(label)
    return {
      fieldCount: snap.fields.length,
      flagged: [...flagged, ...missingFiles],
      unsure,
      unreviewed,
      failures: failures.map((f) => `${f.label}: ${f.reason}`)
    }
  }

  const first = await fillCurrentPage()

  if (first.fieldCount === 0) {
    const text = await page.locator('body').innerText().catch(() => '')
    const message = LOGIN_WALL.test(text) || (await page.locator('input[type="password"]').count()) > 0
      ? 'This site wants you to sign in first. Sign in in the browser window, then press Fill again. The browser remembers the login next time.'
      : 'No form fields were found on this page. Open the application in the browser window and click its Apply button, then press Fill again.'
    return { ok: false, status: 'needs_attention', message, screenshotPath: null, confirmation: null, answers, formFields, costUsd, completion: null }
  }

  // Everything on the page now (descriptions included) is the baseline. Only a confirmation that
  // appears after this point, with the form gone or the page changed, counts as submitted.
  const baseline = await captureBaseline(page)

  // Keeps filling new pages until a confirmation appears or the user closes the tab.
  const watch = (): Promise<{ confirmed: boolean; screenshotPath: string | null; costUsd: number }> =>
    (async () => {
      const before = costUsd
      for (let round = 0; round < 40; round++) {
        if (page.isClosed()) break
        if (await waitForUserToFinish(page, baseline, 15_000)) {
          const shot = await screenshot(page, deps.screenshotsDir, app.id)
          return { confirmed: true, screenshotPath: shot, costUsd: costUsd - before }
        }
        // A new step of a multi-page form shows fields that haven't been filled yet.
        if (round < 12 && !page.isClosed()) await fillCurrentPage().catch(() => null)
      }
      return { confirmed: false, screenshotPath: null, costUsd: costUsd - before }
    })()

  const problems = [
    ...first.flagged.map((l) => `"${l}" needs your answer`),
    ...first.unsure.map((l) => `"${l}" is a guess, check it`),
    ...first.unreviewed.map((l) => `"${l}" wasn't on the form you reviewed`),
    ...first.failures
  ]

  if (mode === 'assist') {
    const message = problems.length
      ? `Filled what it could. ${problems.slice(0, 4).join('. ')}. Finish in the browser and press submit there.`
      : 'Everything is filled in. Check the browser window and press submit there. The app records it when the confirmation page shows.'
    return { ok: true, status: 'submitting', message, screenshotPath: null, confirmation: null, answers, formFields, costUsd, completion: watch() }
  }

  if (deps.settings.autopilot.dryRun) {
    const shot = await screenshot(page, deps.screenshotsDir, app.id)
    return {
      ok: true,
      status: 'submitting',
      message: `Dry run: the form is filled and the final click was skipped.${problems.length ? ` ${problems.slice(0, 4).join('. ')}.` : ''} Check the browser window.`,
      screenshotPath: shot,
      confirmation: null,
      answers,
      formFields,
      costUsd,
      completion: watch()
    }
  }

  // Auto mode only clicks when every answer is settled, confident and was reviewed.
  if (problems.length) {
    return {
      ok: false,
      status: 'needs_attention',
      message: `Didn't submit. ${problems.slice(0, 4).join('. ')}. Fix it in the browser and press submit there.`,
      screenshotPath: null,
      confirmation: null,
      answers,
      formFields,
      costUsd,
      completion: watch()
    }
  }

  const snap = await readForm(page, { clickApply: false })
  const preClick = await captureBaseline(page)
  if (!(await clickSubmit(snap.frame))) {
    return { ok: false, status: 'needs_attention', message: "Couldn't find the submit button. Press it in the browser window.", screenshotPath: null, confirmation: null, answers, formFields, costUsd, completion: watch() }
  }

  const outcome = await waitForOutcome(page, snap.frame, preClick)
  if (outcome.kind === 'confirmed') {
    const shot = await screenshot(page, deps.screenshotsDir, app.id)
    if (!deps.settings.browser.keepOpen) await page.close().catch(() => {})
    return { ok: true, status: 'submitted', message: 'Submitted. The confirmation page appeared.', screenshotPath: shot, confirmation: outcome.text, answers, formFields, costUsd, completion: null }
  }
  const message =
    outcome.kind === 'captcha'
      ? 'The site asked for a captcha. Solve it in the browser window and press submit.'
      : outcome.kind === 'invalid'
        ? `The form rejected the submission. ${outcome.details} Fix it in the browser and press submit.`
        : 'No confirmation page appeared. Check the browser window to see what happened.'
  return { ok: false, status: 'needs_attention', message, screenshotPath: null, confirmation: null, answers, formFields, costUsd, completion: watch() }
}
