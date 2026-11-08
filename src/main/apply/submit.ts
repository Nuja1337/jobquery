import type { Frame, Locator, Page } from 'playwright-core'
import { hasVisibleCaptcha } from './browser'

// Phrases employers' confirmation pages use. Kept specific: "thank you for your interest" is
// left out because many job descriptions end with it.
const CONFIRMATION_TEXT =
  /thank(s| you) for (applying|submitting|your application)|application (has been |was )?(successfully )?(received|submitted|sent)|we('ve| have) received your application|your application is (complete|on its way)|application submitted|successfully submitted/gi
// A page address alone counts only when a whole path segment says so ("/thank-you", "/confirmation"),
// or the query does ("?submitted=true"). A word inside a job title such as
// "/customer-success-manager" doesn't count. It never counts for a step that still wants something
// from the person, such as "/confirm-email" or "/complete-profile".
const CONFIRMATION_SEGMENT = /^(thanks?|thank[-_]?you([-_].*)?|(application[-_])?(submitted|received|complete|completed|confirmation)|success(ful)?|complete(d)?|confirmation|confirmed|applied)$/i
const CONFIRMATION_PARAM = /^(submitted|success|applied|confirmed|complete|completed)$/i
const CONFIRMATION_STATUS = /^(success|successful|submitted|complete|completed|confirmed)$/i
const UNFINISHED_URL = /verify|e-?mail|sign-?in|log-?in|account|password|profile/i
// Counted before and after the click, because a job description can say "A bachelor's degree is required".
const INVALID_TEXT = /(this field is|is) required|please (fill|complete|enter|select|upload)|can'?t be blank|must be (filled|completed)/gi
const SUBMIT_NAME = /^(submit|submit application|send application|submit your application|apply|complete application)$/i
// Buttons that move to another step or belong to some other form. They are never the final click.
const NEXT_NAME = /^(next|next step|continue|save (and|&) continue|continue to .*|proceed)$/i
const NOT_SUBMIT = /\b(next|continue|proceed|search|subscribe|sign ?up|sign ?in|log ?in|follow|notify|newsletter)\b/i

export type SubmitOutcome =
  | { kind: 'confirmed'; text: string }
  | { kind: 'invalid'; details: string }
  | { kind: 'captcha' }
  | { kind: 'unknown' }

/** What the page looked like before the submit click, so old text can't pass as a confirmation. */
export interface PageBaseline {
  url: string
  confirmationCount: number
  invalidCount: number
  /** The frame that holds the form, and its address. An embedded form can finish without the page changing. */
  frame: Frame
  frameUrl: string
}

async function pageText(page: Page): Promise<string> {
  const parts: string[] = []
  for (const frame of page.frames()) {
    parts.push(await frame.locator('body').innerText({ timeout: 1000 }).catch(() => ''))
  }
  return parts.join('\n')
}

function countConfirmations(text: string): number {
  return [...text.matchAll(CONFIRMATION_TEXT)].length
}

function countInvalid(text: string): number {
  return [...text.matchAll(INVALID_TEXT)].length
}

/** Records the page before the submit click. The frame is the one the form was read from. */
export async function captureBaseline(page: Page, frame: Frame = page.mainFrame()): Promise<PageBaseline> {
  const text = await pageText(page)
  return { url: page.url(), confirmationCount: countConfirmations(text), invalidCount: countInvalid(text), frame, frameUrl: frame.url() }
}

const safeDecode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** True when the address itself says the application went through. */
function confirmationAddress(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.pathname.split('/').some((segment) => CONFIRMATION_SEGMENT.test(safeDecode(segment)))) return true
  for (const [key, value] of parsed.searchParams) {
    if (CONFIRMATION_PARAM.test(key) && !/^(false|0|no)$/i.test(value)) return true
    if (key.toLowerCase() === 'status' && CONFIRMATION_STATUS.test(value)) return true
  }
  return false
}

/** True when any frame of the page shows an input, a select, a textarea or a submit button. */
async function formControlsVisible(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const shown = await frame
      .evaluate(() =>
        Array.from(document.querySelectorAll('input, select, textarea, button[type="submit"]')).some((el) => {
          if (el instanceof HTMLInputElement && el.type === 'hidden') return false
          const style = getComputedStyle(el)
          return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0
        })
      )
      .catch(() => false)
    if (shown) return true
  }
  return false
}

/** True when one of the fields that were filled (they carry data-jp-id) is still on screen in the form's frame. */
async function filledFieldsVisible(frame: Frame): Promise<boolean> {
  if (frame.isDetached()) return false
  const fields = frame.locator('[data-jp-id]')
  const n = await fields.count().catch(() => 0)
  for (let i = 0; i < n; i++) if (await fields.nth(i).isVisible().catch(() => false)) return true
  return false
}

async function visibleText(loc: Locator, i: number): Promise<string> {
  const el = loc.nth(i)
  return ((await el.innerText({ timeout: 500 }).catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim()
}

/**
 * Marks the <form> that holds the filled fields (the ones with data-jp-id) and returns whether there is
 * one. A newsletter or search form on the same page holds a field or two, so the form must hold most of them.
 */
async function markApplicationForm(frame: Frame): Promise<boolean> {
  return frame
    .evaluate(() => {
      document.querySelectorAll('[data-jp-form]').forEach((f) => f.removeAttribute('data-jp-form'))
      const total = document.querySelectorAll('[data-jp-id]').length
      let best: HTMLFormElement | null = null
      let most = 0
      for (const form of Array.from(document.forms)) {
        const n = form.querySelectorAll('[data-jp-id]').length
        if (n > most) {
          best = form
          most = n
        }
      }
      if (!best || most * 2 < total) return false
      best.setAttribute('data-jp-form', '1')
      return true
    })
    .catch(() => false)
}

/** Submit buttons that are not named like a step or a search, and are inside the application form. */
async function formSubmitButtons(frame: Frame): Promise<Locator[]> {
  const found: Locator[] = []
  if (!(await markApplicationForm(frame))) return found
  const form = frame.locator('form[data-jp-form]')
  for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
    const loc = form.locator(selector)
    const count = await loc.count().catch(() => 0)
    for (let i = count - 1; i >= 0; i--) {
      if (NOT_SUBMIT.test(await visibleText(loc, i))) continue
      found.push(loc.nth(i))
    }
  }
  return found
}

async function clickable(btn: Locator): Promise<boolean> {
  return (await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))
}

/** True when the form shows a Next or Continue button and no Submit button, so it has more pages. */
export async function hasMorePages(frame: Frame): Promise<boolean> {
  const submit = frame.getByRole('button', { name: SUBMIT_NAME })
  for (let i = 0; i < (await submit.count().catch(() => 0)); i++) if (await submit.nth(i).isVisible().catch(() => false)) return false
  const next = frame.getByRole('button', { name: NEXT_NAME })
  for (let i = 0; i < (await next.count().catch(() => 0)); i++) if (await next.nth(i).isVisible().catch(() => false)) return true
  return false
}

/**
 * True only when the page shows a confirmation that wasn't there before, and the form is gone
 * or the page moved. Both are needed so a description or a failed submit can't count.
 */
export async function confirmationSeen(page: Page, baseline: PageBaseline): Promise<string | null> {
  if (page.isClosed()) return null
  const text = await pageText(page)
  const matches = [...text.matchAll(CONFIRMATION_TEXT)]
  const moved = page.url() !== baseline.url || baseline.frame.url() !== baseline.frameUrl
  const formGone = !(await filledFieldsVisible(baseline.frame))
  if (matches.length > baseline.confirmationCount && (moved || formGone)) return matches[matches.length - 1][0]
  // The address alone is weaker than text. A page load clears the tags on the filled fields, so formGone
  // is always true after one. A form shown again with an error must not pass, so no control may be visible.
  const url = new URL(page.url())
  if (moved && formGone && confirmationAddress(page.url()) && !confirmationAddress(baseline.url) && !UNFINISHED_URL.test(url.pathname + url.search) && !(await formControlsVisible(page))) {
    return page.url()
  }
  return null
}

/**
 * Finds the form's submit button and clicks it. The order is a button named Submit or Apply inside the
 * application form, any other submit button inside it, and last a named button outside every form.
 * A button named Next, Search, Subscribe or the like is never clicked, and a button inside some other form
 * is never clicked. Returns false when there isn't a clear button.
 */
export async function clickSubmit(frame: Frame): Promise<boolean> {
  await markApplicationForm(frame)
  const named = frame.getByRole('button', { name: SUBMIT_NAME })
  const inForm: Locator[] = []
  const loose: Locator[] = []
  for (let i = (await named.count().catch(() => 0)) - 1; i >= 0; i--) {
    const btn = named.nth(i)
    // A button inside some other form (a newsletter, a search) is not this application's.
    const where = await btn.evaluate((el) => {
      const form = el.closest('form')
      return !form ? 'none' : form.hasAttribute('data-jp-form') ? 'application' : 'other'
    }).catch(() => 'other')
    if (where === 'application') inForm.push(btn)
    else if (where === 'none') loose.push(btn)
  }
  // A named button in the form, then any submit button in the form, then a named button outside every form.
  for (const btn of [...inForm, ...(await formSubmitButtons(frame)), ...loose]) {
    if (!(await clickable(btn))) continue
    await btn.scrollIntoViewIfNeeded().catch(() => {})
    await btn.click()
    return true
  }
  return false
}

/** Watches the page after the submit click until it confirms, shows errors, asks for a captcha or times out. */
export async function waitForOutcome(page: Page, frame: Frame, baseline: PageBaseline, timeoutMs = 25_000): Promise<SubmitOutcome> {
  const deadline = Date.now() + timeoutMs
  let invalidSeenAt: number | null = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000)
    if (page.isClosed()) return { kind: 'unknown' }
    const confirmed = await confirmationSeen(page, baseline)
    if (confirmed) return { kind: 'confirmed', text: confirmed }
    if (await hasVisibleCaptcha(page)) return { kind: 'captcha' }
    const invalidCount = await frame.locator('[aria-invalid="true"]').count().catch(() => 0)
    // Only text that appeared since the click counts. The posting may say "a degree is required".
    const invalidText = countInvalid(await pageText(page)) > baseline.invalidCount
    if (invalidCount > 0 || invalidText) {
      invalidSeenAt ??= Date.now()
      // Give client-side validation a moment to settle before calling it a failure.
      if (Date.now() - invalidSeenAt > 2500) {
        const labels = await frame
          .locator('[aria-invalid="true"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.getAttribute('name') || e.id).filter(Boolean).slice(0, 8))
          .catch(() => [] as string[])
        return { kind: 'invalid', details: labels.length ? `The form flagged: ${labels.join(', ')}.` : 'The form says some fields still need attention.' }
      }
    }
  }
  return { kind: 'unknown' }
}

/**
 * Waits for the user to finish in the browser (solve a captcha, fix a field, press submit).
 * Resolves to true when a new confirmation appears, false on timeout or when the tab closes.
 */
export async function waitForUserToFinish(page: Page, baseline: PageBaseline, timeoutMs = 10 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.isClosed()) return false
    await page.waitForTimeout(2000).catch(() => {})
    if (await confirmationSeen(page, baseline).catch(() => null)) return true
  }
  return false
}
