import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { readForm } from './browser'
import { captureBaseline, clickSubmit, confirmationSeen, hasMorePages, waitForOutcome } from './submit'

// Which button the final click may use, and when a page counts as submitted, in a headless browser.

const executablePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => fs.existsSync(p))

// Counts every submit event, so a test can tell which form was sent.
const COUNT_SUBMITS = `<script>
  window.__sent = []
  document.addEventListener('submit', (e) => { e.preventDefault(); window.__sent.push(e.target.id) })
</script>`

const FIELDS = `<label for="fn">First name</label><input id="fn" name="first_name">
  <label for="ln">Last name</label><input id="ln" name="last_name">
  <label for="em">Email</label><input id="em" name="email" type="email">`

describe.skipIf(!executablePath)('submit buttons and confirmations (headless browser)', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath, headless: true })
  }, 30_000)
  afterEach(async () => {
    await page?.close().catch(() => {})
  })
  afterAll(async () => {
    await browser?.close()
  })

  const sent = () => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent)

  async function open(html: string) {
    page = await browser.newPage()
    await page.setContent(html)
    return readForm(page, { clickApply: false })
  }

  describe('clickSubmit', () => {
    it('clicks the Submit button of the application form', async () => {
      const { frame } = await open(`<form id="app">${FIELDS}<button type="submit">Submit application</button></form>${COUNT_SUBMITS}`)
      expect(await clickSubmit(frame)).toBe(true)
      expect(await sent()).toEqual(['app'])
    })

    it('does not click a form that only has a Next button', async () => {
      const { frame } = await open(`<form id="app">${FIELDS}<button type="submit">Next</button></form>${COUNT_SUBMITS}`)
      expect(await clickSubmit(frame)).toBe(false)
      expect(await hasMorePages(frame)).toBe(true)
      expect(await sent()).toEqual([])
    })

    it('does not click Continue, Save and continue, Search or Sign up buttons', async () => {
      for (const name of ['Continue', 'Save and continue', 'Search', 'Sign up', 'Log in']) {
        const { frame } = await open(`<form id="app">${FIELDS}<input type="submit" value="${name}"></form>${COUNT_SUBMITS}`)
        expect(await clickSubmit(frame), name).toBe(false)
        expect(await sent(), name).toEqual([])
        await page.close()
      }
    })

    it('does not click a newsletter form outside the application form', async () => {
      const { frame } = await open(
        `<form id="app">${FIELDS}</form>
         <footer><form id="news"><input name="newsletter_email" type="email"><button type="submit">Subscribe</button></form>
         <form id="news2"><input name="e2" type="email"><button type="submit">Submit</button></form></footer>${COUNT_SUBMITS}`
      )
      expect(await clickSubmit(frame)).toBe(false)
      expect(await sent()).toEqual([])
    })

    it('clicks the application form when a newsletter form sits beside it', async () => {
      const { frame } = await open(
        `<form id="app">${FIELDS}<button type="submit">Submit application</button></form>
         <form id="news"><input name="newsletter_email" type="email"><button type="submit">Submit</button></form>${COUNT_SUBMITS}`
      )
      expect(await clickSubmit(frame)).toBe(true)
      expect(await sent()).toEqual(['app'])
    })

    it('uses a generic submit button only inside the application form', async () => {
      const { frame } = await open(`<form id="app">${FIELDS}<button type="submit">Send</button></form><form id="news"><button type="submit">Send</button></form>${COUNT_SUBMITS}`)
      expect(await clickSubmit(frame)).toBe(true)
      expect(await sent()).toEqual(['app'])
    })

    it('prefers a submit button in the form to a named button outside every form', async () => {
      const { frame } = await open(
        `<form id="app">${FIELDS}<button type="submit">Send</button></form>
         <button type="button" onclick="window.__sent.push('loose')">Apply</button>${COUNT_SUBMITS}`
      )
      expect(await clickSubmit(frame)).toBe(true)
      expect(await sent()).toEqual(['app'])
    })

    it('has no generic fallback when no form holds the fields', async () => {
      const { frame } = await open(`<div>${FIELDS}</div><form id="other"><button type="submit">Send</button></form>${COUNT_SUBMITS}`)
      expect(await clickSubmit(frame)).toBe(false)
      expect(await sent()).toEqual([])
    })
  })

  describe('hasMorePages', () => {
    it('is false when a Submit button is on the page', async () => {
      const { frame } = await open(`<form id="app">${FIELDS}<button type="button">Next</button><button type="submit">Submit</button></form>`)
      expect(await hasMorePages(frame)).toBe(false)
    })

    it('is true for a Continue button with no Submit button', async () => {
      const { frame } = await open(`<form id="app">${FIELDS}<button type="button">Continue</button></form>`)
      expect(await hasMorePages(frame)).toBe(true)
    })
  })

  describe('confirmations', () => {
    it('sees a confirmation inside an iframe, even with a newsletter button on the page', async () => {
      const inner = `<form id="app">${FIELDS}<button type="submit">Submit application</button></form>
        <script>document.getElementById('app').addEventListener('submit', (e) => { e.preventDefault(); document.body.innerHTML = '<h1>Thank you for applying!</h1>' })</script>`
      page = await browser.newPage()
      await page.setContent(`<h1>Careers</h1><iframe id="job" srcdoc="${inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" width="600" height="400"></iframe>
        <footer><form><input name="news" type="email"><button type="submit">Subscribe</button></form></footer>`)
      await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.getElementById('em'))
      const { frame } = await readForm(page, { clickApply: false })
      expect(frame).not.toBe(page.mainFrame())
      const baseline = await captureBaseline(page, frame)
      expect(await confirmationSeen(page, baseline)).toBeNull()
      expect(await clickSubmit(frame)).toBe(true)
      const outcome = await waitForOutcome(page, frame, baseline, 6000)
      expect(outcome.kind).toBe('confirmed')
    })

    it('does not count a confirmation when the form is still there', async () => {
      const { frame } = await open(`<form id="app">${FIELDS}<button type="submit">Submit</button></form>`)
      const baseline = await captureBaseline(page, frame)
      await page.evaluate(() => {
        document.body.append(Object.assign(document.createElement('p'), { textContent: 'Thank you for applying' }))
      })
      expect(await confirmationSeen(page, baseline)).toBeNull()
    })

    it('counts a confirmation when the form frame moved to a new page', async () => {
      const inner = `<form>${FIELDS}</form>`
      page = await browser.newPage()
      await page.setContent(`<iframe id="job" srcdoc="${inner.replace(/"/g, '&quot;')}"></iframe>`)
      await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.getElementById('em'))
      const { frame } = await readForm(page, { clickApply: false })
      const baseline = await captureBaseline(page, frame)
      await page.route('**/done', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Thank you for applying!</p>' }))
      await page.evaluate(() => {
        const job = document.getElementById('job') as HTMLIFrameElement
        job.removeAttribute('srcdoc')
        job.src = 'http://example.test/done'
      })
      await page.waitForTimeout(500)
      expect(await confirmationSeen(page, baseline)).toMatch(/thank you for applying/i)
    })
  })

  describe('confirmation by address', () => {
    const FORM_PAGE = `<form id="app" method="post" action="ACTION">${FIELDS}<button type="submit">Submit application</button></form>`

    /** Opens a page at `url` that posts to `action`, and answers the post with `reply`. */
    async function openAt(url: string, action: string, reply: string) {
      page = await browser.newPage()
      await page.route('http://example.test/**', (route) => {
        const target = route.request()
        const body = target.method() === 'POST' ? reply : FORM_PAGE.replace('ACTION', action)
        return route.fulfill({ contentType: 'text/html', body })
      })
      await page.goto(url)
      const read = await readForm(page, { clickApply: false })
      const baseline = await captureBaseline(page, read.frame)
      return { frame: read.frame, baseline }
    }

    it('does not confirm a form shown again with an error after a page load', async () => {
      const { frame, baseline } = await openAt(
        'http://example.test/careers/customer-success-manager',
        '/customer-success-manager/apply',
        `<p>Something went wrong.</p>${FORM_PAGE}`
      )
      expect(await clickSubmit(frame)).toBe(true)
      const outcome = await waitForOutcome(page, frame, baseline, 4000)
      expect(outcome.kind).not.toBe('confirmed')
    }, 20_000)

    it('does not confirm a job title that contains "success" even when no form is shown', async () => {
      const { frame, baseline } = await openAt('http://example.test/careers/customer-success-lead', '/customer-success-lead/apply', '<p>Please try again later.</p>')
      expect(await clickSubmit(frame)).toBe(true)
      await page.waitForURL('**/customer-success-lead/apply')
      expect(await confirmationSeen(page, baseline)).toBeNull()
    })

    it('confirms a thank-you page that has no form or text match', async () => {
      const { frame, baseline } = await openAt('http://example.test/careers/analyst', '/careers/analyst/thank-you', '<h1>Done</h1>')
      expect(await clickSubmit(frame)).toBe(true)
      await page.waitForURL('**/thank-you')
      expect(await confirmationSeen(page, baseline)).toContain('/thank-you')
    })

    it('confirms a "submitted" flag in the query string', async () => {
      const { frame, baseline } = await openAt('http://example.test/careers/analyst', '/careers/analyst?submitted=true', '<h1>Done</h1>')
      expect(await clickSubmit(frame)).toBe(true)
      await page.waitForURL('**/analyst?submitted=true')
      expect(await confirmationSeen(page, baseline)).toContain('submitted=true')
    })

    it('does not confirm a thank-you address while a form control is on screen', async () => {
      const { frame, baseline } = await openAt('http://example.test/careers/analyst', '/careers/analyst/thank-you', `<h1>Done</h1><input name="search">`)
      expect(await clickSubmit(frame)).toBe(true)
      await page.waitForURL('**/thank-you')
      expect(await confirmationSeen(page, baseline)).toBeNull()
    })

    it('does not confirm when the keyword was already in the address before the click', async () => {
      const { frame, baseline } = await openAt('http://example.test/thank-you/jobs/analyst', '/thank-you/jobs/analyst/apply', '<h1>Done</h1>')
      expect(await clickSubmit(frame)).toBe(true)
      await page.waitForURL('**/apply')
      expect(await confirmationSeen(page, baseline)).toBeNull()
    })
  })

  describe('required text', () => {
    const REQUIRED_FORM = `<form id="app" novalidate>${FIELDS}<button type="submit">Submit application</button></form>
      <script>document.getElementById('app').addEventListener('submit', (e) => { e.preventDefault(); window.__sent = 1 })</script>`

    it('ignores "is required" wording that was on the page before the click', async () => {
      const { frame } = await open(`<p>A bachelor's degree is required. Please fill in your details below.</p>${REQUIRED_FORM}`)
      const baseline = await captureBaseline(page, frame)
      expect(await clickSubmit(frame)).toBe(true)
      const outcome = await waitForOutcome(page, frame, baseline, 5000)
      expect(outcome.kind).toBe('unknown')
    }, 20_000)

    it('reports "is required" text that appears after the click', async () => {
      const { frame } = await open(
        `${REQUIRED_FORM}<script>document.getElementById('app').addEventListener('submit', () => { document.body.append(Object.assign(document.createElement('p'), { textContent: 'This field is required' })) })</script>`
      )
      const baseline = await captureBaseline(page, frame)
      expect(await clickSubmit(frame)).toBe(true)
      const outcome = await waitForOutcome(page, frame, baseline, 8000)
      expect(outcome.kind).toBe('invalid')
    }, 20_000)
  })
})
