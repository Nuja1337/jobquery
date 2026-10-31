import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core'
import type { BrowserChannel, BrowserSettings } from '@shared/types'
import { EXTRACT_FIELDS_SCRIPT, type ExtractedField } from './extractScript'

/**
 * Drives the user's installed Chrome or Edge through Playwright. No browser is downloaded.
 *
 * The visible browser uses its own profile folder, so logins to job sites (Workday accounts,
 * LinkedIn and so on) stay signed in between runs. A separate headless browser reads forms
 * in the background while applications are being prepared.
 */
export class BrowserManager {
  private visible: BrowserContext | null = null
  private headless: Browser | null = null
  // Two callers asking at once share one launch instead of starting two browsers.
  private visibleLaunch: Promise<BrowserContext> | null = null
  private headlessLaunch: Promise<Browser> | null = null

  constructor(private readonly profileDir: string) {}

  private launchOrder(channel: BrowserChannel): Array<string | undefined> {
    // Fall back to the other installed browser if the chosen one isn't there.
    const order: Array<string | undefined> = [channel === 'chromium' ? undefined : channel]
    for (const c of ['chrome', 'msedge', undefined]) if (!order.includes(c)) order.push(c)
    return order
  }

  async visibleContext(settings: BrowserSettings): Promise<BrowserContext> {
    if (this.visible) return this.visible
    this.visibleLaunch ??= this.launchVisible(settings).finally(() => {
      this.visibleLaunch = null
    })
    return this.visibleLaunch
  }

  private async launchVisible(settings: BrowserSettings): Promise<BrowserContext> {
    let lastError: unknown = null
    for (const channel of this.launchOrder(settings.channel)) {
      try {
        const context = await chromium.launchPersistentContext(this.profileDir, {
          channel,
          headless: false,
          slowMo: settings.slowMoMs,
          viewport: null,
          args: ['--start-maximized']
        })
        context.on('close', () => {
          if (this.visible === context) this.visible = null
        })
        this.visible = context
        return context
      } catch (err) {
        lastError = err
      }
    }
    throw new Error(`Could not open a browser. Install Chrome or Edge, or pick another browser in Settings. (${(lastError as Error)?.message ?? 'unknown error'})`)
  }

  /** The background browser, started on first use and again if it crashed or was closed. */
  private async headlessBrowser(settings: BrowserSettings): Promise<Browser> {
    if (this.headless?.isConnected()) return this.headless
    this.headlessLaunch ??= (async () => {
      let lastError: unknown = null
      for (const channel of this.launchOrder(settings.channel)) {
        try {
          const browser = await chromium.launch({ channel, headless: true })
          browser.on('disconnected', () => {
            if (this.headless === browser) this.headless = null
          })
          this.headless = browser
          return browser
        } catch (err) {
          lastError = err
        }
      }
      throw new Error(`Could not start a background browser. (${(lastError as Error)?.message ?? 'unknown error'})`)
    })().finally(() => {
      this.headlessLaunch = null
    })
    return this.headlessLaunch
  }

  async newVisiblePage(settings: BrowserSettings): Promise<Page> {
    const ctx = await this.visibleContext(settings)
    const blank = ctx.pages().find((p) => p.url() === 'about:blank')
    return blank ?? ctx.newPage()
  }

  async headlessPage(settings: BrowserSettings): Promise<Page> {
    const browser = await this.headlessBrowser(settings)
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    })
    const page = await ctx.newPage()
    page.on('close', () => void ctx.close().catch(() => {}))
    return page
  }

  async close(): Promise<void> {
    // A launch still starting would leave a browser running after quit, so wait for it first.
    await Promise.allSettled([this.visibleLaunch, this.headlessLaunch])
    await Promise.allSettled([this.visible?.close(), this.headless?.close()])
    this.visible = null
    this.headless = null
  }
}

export interface FormSnapshot {
  frame: Frame
  fields: ExtractedField[]
}

/**
 * Finds the frame holding the application form (some company sites embed the ATS in an
 * iframe) and lists its fields. With `clickApply`, it first clicks an "Apply" button when the
 * form is behind one. Links are fine, but a button inside a form is never clicked, because on
 * some sites the final submit button of the application itself is labelled "Apply".
 */
export async function readForm(page: Page, options: { clickApply?: boolean } = {}): Promise<FormSnapshot> {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})

  let best = await bestFrame(page)
  if (best.fields.filter((f) => f.type !== 'checkbox').length < 3 && options.clickApply !== false) {
    const apply = page
      .getByRole('button', { name: /^(apply|apply now|apply for this job|i'm interested)$/i })
      .or(page.getByRole('link', { name: /^(apply|apply now|apply for this job)$/i }))
    for (const candidate of await apply.all()) {
      if (!(await candidate.isVisible().catch(() => false))) continue
      const submitsAForm = await candidate
        .evaluate((el) => el.tagName !== 'A' && Boolean((el as HTMLButtonElement).form || el.closest('form')))
        .catch(() => true)
      if (submitsAForm) continue
      await candidate.click()
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(800)
      best = await bestFrame(page)
      break
    }
  }
  return best
}

async function bestFrame(page: Page): Promise<FormSnapshot> {
  let best: FormSnapshot = { frame: page.mainFrame(), fields: [] }
  for (const frame of page.frames()) {
    try {
      const fields = (await frame.evaluate(EXTRACT_FIELDS_SCRIPT)) as ExtractedField[]
      if (fields.length > best.fields.length) best = { frame, fields }
    } catch {
      // Cross-origin frames that are still loading can throw. Skip them.
    }
  }
  return best
}

/** Blocking challenges only. Invisible reCAPTCHA badges don't count. */
export async function hasVisibleCaptcha(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const url = frame.url()
    if (/recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/.test(url)) {
      const el = await frame.frameElement().catch(() => null)
      if (el && (await el.isVisible().catch(() => false))) {
        const box = await el.boundingBox().catch(() => null)
        if (box && box.width > 50 && box.height > 50) return true
      }
    }
  }
  return false
}
