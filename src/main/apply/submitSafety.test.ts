import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Application, Job, PreparedAnswer, Profile } from '@shared/types'
import type { LlmService } from '../llm/service'
import { readForm, type BrowserManager } from './browser'
import { fillForm, matchAnswers, readComboboxOptions } from './fill'
import { runSubmission } from './submitRun'

// What auto mode refuses to send, checked end to end in a real headless browser.

function findBrowser(): string | undefined {
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].find((p) => fs.existsSync(p))
}
const executablePath = findBrowser()

const PROFILE: Profile = { ...EMPTY_PROFILE, fullName: 'Sam Rivera', email: 'sam@example.com' }

const SUBMIT_SCRIPT = `<script>
  document.getElementById('f').addEventListener('submit', (e) => {
    e.preventDefault()
    window.__submits = (window.__submits || 0) + 1
    document.body.innerHTML = '<h1>Thank you for applying!</h1>'
  })
</script>`

function formHtml(extra = ''): string {
  return `<!doctype html><html><body>
<form id="f" novalidate>
  <label for="fn">First name *</label><input id="fn" name="first_name" required>
  <label for="ln">Last name *</label><input id="ln" name="last_name" required>
  <label for="em">Email *</label><input id="em" name="email" type="email" required>
  ${extra}
  <button type="submit">Submit application</button>
</form>${SUBMIT_SCRIPT}</body></html>`
}

const answer = (fieldKey: string, label: string, value: string, patch: Partial<PreparedAnswer> = {}): PreparedAnswer => ({
  fieldKey,
  label,
  type: 'text',
  required: true,
  options: [],
  value,
  source: 'profile',
  confidence: 0.98,
  needsUser: false,
  note: null,
  lint: null,
  ...patch
})

const DRAFT = [answer('first_name', 'First name', 'Sam'), answer('last_name', 'Last name', 'Rivera'), answer('email', 'Email', 'sam@example.com')]

describe.skipIf(!executablePath)('auto mode safety (headless browser)', () => {
  let browser: Browser
  let page: Page
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-safety-'))

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath, headless: true })
    // Starting a browser can take a while on a busy machine.
  }, 30_000)
  afterEach(async () => {
    await page?.close().catch(() => {})
  })
  afterAll(async () => {
    await browser?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function run(html: string, draft: PreparedAnswer[], allowClick = true, by: 'user' | 'autopilot' = 'autopilot') {
    const file = path.join(dir, `form-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
    fs.writeFileSync(file, html)
    page = await browser.newPage()
    const clicks: Array<string | null> = []
    const job = { id: 'job1', company: 'Acme', title: 'Engineer', location: null, description: 'Build things.', fit: null, source: 'greenhouse', url: pathToFileURL(file).href, applyUrl: pathToFileURL(file).href, ats: 'unknown' } as unknown as Job
    const app = { id: 'app1', jobId: 'job1', answers: draft, formFields: [], coverLetter: null } as unknown as Application
    const llm = { json: () => Promise.reject(new Error('No AI call expected')), text: () => Promise.reject(new Error('No AI call expected')) } as unknown as LlmService
    const result = await runSubmission(
      {
        browser: { newVisiblePage: async () => page } as unknown as BrowserManager,
        settings: { ...DEFAULT_SETTINGS, browser: { ...DEFAULT_SETTINGS.browser, keepOpen: true } },
        answerDeps: { llm, settings: DEFAULT_SETTINGS, profile: PROFILE, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: null },
        renderCoverLetter: async () => '',
        screenshotsDir: dir,
        recordSubmitClick: (at) => {
          clicks.push(at)
          return allowClick
        }
      },
      job,
      app,
      'auto',
      by
    )
    const submits = page.isClosed() ? 0 : await page.evaluate(() => (window as unknown as { __submits?: number }).__submits ?? 0)
    return { result, clicks, submits }
  }

  it('submits a form whose every answer was on the draft, and records the click first', async () => {
    const { result, clicks, submits } = await run(formHtml(), DRAFT)
    expect(result.status).toBe('submitted')
    expect(submits).toBe(1)
    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('does not click when the application changed during the fill', async () => {
    const { result, clicks, submits } = await run(formHtml(), DRAFT, false)
    expect(result.status).toBe('needs_attention')
    expect(submits).toBe(0)
    expect(clicks).toHaveLength(1)
  })

  it('never sends a saved answer to an AI-use question', async () => {
    const extra = `<label for="ai">Did you use AI tools to write any part of this application?</label>
      <select id="ai" name="ai_use"><option value="">Select</option><option>Yes</option><option>No</option></select>`
    const draft = [...DRAFT, answer('ai_use', 'Did you use AI tools to write any part of this application?', 'No', { type: 'select', options: ['Yes', 'No'], source: 'answer_bank', confidence: 0.9 })]
    const { result, clicks, submits } = await run(formHtml(extra), draft)
    expect(result.status).toBe('needs_attention')
    expect(result.message).toMatch(/answer yourself/)
    expect(submits).toBe(0)
    expect(clicks).toEqual([])
  })

  it('sends it when the person presses Submit on the Review page', async () => {
    const extra = `<label for="ai">Did you use AI tools to write any part of this application?</label>
      <select id="ai" name="ai_use"><option value="">Select</option><option>Yes</option><option>No</option></select>`
    const draft = [...DRAFT, answer('ai_use', 'Did you use AI tools to write any part of this application?', 'Yes', { type: 'select', options: ['Yes', 'No'], source: 'user', confidence: 1 })]
    const { result, submits } = await run(formHtml(extra), draft, true, 'user')
    expect(result.status).toBe('submitted')
    expect(submits).toBe(1)
  })

  it('never sends answers nobody could review, even ones taken from the profile', async () => {
    const { result, clicks, submits } = await run(formHtml(), [])
    expect(result.status).toBe('needs_attention')
    expect(result.message).toMatch(/wasn't on the form you reviewed/)
    expect(submits).toBe(0)
    expect(clicks).toEqual([])
  })

  it('does not click an "Apply" button that submits a form while looking for the form', async () => {
    const html = `<!doctype html><html><body><p>About the job.</p>
      <form id="f"><label for="em">Email</label><input id="em" name="email"><button>Apply</button></form>${SUBMIT_SCRIPT}</body></html>`
    page = await browser.newPage()
    await page.setContent(html)
    await readForm(page, { clickApply: true })
    expect(await page.evaluate(() => (window as unknown as { __submits?: number }).__submits ?? 0)).toBe(0)
  })

  it('still follows an "Apply" link to reach the form', async () => {
    const html = `<!doctype html><html><body><p>About the job.</p><a href="#" id="go">Apply</a>
      <div id="slot"></div>
      <script>document.getElementById('go').addEventListener('click', (e) => { e.preventDefault();
        document.getElementById('slot').innerHTML = '<label for="a">First name</label><input id="a" name="a"><label for="b">Last name</label><input id="b" name="b"><label for="c">Email</label><input id="c" name="c">' })</script>
      </body></html>`
    page = await browser.newPage()
    await page.setContent(html)
    const { fields } = await readForm(page, { clickApply: true })
    expect(fields.map((f) => f.key)).toEqual(['a', 'b', 'c'])
  })

  it('reports which fields already hold a value', async () => {
    page = await browser.newPage()
    await page.setContent(formHtml())
    await page.fill('#fn', 'Sam')
    const { fields } = await readForm(page, { clickApply: false })
    expect(fields.find((f) => f.key === 'first_name')?.hasValue).toBe(true)
    expect(fields.find((f) => f.key === 'last_name')?.hasValue).toBe(false)
  })

  it('leaves a dropdown alone when several suggestions fit the answer', async () => {
    const html = `<!doctype html><html><body>
      <label for="g">Gender</label><input id="g" name="gender" role="combobox" aria-autocomplete="list">
      <ul id="list"></ul>
      <script>
        const box = document.getElementById('g'), list = document.getElementById('list')
        const all = ['Cisgender male', 'Transgender male', 'Female']
        box.addEventListener('input', () => {
          list.innerHTML = all.filter((o) => o.toLowerCase().includes(box.value.toLowerCase()))
            .map((o) => '<li role="option" onclick="document.getElementById(\\'g\\').value=this.textContent">' + o + '</li>').join('')
        })
      </script></body></html>`
    page = await browser.newPage()
    await page.setContent(html)
    const { fields, frame } = await readForm(page, { clickApply: false })
    await readComboboxOptions(frame, fields)
    const { matched } = matchAnswers(fields, [answer('gender', 'Gender', 'Male', { type: 'combobox', source: 'settings' })])
    const failures = await fillForm(page, frame, matched, { resume: null, coverLetter: null })
    expect(failures).toHaveLength(1)
    expect(await page.inputValue('#g')).not.toBe('Cisgender male')
  })
})
