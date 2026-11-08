import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { readForm } from './browser'
import { toFormField } from './fill'
import { cleanHint, greenhouseFields } from './greenhouseForm'

function findBrowser(): string | undefined {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ]
  return candidates.find((p) => fs.existsSync(p))
}

const executablePath = findBrowser()

const FORM = `<!doctype html><html><body><form>
  <div><label for="first">First name <span>*</span></label><input id="first" name="first_name" required></div>
  <div><label for="why">Why do you want to work here? ✱ In 100 words or less</label><textarea id="why" name="why" required></textarea></div>
  <div><label for="proud">Tell us about a project</label><textarea id="proud" name="proud" placeholder="Please keep it under 150 words and include a link"></textarea></div>
  <div><label for="best">Your best work</label><textarea id="best" name="best" aria-describedby="best-help"></textarea>
    <p id="best-help">Include a link to your portfolio.</p></div>
  <div><label for="err">Nickname</label><input id="err" name="err" aria-describedby="err-msg"><span id="err-msg" role="alert">This field is required</span></div>
  <div><label for="email">Email</label><input id="email" name="email" type="email" placeholder="you@example.com"></div>
  <div><label for="city">City</label><input id="city" name="city" placeholder="e.g. Berlin"></div>
  <div><label for="gen">Anything else?</label><textarea id="gen" name="gen" placeholder="Type your answer here"></textarea></div>
  <fieldset aria-describedby="rem-help"><legend>Can you work remotely?</legend>
    <label><input type="radio" name="remote" value="y"> Yes</label>
    <label><input type="radio" name="remote" value="n"> No</label></fieldset>
  <p id="rem-help">Answer in English.</p>
  <div><label for="stars">Describe a bug * Two or three sentences</label><textarea id="stars" name="stars"></textarea></div>
</form></body></html>`

describe.skipIf(!executablePath)('reading the form instruction from a page (headless browser)', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath, headless: true })
  })
  afterAll(async () => {
    await browser?.close()
  })

  async function read() {
    const page = await browser.newPage()
    await page.setContent(FORM)
    const { fields } = await readForm(page, { clickApply: false })
    await page.close()
    return Object.fromEntries(fields.map((f) => [f.key, f]))
  }

  it('reads the text after the required marker and keeps it out of the label', async () => {
    const f = await read()
    expect(f.why).toMatchObject({ label: 'Why do you want to work here?', required: true, hint: 'In 100 words or less' })
    expect(f.stars).toMatchObject({ label: 'Describe a bug', required: true, hint: 'Two or three sentences' })
    expect(f.first_name.hint).toBeNull()
    expect(f.first_name.label).toBe('First name')
  })

  it('reads a placeholder that reads as an instruction and skips examples and prompts', async () => {
    const f = await read()
    expect(f.proud.hint).toBe('Please keep it under 150 words and include a link')
    expect(f.email.hint).toBeNull()
    expect(f.city.hint).toBeNull()
    expect(f.gen.hint).toBeNull()
  })

  it('reads aria-describedby text but not an error message', async () => {
    const f = await read()
    expect(f.best.hint).toBe('Include a link to your portfolio.')
    expect(f.err.hint).toBeNull()
  })

  it('reads the description of a radio group', async () => {
    const f = await read()
    expect(f.remote.hint).toBe('Answer in English.')
  })

  it('carries the hint into the form field', async () => {
    const f = await read()
    expect(toFormField(f.why).hint).toBe('In 100 words or less')
    expect(toFormField(f.first_name).hint).toBeNull()
  })
})

describe('Greenhouse question descriptions', () => {
  it('cleans the HTML the API sends', () => {
    expect(cleanHint('<p>Please limit your answer to <strong>2-3 sentences</strong>.</p>')).toBe('Please limit your answer to 2-3 sentences.')
    expect(cleanHint('&lt;p&gt;Include a link to your portfolio&lt;/p&gt;')).toBe('Include a link to your portfolio')
    expect(cleanHint('Answer in English<br>Tom &amp; Jerry &#39;s')).toBe("Answer in English Tom & Jerry 's")
  })

  it('returns null for an empty description and caps a long one', () => {
    expect(cleanHint(null)).toBeNull()
    expect(cleanHint('<p>&nbsp;</p>')).toBeNull()
    const long = cleanHint('word '.repeat(200))
    expect(long?.length).toBeLessThanOrEqual(300)
    expect(long?.endsWith('…')).toBe(true)
  })

  it('puts the description on the field', () => {
    const fields = greenhouseFields({
      questions: [
        {
          label: 'Why do you want to join?',
          required: true,
          description: '<p>Please limit your answer to 2-3 sentences.</p>',
          fields: [{ name: 'question_1', type: 'textarea' }]
        },
        { label: 'First Name', required: true, description: null, fields: [{ name: 'first_name', type: 'input_text' }] }
      ]
    })
    expect(fields[0].hint).toBe('Please limit your answer to 2-3 sentences.')
    expect(fields[1].hint).toBeNull()
  })
})
