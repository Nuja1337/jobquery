import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Application, Job, PreparedAnswer } from '@shared/types'
import type { LlmService } from '../llm/service'
import type { BrowserManager } from './browser'
import type { AnswerDeps } from './answers'
import { runSubmission } from './submitRun'

// A question only the person can answer, revealed by an earlier answer, must show up in the problems of the run.

const executablePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => fs.existsSync(p))

const AI_Q = 'Did you use AI tools to write any part of this application?'
const HTML = `<!doctype html><html><body>
<form id="f" novalidate>
  <label for="fn">First name *</label><input id="fn" name="first_name" required>
  <label for="hear">How did you hear about us?</label>
  <select id="hear" name="hear"><option value="">Select</option><option>LinkedIn</option><option>Other</option></select>
  <div id="more" style="display:none"><label for="ai">${AI_Q}</label><select id="ai" name="ai_use"><option value="">Select</option><option>Yes</option><option>No</option></select></div>
  <button type="submit">Submit application</button>
</form>
<script>
  document.getElementById('hear').addEventListener('change', (e) => { document.getElementById('more').style.display = e.target.value === 'Other' ? 'block' : 'none' })
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); document.body.innerHTML = '<h1>Thank you for applying!</h1>' })
</script></body></html>`

const answer = (fieldKey: string, label: string, value: string, patch: Partial<PreparedAnswer> = {}): PreparedAnswer => ({
  fieldKey, label, type: 'text', required: true, options: [], value, source: 'profile', confidence: 0.98, needsUser: false, note: null, lint: null, ...patch
})

describe.skipIf(!executablePath)('user-only questions revealed on a later pass', () => {
  let browser: Browser
  let page: Page
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquery-reveal-'))
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath, headless: true })
  }, 30_000)
  afterEach(async () => {
    await page?.close().catch(() => {})
  })
  afterAll(async () => {
    await browser?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('names the revealed question in the problems and does not click', async () => {
    const file = path.join(dir, 'form.html')
    fs.writeFileSync(file, HTML)
    page = await browser.newPage()
    const clicks: Array<string | null> = []
    const url = pathToFileURL(file).href
    const job = { id: 'job1', company: 'Acme', title: 'Engineer', location: null, description: 'x', fit: null, source: 'greenhouse', url, applyUrl: url, ats: 'unknown' } as unknown as Job
    const draft = [
      answer('first_name', 'First name', 'Sam'),
      answer('hear', 'How did you hear about us?', 'Other', { type: 'select', options: ['LinkedIn', 'Other'] })
    ]
    const app = { id: 'app1', jobId: 'job1', answers: draft, formFields: [], coverLetter: null } as unknown as Application
    const llm = { json: async () => ({ value: { answers: [] }, costUsd: 0 }), text: () => Promise.reject(new Error('No AI call expected')) } as unknown as LlmService
    const saved = { id: 's1', answer: 'No', kind: 'fact' as const, topic: null }
    const answerDeps: AnswerDeps = {
      llm, settings: DEFAULT_SETTINGS, profile: { ...EMPTY_PROFILE, fullName: 'Sam Rivera' }, samples: [],
      findSavedAnswer: (q) => (/\bAI\b/.test(q) ? saved : null), markAnswerUsed: () => {}, resumePath: null
    }
    const result = await runSubmission(
      {
        browser: { newVisiblePage: async () => page } as unknown as BrowserManager,
        settings: { ...DEFAULT_SETTINGS, autopilot: { ...DEFAULT_SETTINGS.autopilot, sendSavedUserAnswers: false } },
        answerDeps,
        renderCoverLetter: async () => '',
        screenshotsDir: dir,
        recordSubmitClick: (at) => {
          clicks.push(at)
          return true
        }
      },
      job,
      app,
      'auto',
      'autopilot'
    )
    expect(result.status).toBe('needs_attention')
    expect(result.message).toContain(`"${AI_Q}" is a question you answer yourself`)
    expect(clicks).toEqual([])
  }, 40_000)
})
