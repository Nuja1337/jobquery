import type { Frame, Page } from 'playwright-core'
import { hasVisibleCaptcha } from './browser'

// Phrases employers' confirmation pages use. Kept specific: "thank you for your interest" is
// left out because many job descriptions end with it.
const CONFIRMATION_TEXT =
  /thank(s| you) for (applying|submitting|your application)|application (has been |was )?(successfully )?(received|submitted|sent)|we('ve| have) received your application|your application is (complete|on its way)|application submitted|successfully submitted/gi
const CONFIRMATION_URL = /confirm|thank|submitted|success|complete/i
const INVALID_TEXT = /(this field is|is) required|please (fill|complete|enter|select|upload)|can'?t be blank|must be (filled|completed)/i
const SUBMIT_NAME = /^(submit|submit application|send application|submit your application|apply|complete application)$/i

export type SubmitOutcome =
  | { kind: 'confirmed'; text: string }
  | { kind: 'invalid'; details: string }
  | { kind: 'captcha' }
  | { kind: 'unknown' }

/** What the page looked like before the submit click, so old text can't pass as a confirmation. */
export interface PageBaseline {
  url: string
  confirmationCount: number
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

export async function captureBaseline(page: Page): Promise<PageBaseline> {
  return { url: page.url(), confirmationCount: countConfirmations(await pageText(page)) }
}

function submitButtons(frame: Frame) {
  return [frame.getByRole('button', { name: SUBMIT_NAME }), frame.locator('button[type="submit"]'), frame.locator('input[type="submit"]')]
}

async function anySubmitVisible(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    for (const loc of submitButtons(frame)) {
      const n = await loc.count().catch(() => 0)
      for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true
    }
  }
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
  const moved = page.url() !== baseline.url
  const formGone = !(await anySubmitVisible(page))
  if (matches.length > baseline.confirmationCount && (moved || formGone)) return matches[matches.length - 1][0]
  if (moved && formGone && CONFIRMATION_URL.test(new URL(page.url()).pathname + new URL(page.url()).search)) return page.url()
  return null
}

/** Finds the form's submit button and clicks it. Returns false when there isn't a clear one. */
export async function clickSubmit(frame: Frame): Promise<boolean> {
  for (const loc of submitButtons(frame)) {
    const count = await loc.count()
    for (let i = count - 1; i >= 0; i--) {
      const btn = loc.nth(i)
      if ((await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))) {
        await btn.scrollIntoViewIfNeeded().catch(() => {})
        await btn.click()
        return true
      }
    }
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
    const invalidText = INVALID_TEXT.test(await pageText(page))
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
