import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Application, AutopilotSettings, Job, PreparedAnswer, Profile } from '@shared/types'
import type { LlmService } from '../llm/service'
import { readForm, type BrowserManager } from './browser'
import type { AnswerDeps } from './answers'
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-safety-'))

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

  async function run(html: string, draft: PreparedAnswer[], allowClick = true, by: 'user' | 'autopilot' = 'autopilot', autopilot: Partial<AutopilotSettings> = {}, boardUrl?: string, keepOpen = true, extraDeps: Partial<AnswerDeps> = {}) {
    const file = path.join(dir, `form-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
    fs.writeFileSync(file, html)
    page = await browser.newPage()
    // A job board address is served from memory, so no real site is opened.
    if (boardUrl) await page.route(`${boardUrl}**`, (route) => route.fulfill({ contentType: 'text/html', body: html }))
    const clicks: Array<string | null> = []
    const job = { id: 'job1', company: 'Acme', title: 'Engineer', location: null, description: 'Build things.', fit: null, source: 'greenhouse', url: boardUrl ?? pathToFileURL(file).href, applyUrl: boardUrl ?? pathToFileURL(file).href, ats: 'unknown' } as unknown as Job
    const app = { id: 'app1', jobId: 'job1', answers: draft, formFields: [], coverLetter: null } as unknown as Application
    const llm = { json: () => Promise.reject(new Error('No AI call expected')), text: () => Promise.reject(new Error('No AI call expected')) } as unknown as LlmService
    const result = await runSubmission(
      {
        browser: { newVisiblePage: async () => page } as unknown as BrowserManager,
        settings: { ...DEFAULT_SETTINGS, browser: { ...DEFAULT_SETTINGS.browser, keepOpen }, autopilot: { ...DEFAULT_SETTINGS.autopilot, ...autopilot } },
        answerDeps: { llm, settings: DEFAULT_SETTINGS, profile: PROFILE, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: null, ...extraDeps },
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

  const AI_FIELD = `<label for="ai">Did you use AI tools to write any part of this application?</label>
      <select id="ai" name="ai_use"><option value="">Select</option><option>Yes</option><option>No</option></select>`
  const savedAi = (patch: Partial<PreparedAnswer> = {}) => [
    ...DRAFT,
    answer('ai_use', 'Did you use AI tools to write any part of this application?', 'No', { type: 'select', options: ['Yes', 'No'], source: 'answer_bank', confidence: 0.9, ...patch })
  ]

  it('sends a saved answer to an AI-use question when Settings allows it', async () => {
    const { result, submits } = await run(formHtml(AI_FIELD), savedAi(), true, 'autopilot', { sendSavedUserAnswers: true })
    expect(result.status).toBe('submitted')
    expect(submits).toBe(1)
  })

  it('still refuses an AI-use answer that did not come from the person, even with that setting on', async () => {
    const { result, submits } = await run(formHtml(AI_FIELD), savedAi({ source: 'ai' }), true, 'autopilot', { sendSavedUserAnswers: true })
    expect(result.status).toBe('needs_attention')
    expect(submits).toBe(0)
  })

  it('does not hold back an optional consent box that was left unticked', async () => {
    const extra = '<label><input type="checkbox" name="consent"> I agree to the terms of service</label>'
    const draft = [...DRAFT, answer('consent', 'I agree to the terms of service', 'false', { type: 'checkbox', required: false, source: 'settings', confidence: 1 })]
    const { result, submits } = await run(formHtml(extra), draft)
    expect(result.status).toBe('submitted')
    expect(submits).toBe(1)
  })

  it('sends a required privacy box that Settings agreed to, only while the setting is on', async () => {
    const extra = '<label><input type="checkbox" name="privacy" required> I have read and agree to the privacy policy</label>'
    const draft = [
      ...DRAFT,
      answer('privacy', 'I have read and agree to the privacy policy', 'true', { type: 'checkbox', source: 'settings', confidence: 1, note: 'Agreed because Settings allows it.' })
    ]
    const on = await run(formHtml(extra), draft, true, 'autopilot', { tickRequiredConsent: true })
    expect(on.result.status).toBe('submitted')
    expect(on.submits).toBe(1)
    const off = await run(formHtml(extra), draft)
    expect(off.result.status).toBe('needs_attention')
    expect(off.submits).toBe(0)
  })

  it('does not click a form with only a Next button', async () => {
    const html = formHtml().replace('<button type="submit">Submit application</button>', '<button type="submit">Next</button>')
    const { result, clicks, submits } = await run(html, DRAFT)
    expect(result.status).toBe('needs_attention')
    expect(result.message).toBe('This form has more than one page. Use Fill and let me submit, then press Next and Submit in the browser.')
    expect(submits).toBe(0)
    expect(clicks).toEqual([])
  })

  it('does not click on a job board', async () => {
    const { result, clicks, submits } = await run(formHtml(), DRAFT, true, 'autopilot', {}, 'https://remotive.com/remote-jobs/acme/')
    expect(result.status).toBe('needs_attention')
    expect(result.message).toBe("This page is a job board, not the employer's form. Open the posting and apply on the company's site.")
    expect(submits).toBe(0)
    expect(clicks).toEqual([])
  })

  it('never sends answers nobody could review, even ones taken from the profile', async () => {
    const { result, clicks, submits } = await run(formHtml(), [])
    expect(result.status).toBe('needs_attention')
    expect(result.message).toMatch(/wasn't on the form you reviewed/)
    expect(submits).toBe(0)
    expect(clicks).toEqual([])
  })

  it('marks the answers it writes on the live form, so a run that finds them saved still treats them as unreviewed', async () => {
    const first = await run(formHtml(), [])
    expect(first.result.answers.length).toBeGreaterThan(0)
    expect(first.result.answers.every((a) => a.liveOnly === true)).toBe(true)
    expect(first.clicks).toEqual([])
    // The application keeps them as the first run left them, as ipc.ts does.
    const second = await run(formHtml(), first.result.answers)
    expect(second.result.status).toBe('needs_attention')
    expect(second.result.message).toMatch(/wasn't on the form you reviewed/)
    expect(second.clicks).toEqual([])
    expect(second.submits).toBe(0)
    // After a person saved the application, the same answers count as reviewed.
    const third = await run(formHtml(), first.result.answers.map(({ liveOnly: _liveOnly, ...a }) => a))
    expect(third.result.status).toBe('submitted')
    expect(third.submits).toBe(1)
  }, 40_000)

  it('works out "have you applied before" again at fill time', async () => {
    const question = 'Have you previously applied to Acme?'
    const extra = `<label for="prev">${question}</label><select id="prev" name="prev"><option value="">Select</option><option>Yes</option><option>No</option></select>`
    const stale = answer('prev', question, 'No', { type: 'select', options: ['Yes', 'No'], rule: 'previously_applied' })
    // The first application to Acme was sent after this draft was written.
    const { result, clicks } = await run(formHtml(extra), [...DRAFT, stale], false, 'autopilot', {}, undefined, true, { previouslyApplied: () => true })
    expect(result.answers.find((a) => a.fieldKey === 'prev')).toMatchObject({ value: 'Yes', rule: 'previously_applied' })
    expect(await page.inputValue('#prev')).toBe('Yes')
    expect(clicks).toHaveLength(1)
    // With nothing to tell it, the question is left for the person instead of keeping the old "No".
    const unknown = await run(formHtml(extra), [...DRAFT, stale], true, 'autopilot', {}, undefined, true)
    expect(unknown.result.status).toBe('needs_attention')
    expect(unknown.clicks).toEqual([])
  }, 40_000)

  describe('tabs of unattended runs', () => {
    const AI_QUESTION = 'Did you use AI tools to write any part of this application?'
    const aiDraft = [...DRAFT, answer('ai_use', AI_QUESTION, 'No', { type: 'select', options: ['Yes', 'No'], source: 'answer_bank', confidence: 0.9 })]

    it('closes the tab, saves a screenshot and stops watching when autopilot leaves a question for the user', async () => {
      const { result, clicks } = await run(formHtml(AI_FIELD), aiDraft, true, 'autopilot', {}, undefined, false)
      expect(result.status).toBe('needs_attention')
      expect(clicks).toEqual([])
      expect(result.completion).toBeNull()
      expect(page.isClosed()).toBe(true)
      expect(result.screenshotPath).not.toBeNull()
      expect(fs.existsSync(result.screenshotPath!)).toBe(true)
    })

    it('keeps the tab and the watcher when the user pressed Submit and a question is open', async () => {
      const { result } = await run(formHtml(), [], true, 'user', {}, undefined, false)
      expect(result.status).toBe('needs_attention')
      expect(result.completion).not.toBeNull()
      expect(page.isClosed()).toBe(false)
    })

    it('closes the tab on a job board, a multi-page form and a refused click', async () => {
      const board = await run(formHtml(), DRAFT, true, 'autopilot', {}, 'https://remotive.com/remote-jobs/acme/', false)
      expect(board.result.completion).toBeNull()
      expect(page.isClosed()).toBe(true)

      const next = formHtml().replace('<button type="submit">Submit application</button>', '<button type="submit">Next</button>')
      const multi = await run(next, DRAFT, true, 'autopilot', {}, undefined, false)
      expect(multi.result.completion).toBeNull()
      expect(page.isClosed()).toBe(true)

      const refused = await run(formHtml(), DRAFT, false, 'autopilot', {}, undefined, false)
      expect(refused.result.status).toBe('needs_attention')
      expect(refused.result.completion).toBeNull()
      expect(page.isClosed()).toBe(true)
    })

    it('closes the tab when the submit button is missing and takes the recorded click back', async () => {
      const html = formHtml().replace('<button type="submit">Submit application</button>', '<div>Contact us</div>')
      const { result, clicks, submits } = await run(html, DRAFT, true, 'autopilot', {}, undefined, false)
      expect(result.status).toBe('needs_attention')
      expect(result.completion).toBeNull()
      expect(page.isClosed()).toBe(true)
      expect(submits).toBe(0)
      // The attempt was recorded and then taken back, which leaves no click behind.
      expect(clicks.at(-1)).toBeNull()
    })

    it('closes the tab when no form fields are found', async () => {
      const { result } = await run('<!doctype html><html><body><p>This job has closed.</p></body></html>', DRAFT, true, 'autopilot', {}, undefined, false)
      expect(result.status).toBe('needs_attention')
      expect(result.completion).toBeNull()
      expect(page.isClosed()).toBe(true)
    })

    it('fills in a dry run, saves a screenshot, closes the tab and returns the application to the queue', async () => {
      const { result, clicks, submits } = await run(formHtml(), DRAFT, true, 'autopilot', { dryRun: true }, undefined, false)
      expect(result).toMatchObject({ ok: true, status: 'ready', dryRun: true, completion: null })
      expect(result.message).toMatch(/^Dry run: filled and not sent/)
      expect(fs.existsSync(result.screenshotPath!)).toBe(true)
      expect(clicks).toEqual([])
      expect(submits).toBe(0)
      expect(page.isClosed()).toBe(true)
    })

    it('does not call a dry run ready when it met a problem', async () => {
      const { result, clicks, submits } = await run(formHtml(), [], true, 'autopilot', { dryRun: true }, undefined, false)
      expect(result).toMatchObject({ ok: false, status: 'needs_attention', dryRun: true, completion: null })
      expect(result.message).toMatch(/^Dry run: filled and not sent. .*wasn't on the form you reviewed/)
      expect(clicks).toEqual([])
      expect(submits).toBe(0)
      expect(page.isClosed()).toBe(true)
    })

    it('keeps a user dry run open with its watcher', async () => {
      const { result } = await run(formHtml(), DRAFT, true, 'user', { dryRun: true }, undefined, false)
      expect(result.status).toBe('submitting')
      expect(result.dryRun).toBeUndefined()
      expect(result.completion).not.toBeNull()
      expect(page.isClosed()).toBe(false)
    })

    it('leaves the tab open for a person after a click that showed no confirmation', async () => {
      const html = formHtml().replace(
        "document.body.innerHTML = '<h1>Thank you for applying!</h1>'",
        "document.getElementById('fn').setAttribute('aria-invalid', 'true')"
      )
      const { result, clicks } = await run(html, DRAFT, true, 'autopilot', {}, undefined, false)
      expect(clicks).toHaveLength(1)
      expect(result.status).toBe('needs_attention')
      expect(result.completion).not.toBeNull()
      expect(page.isClosed()).toBe(false)
    }, 40_000)

    it('closes the tab after a confirmed submit unless the browser is kept open', async () => {
      const { result } = await run(formHtml(), DRAFT, true, 'autopilot', {}, undefined, false)
      expect(result.status).toBe('submitted')
      expect(page.isClosed()).toBe(true)
    })

    it('keeps the tab when Settings says to keep the browser open', async () => {
      const { result } = await run(formHtml(AI_FIELD), aiDraft, true, 'autopilot', {}, undefined, true)
      expect(result.completion).toBeNull()
      expect(page.isClosed()).toBe(false)
    })

    it('closes the tab and rethrows when the page fails to load', async () => {
      page = await browser.newPage()
      const job = { id: 'job1', company: 'Acme', title: 'Engineer', description: '', fit: null, source: 'greenhouse', url: 'http://127.0.0.1:1/nothing', applyUrl: 'http://127.0.0.1:1/nothing', ats: 'unknown' } as unknown as Job
      const app = { id: 'app1', jobId: 'job1', answers: DRAFT, formFields: [], coverLetter: null } as unknown as Application
      const llm = {} as unknown as LlmService
      await expect(
        runSubmission(
          {
            browser: { newVisiblePage: async () => page } as unknown as BrowserManager,
            settings: { ...DEFAULT_SETTINGS, browser: { ...DEFAULT_SETTINGS.browser, keepOpen: true } },
            answerDeps: { llm, settings: DEFAULT_SETTINGS, profile: PROFILE, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: null },
            renderCoverLetter: async () => '',
            screenshotsDir: dir,
            recordSubmitClick: () => true
          },
          job,
          app,
          'auto',
          'autopilot'
        )
      ).rejects.toThrow()
      expect(page.isClosed()).toBe(true)
    })
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
