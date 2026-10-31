import type { Frame, Page } from 'playwright-core'
import { hasVisibleCaptcha } from './browser'

const CONFIRMATION_TEXT =
  /thank(s| you) for (applying|your (application|interest))|application (has been |was )?(successfully )?(received|submitted|sent)|we('ve| have) received your application|your application is (complete|on its way)|application submitted/i
const CONFIRMATION_URL = /confirm|thank|submitted|success|complete/i
const INVALID_TEXT = /(this field is|is) required|please (fill|complete|enter|select|upload)|can'?t be blank|must be (filled|completed)/i

export type SubmitOutcome =
  | { kind: 'confirmed'; text: string }
  | { kind: 'invalid'; details: string }
  | { kind: 'captcha' }
  | { kind: 'unknown' }

/** Finds the form's submit button. Returns false when there isn't a clear one. */
export async function clickSubmit(frame: Frame): Promise<boolean> {
  const candidates = [
    frame.getByRole('button', { name: /^(submit|submit application|send application|submit your application|apply|complete application)$/i }),
    frame.locator('button[type="submit"]'),
    frame.locator('input[type="submit"]')
  ]
  for (const loc of candidates) {
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

async function pageText(page: Page): Promise<string> {
  const parts: string[] = []
  for (const frame of page.frames()) {
    parts.push(await frame.locator('body').innerText({ timeout: 1000 }).catch(() => ''))
  }
  return parts.join('\n')
}

/** Watches the page after the submit click until it confirms, shows errors, asks for a captcha or times out. */
export async function waitForOutcome(page: Page, frame: Frame, timeoutMs = 25_000): Promise<SubmitOutcome> {
  const startUrl = page.url()
  const deadline = Date.now() + timeoutMs
  let invalidSeenAt: number | null = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000)
    if (page.isClosed()) return { kind: 'unknown' }
    const text = await pageText(page)
    const match = text.match(CONFIRMATION_TEXT)
    if (match) return { kind: 'confirmed', text: match[0] }
    if (page.url() !== startUrl && CONFIRMATION_URL.test(page.url())) return { kind: 'confirmed', text: page.url() }
    if (await hasVisibleCaptcha(page)) return { kind: 'captcha' }
    const invalidCount = await frame.locator('[aria-invalid="true"]').count().catch(() => 0)
    const invalidText = INVALID_TEXT.test(text)
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

/** Waits for the user to finish (solve a captcha, fix a field, press submit) and confirms when they do. */
export async function waitForUserToFinish(page: Page, timeoutMs = 10 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.isClosed()) return false
    await page.waitForTimeout(2000).catch(() => {})
    if (page.isClosed()) return false
    const text = await pageText(page)
    if (CONFIRMATION_TEXT.test(text)) return true
  }
  return false
}
