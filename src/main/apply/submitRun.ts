import path from 'node:path'
import type { Frame, Page } from 'playwright-core'
import { AUTO_SUBMIT_MIN_CONFIDENCE, answerNeedsUser, isGuess, isUnreviewedLive } from '@shared/answers'
import type { Application, ApplicationStatus, FormField, Job, PreparedAnswer, Settings } from '@shared/types'
import { answerFields, COVER_LETTER_PDF, type AnswerDeps } from './answers'
import { type BrowserManager, type FormSnapshot, readForm } from './browser'
import { previouslyAppliedAnswer } from './companyQuestions'
import type { ExtractedField } from './extractScript'
import { mustAskUser, wasAgreedBySettings } from './fieldMap'
import { fillForm, matchAnswers, readComboboxOptions, resumeFileName, toFormField } from './fill'
import { isJobBoardUrl } from './jobBoards'
import { applyUrlFor } from './prepare'
import { captureBaseline, clickSubmit, hasMorePages, waitForOutcome, waitForUserToFinish } from './submit'

export { AUTO_SUBMIT_MIN_CONFIDENCE }

export interface SubmitRunDeps {
  browser: BrowserManager
  settings: Settings
  answerDeps: AnswerDeps
  /** Renders the cover letter PDF and returns its path. */
  renderCoverLetter: (text: string) => Promise<string>
  screenshotsDir: string
  /** Stores a cover letter written during the live fill, for forms that could not be read ahead of time. */
  saveCoverLetter?: (text: string) => void
  /**
   * Called with the time right before auto mode clicks Submit, and with null if no button was
   * clicked after all. Stored at once, so even a crash mid-submit never leads to a second click.
   * Returns false when the application should no longer go out (the user dismissed the job or
   * changed the application while the form was being filled), and then nothing is clicked.
   */
  recordSubmitClick: (at: string | null) => boolean
}

export interface SubmitCompletion {
  confirmed: boolean
  screenshotPath: string | null
  costUsd: number
  /** Answers and fields after every page was filled, including pages that appeared later. */
  answers: PreparedAnswer[]
  formFields: FormField[]
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
  /** True when autopilot filled the form in a dry run and closed it. Nothing was sent. */
  dryRun?: boolean
  /**
   * Settles when the user finishes in the browser (assist mode, a captcha, a fix). Confirmed means a
   * new confirmation page appeared. Null when there's nothing left to wait for.
   */
  completion: Promise<SubmitCompletion> | null
}

const LOGIN_WALL = /sign in to (apply|continue)|log in to (apply|continue)|create (an )?account to apply|already have an account/i

async function screenshot(page: Page, dir: string, appId: string): Promise<string | null> {
  const file = path.join(dir, `${appId}-${Date.now()}.png`)
  return page.screenshot({ path: file, fullPage: true }).then(() => file).catch(() => null)
}

interface PageFill {
  /** The frame the form was read from. */
  frame: Frame
  fieldCount: number
  /** Fields on this read that no earlier pass had seen. */
  newFields: number
  /** Required fields with no answer, and any answer flagged for the user. */
  flagged: string[]
  /** AI answers below the auto-submit confidence line. */
  unsure: string[]
  /** Fields first seen on the live form, so they weren't on the draft the user could review. */
  unreviewed: string[]
  /**
   * Questions only the user may answer (AI use, legal, consent) that were filled with something
   * the user didn't just see settle. Unticked optional boxes, boxes Settings agreed to, and saved
   * answers when Settings allows sending them are left out.
   */
  userOnly: string[]
  failures: string[]
}

/** True when a text box, text area or editable region has the keyboard focus. */
async function editableFocused(frame: Frame): Promise<boolean> {
  return frame
    .evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return false
      if (el.tagName === 'TEXTAREA') return true
      if (el.tagName === 'INPUT') return !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file'].includes((el.getAttribute('type') || 'text').toLowerCase())
      return el.isContentEditable
    })
    .catch(() => true)
}

/** Takes the focus off whatever the last fill left it on. */
async function blurFocused(frame: Frame): Promise<void> {
  await frame.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => {})
}

/**
 * True for an answer that came from the owner's own settings or profile rules. A field that showed
 * up only after an earlier answer was filled can go out with one of these without a review.
 */
function fromOwnerSettings(a: Pick<PreparedAnswer, 'source' | 'rule'>): boolean {
  return a.source === 'profile' || a.source === 'settings' || a.rule === 'demographic'
}

/** Passes run after the first fill to pick up fields that an earlier answer revealed. */
const REVEAL_PASSES = 2

/**
 * Opens the application in the visible browser, fills it and, in auto mode, submits it.
 * In assist mode it fills, hands over to the user and keeps watching, so multi-page forms
 * get filled page by page and the submission is recorded when a new confirmation shows up.
 */
export async function runSubmission(
  deps: SubmitRunDeps,
  job: Job,
  app: Application,
  mode: 'assist' | 'auto',
  /** Who pressed Submit. Autopilot never sends a question only the person may answer. */
  by: 'user' | 'autopilot' = 'autopilot'
): Promise<SubmitRunResult> {
  const page = await deps.browser.newVisiblePage(deps.settings.browser)
  await page.bringToFront().catch(() => {})
  try {
    await page.goto(applyUrlFor(job), { waitUntil: 'domcontentloaded', timeout: 60_000 })
  } catch (err) {
    // A page that never loaded would stay open with nobody watching it.
    await page.close().catch(() => {})
    throw err
  }

  // Whether the Submit click was recorded and not taken back. Once it was, a person has to look at the tab.
  const click = { recorded: false }
  const tracked: SubmitRunDeps = {
    ...deps,
    recordSubmitClick: (at) => {
      const accepted = deps.recordSubmitClick(at)
      click.recorded = at !== null && accepted
      return accepted
    }
  }
  try {
    return await fillAndSubmit(tracked, page, job, app, mode, by, click)
  } catch (err) {
    // Nobody is watching an unattended run, so a failure must not leave its tab open.
    if (by === 'autopilot' && !click.recorded && !deps.settings.browser.keepOpen) await page.close().catch(() => {})
    throw err
  }
}

async function fillAndSubmit(
  deps: SubmitRunDeps,
  page: Page,
  job: Job,
  app: Application,
  mode: 'assist' | 'auto',
  by: 'user' | 'autopilot',
  click: { recorded: boolean }
): Promise<SubmitRunResult> {
  /**
   * An unattended run that did not click Submit has nothing left for a person to do in the tab. It
   * takes a screenshot, closes the tab and stops watching. A run that clicked, or one the user
   * started, keeps its tab and its watcher.
   */
  const unattended = (): boolean => by === 'autopilot' && !click.recorded
  const leave = async (result: Omit<SubmitRunResult, 'completion'>, watcher: (() => Promise<SubmitCompletion>) | null): Promise<SubmitRunResult> => {
    if (!unattended()) return { ...result, completion: watcher ? watcher() : null }
    const shot = result.screenshotPath ?? (await screenshot(page, deps.screenshotsDir, app.id))
    if (!deps.settings.browser.keepOpen) await page.close().catch(() => {})
    return { ...result, screenshotPath: shot, completion: null }
  }

  let costUsd = 0
  const answers = [...app.answers]
  const formFields = [...app.formFields]
  let coverPdf: string | null = null
  /** The letter on the draft, or one written during the fill when the live form asked for it. */
  let letterText: string | null = app.coverLetter
  // The resume carries the legal name: first and last, never the preferred name. The full name is the fallback.
  const resumeName = () => {
    const { name, fullName } = deps.answerDeps.profile
    const legal = name?.first?.trim() && name.last?.trim() ? `${name.first.trim()} ${name.last.trim()}` : fullName
    return resumeFileName(legal, deps.answerDeps.resumePath ?? '')
  }
  const files = async () => {
    if (!coverPdf && letterText) coverPdf = await deps.renderCoverLetter(letterText)
    return { resume: deps.answerDeps.resumePath, coverLetter: coverPdf, resumeName: resumeName() }
  }

  // Fills every field on the current page that has an answer, writing answers for new fields first.
  // Later passes (a new step of a multi-page form, or the user going back a step) leave fields that
  // already hold something alone, so the user's own edits are never overwritten.
  const filledIds = new Set<string>()
  /** Comboboxes this run filled and checked. Their text box can stay empty while the page shows the choice. */
  const comboboxFilled = new Set<string>()
  const fillCurrentPage = async (pass: {
    clickApply: boolean
    keepExisting: boolean
    /** Dropdown options are read only where the run owns the page. A watcher pass never opens a menu. */
    readOptions: boolean
    /** A pass after the first fill, so the fields it finds were revealed by an earlier answer. */
    revealed?: boolean
  }): Promise<PageFill> => {
    const snap = await readForm(page, { clickApply: pass.clickApply })
    const fresh: ExtractedField[] = snap.fields.filter((f) => !filledIds.has(f.jpId))
    for (const f of fresh) filledIds.add(f.jpId)
    const toFill = pass.keepExisting ? fresh.filter((f) => !f.hasValue) : fresh
    const { matched, unmatched } = matchAnswers(toFill, answers)
    // Only fields with no answer need their options, and opening a menu moves the focus, so it is skipped
    // while a text box has it.
    if (pass.readOptions && unmatched.some((f) => f.type === 'combobox' && f.options.length === 0)) {
      if (pass.revealed) await blurFocused(snap.frame)
      if (!(await editableFocused(snap.frame))) await readComboboxOptions(snap.frame, unmatched)
    }
    // "Have you applied to us before?" depends on the log of applications, which changes between the
    // draft and the fill. An earlier application may have been sent since, so the answer is worked out again.
    for (const m of matched) {
      if (m.answer.rule !== 'previously_applied') continue
      const fresh = previouslyAppliedAnswer(toFormField(m.field), job.company, deps.answerDeps.previouslyApplied)
      const next: PreparedAnswer = {
        ...m.answer,
        ...(fresh ?? { value: '', source: 'settings' as const, confidence: 0, needsUser: m.answer.required || m.field.required, note: 'You applied here before. Answer this yourself.' })
      }
      const at = answers.indexOf(m.answer)
      if (at !== -1) answers[at] = next
      m.answer = next
    }
    if (unmatched.length) {
      const newFields = unmatched.map(toFormField)
      // A form read for the first time here may ask for a cover letter that the draft never had.
      const wantsLetter = !letterText && newFields.some((f) => f.fileHint === 'cover_letter' || /cover\s*letter/i.test(f.label))
      const res = await answerFields(deps.answerDeps, job, newFields, letterText, { writeCoverLetter: wantsLetter })
      if (res.letter && !res.letter.needsInput) {
        letterText = res.letter.text
        deps.saveCoverLetter?.(letterText)
      }
      costUsd += res.costUsd
      // Whatever filled these (the profile, a saved answer or the AI), nobody saw them before now. The flag
      // stays until a person saves the application, so a later run does not take them for reviewed answers.
      // A field that only the live form has is the exception when the owner's settings or profile wrote the answer.
      const written = res.answers.map((a) => (fromOwnerSettings(a) ? a : { ...a, liveOnly: true }))
      answers.push(...written)
      formFields.push(...newFields)
      for (const field of unmatched) {
        const answer = written.find((a) => a.fieldKey === field.key)
        if (answer) matched.push({ field, answer })
      }
    }
    const unreviewed = matched.filter((m) => isUnreviewedLive(m.answer)).map((m) => m.field.label || m.field.key)
    const usesCoverPdf = matched.some((m) => m.answer.value === COVER_LETTER_PDF || m.field.fileHint === 'cover_letter')
    const fileSet = usesCoverPdf ? await files() : { resume: deps.answerDeps.resumePath, coverLetter: null, resumeName: resumeName() }
    const failures = await fillForm(page, snap.frame, matched, fileSet)
    const label = (m: { field: ExtractedField }) => m.field.label || m.field.key
    const flagged = matched
      .filter((m) => m.field.type !== 'file' && answerNeedsUser({ ...m.answer, required: m.answer.required || m.field.required }))
      .map(label)
    const unsure = matched.filter((m) => isGuess(m.answer)).map(label)
    const { tickRequiredConsent, sendSavedUserAnswers } = deps.settings.autopilot
    const userOnly = matched
      .filter((m) => m.field.type !== 'file' && !m.answer.needsUser && m.answer.value !== '' && (mustAskUser(m.field) || mustAskUser(m.answer)))
      // An unticked box says nothing on the person's behalf.
      .filter((m) => !(m.field.type === 'checkbox' && m.answer.value !== 'true'))
      .filter((m) => !(tickRequiredConsent && wasAgreedBySettings(m.answer)))
      // The person wrote these themselves, in the answer bank or on the draft, and Settings lets autopilot send them.
      .filter((m) => !(sendSavedUserAnswers && (m.answer.source === 'answer_bank' || m.answer.source === 'user')))
      .map(label)
    for (const m of matched) {
      if (m.field.type === 'combobox' && m.answer.value !== '' && !m.answer.needsUser && !failures.some((f) => f.label === label(m))) comboboxFilled.add(m.field.jpId)
    }
    const missingFiles = matched.filter((m) => m.field.type === 'file' && m.field.required && failures.some((f) => f.label === label(m))).map(label)
    return {
      frame: snap.frame,
      fieldCount: snap.fields.length,
      newFields: fresh.length,
      flagged: [...flagged, ...missingFiles],
      unsure,
      unreviewed,
      userOnly,
      failures: failures.map((f) => `${f.label}: ${f.reason}`)
    }
  }

  const first = await fillCurrentPage({ clickApply: true, keepExisting: false, readOptions: true })

  if (first.fieldCount === 0) {
    const text = await page.locator('body').innerText().catch(() => '')
    const message = LOGIN_WALL.test(text) || (await page.locator('input[type="password"]').count()) > 0
      ? 'This site wants you to sign in first. Sign in in the browser window, then press Fill again. The browser remembers the login next time.'
      : 'No form fields were found on this page. Open the application in the browser window and click its Apply button, then press Fill again.'
    return leave({ ok: false, status: 'needs_attention', message, screenshotPath: null, confirmation: null, answers, formFields, costUsd }, null)
  }

  // An answer can reveal more fields (choosing "Other" asks what is meant). Auto and dry-run modes read the
  // form again, at most twice more, and fill what showed up. Assist mode leaves that to the person and the watcher.
  const passes: PageFill[] = [first]
  if (mode === 'auto') {
    for (let i = 0; i < REVEAL_PASSES; i++) {
      const next = await fillCurrentPage({ clickApply: false, keepExisting: true, readOptions: true, revealed: true }).catch(() => null)
      if (!next) break
      passes.push(next)
      if (next.newFields === 0) break
    }
  }

  // Everything on the page now (descriptions included) is the baseline. Only a confirmation that
  // appears after this point, with the form gone or the page changed, counts as submitted.
  const baseline = await captureBaseline(page, first.frame)

  // Keeps filling new pages until a confirmation appears or the user closes the tab. It never
  // clicks anything itself, so only the user can move the form forward or send it.
  const watch = (): Promise<SubmitCompletion> =>
    (async () => {
      const before = costUsd
      const done = (confirmed: boolean, screenshotPath: string | null): SubmitCompletion => ({
        confirmed,
        screenshotPath,
        costUsd: costUsd - before,
        answers,
        formFields
      })
      for (let round = 0; round < 40; round++) {
        if (page.isClosed()) break
        if (await waitForUserToFinish(page, baseline, 15_000)) {
          return done(true, await screenshot(page, deps.screenshotsDir, app.id))
        }
        // A new step of a multi-page form shows fields that haven't been filled yet.
        if (round < 12 && !page.isClosed()) await fillCurrentPage({ clickApply: false, keepExisting: true, readOptions: false }).catch(() => null)
      }
      return done(false, null)
    })()

  const problems = [
    ...passes.flatMap((p) => p.flagged).map((l) => `"${l}" needs your answer`),
    ...passes.flatMap((p) => p.unsure).map((l) => `"${l}" is a guess, check it`),
    ...passes.flatMap((p) => p.unreviewed).map((l) => `"${l}" wasn't on the form you reviewed`),
    ...passes.flatMap((p) => p.failures)
  ]

  // The last look before the click. A required field that is still empty, whether the form never showed
  // it before or a fill did not take, is a problem, and a problem means no click.
  let last: FormSnapshot | null = null
  if (mode === 'auto') {
    last = await readForm(page, { clickApply: false })
    const known = [...passes.flatMap((p) => p.flagged), ...passes.flatMap((p) => p.failures.map((f) => f.split(': ')[0]))]
    for (const f of last.fields) {
      if (!f.required || f.hasValue) continue
      // The text box of a dropdown the run filled and checked can stay empty while the page shows the choice.
      if (f.type === 'combobox' && comboboxFilled.has(f.jpId)) continue
      const name = f.label || f.key
      if (known.includes(name)) continue
      problems.push(`"${name}" is required and still empty`)
    }
  }

  if (mode === 'assist') {
    const message = problems.length
      ? `Filled what it could. ${problems.slice(0, 4).join('. ')}. Finish in the browser and press submit there.`
      : 'Everything is filled in. Check the browser window and press submit there. The app records it when the confirmation page shows.'
    return { ok: true, status: 'submitting', message, screenshotPath: null, confirmation: null, answers, formFields, costUsd, completion: watch() }
  }

  // Questions about AI use, legal terms and consent are the user's to send, even with a saved
  // answer. Autopilot leaves them. When the user presses Submit on the Review page, they have seen
  // the answer on the draft and it's their call.
  if (by === 'autopilot') {
    problems.push(...[...new Set(passes.flatMap((p) => p.userOnly))].map((l) => `"${l}" is a question you answer yourself, so autopilot won't send it unless Settings allows it. Check it and press Submit on the Review page`))
  }

  if (deps.settings.autopilot.dryRun) {
    const shot = await screenshot(page, deps.screenshotsDir, app.id)
    // Autopilot has nobody to look at the tab. The screenshot shows the filled form, and the application
    // goes back to the queue marked as dry-run, so the same form is not filled again and again.
    if (by === 'autopilot') {
      if (!deps.settings.browser.keepOpen) await page.close().catch(() => {})
      // A dry run that met a problem is not ready. A person has to look at it, and the real run would stop at the same place.
      return {
        ok: problems.length === 0,
        status: problems.length ? 'needs_attention' : 'ready',
        message: `Dry run: filled and not sent.${problems.length ? ` ${problems.slice(0, 4).join('. ')}.` : ''} See the screenshot.`,
        screenshotPath: shot,
        confirmation: null,
        answers,
        formFields,
        costUsd,
        dryRun: true,
        completion: null
      }
    }
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
    return leave(
      {
        ok: false,
        status: 'needs_attention',
        message: `Didn't submit. ${problems.slice(0, 4).join('. ')}. Fix it in the browser and press submit there.`,
        screenshotPath: null,
        confirmation: null,
        answers,
        formFields,
        costUsd
      },
      watch
    )
  }

  const snap = last ?? (await readForm(page, { clickApply: false }))
  // A job board lists other companies' jobs. A button there belongs to a search or a newsletter.
  if (isJobBoardUrl(page.url())) {
    return leave(
      {
        ok: false,
        status: 'needs_attention',
        message: "This page is a job board, not the employer's form. Open the posting and apply on the company's site.",
        screenshotPath: null,
        confirmation: null,
        answers,
        formFields,
        costUsd
      },
      watch
    )
  }
  if (await hasMorePages(snap.frame)) {
    return leave(
      {
        ok: false,
        status: 'needs_attention',
        message: 'This form has more than one page. Use Fill and let me submit, then press Next and Submit in the browser.',
        screenshotPath: null,
        confirmation: null,
        answers,
        formFields,
        costUsd
      },
      watch
    )
  }
  const preClick = await captureBaseline(page, snap.frame)
  if (!deps.recordSubmitClick(new Date().toISOString())) {
    return leave(
      {
        ok: false,
        status: 'needs_attention',
        message: "Didn't submit. Autopilot was paused or the application changed while the form was being filled, so the app left it for you.",
        screenshotPath: null,
        confirmation: null,
        answers,
        formFields,
        costUsd
      },
      watch
    )
  }
  if (!(await clickSubmit(snap.frame))) {
    deps.recordSubmitClick(null)
    return leave(
      { ok: false, status: 'needs_attention', message: "Couldn't find the submit button. Press it in the browser window.", screenshotPath: null, confirmation: null, answers, formFields, costUsd },
      watch
    )
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
