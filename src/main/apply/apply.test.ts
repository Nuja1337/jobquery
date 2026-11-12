import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { PreparedAnswer, Profile } from '@shared/types'
import { readForm } from './browser'
import { isCoverLetterField, isLongAnswer, mapKnownField, mustAskUser, pickOption } from './fieldMap'
import { fillForm, matchAnswers, readComboboxOptions, toFormField } from './fill'
import { needsCoverLetter } from './prepare'
import { captureBaseline, clickSubmit, waitForOutcome, waitForUserToFinish } from './submit'

// A form shaped like the ones Greenhouse, Lever and Ashby render: labels tied by "for", a label
// wrapping its input, a fieldset of radios, a hidden file input, a custom combobox, a consent box.
const FORM_HTML = `<!doctype html><html><body>
<form id="app" novalidate>
  <div class="field"><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
  <div class="field"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div class="field"><label>Phone<input name="phone" type="tel"></label></div>
  <div class="field"><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" style="display:none" required></div>
  <div class="field"><div class="label">LinkedIn Profile</div><input name="question_1" aria-label="LinkedIn Profile"></div>
  <div class="field"><label for="auth">Are you legally authorized to work in the United States? *</label>
    <select id="auth" name="question_2" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select></div>
  <fieldset><legend>Will you now or in the future require visa sponsorship? *</legend>
    <label><input type="radio" name="question_3" value="y"> Yes</label>
    <label><input type="radio" name="question_3" value="n"> No</label></fieldset>
  <div class="field"><label for="why">Why do you want to work at Acme? *</label><textarea id="why" name="question_4" maxlength="1500" required></textarea></div>
  <div class="field"><label id="gender_label">Gender</label>
    <input id="gender" role="combobox" aria-labelledby="gender_label" aria-autocomplete="list">
    <ul id="gender_list" role="listbox" style="display:none">
      <li role="option">Male</li><li role="option">Female</li><li role="option">Decline to self-identify</li></ul></div>
  <div class="field"><label><input type="checkbox" name="consent" required> I agree to the privacy policy</label></div>
  <button type="submit">Submit Application</button>
</form>
<div id="done" style="display:none">Thank you for applying to Acme.</div>
<script>
  const g = document.getElementById('gender'); const list = document.getElementById('gender_list');
  g.addEventListener('click', () => { list.style.display = 'block'; });
  g.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.style.display = 'none'; });
  list.querySelectorAll('[role=option]').forEach((o) => o.addEventListener('click', () => { g.value = o.textContent; list.style.display = 'none'; }));
  document.getElementById('app').addEventListener('submit', (e) => {
    e.preventDefault();
    const missing = [...document.querySelectorAll('[required]')].filter((el) => el.type === 'checkbox' ? !el.checked : el.type === 'file' ? el.files.length === 0 : !el.value);
    document.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    if (missing.length) { missing.forEach((el) => el.setAttribute('aria-invalid', 'true')); return; }
    document.getElementById('app').style.display = 'none';
    document.getElementById('done').style.display = 'block';
  });
</script></body></html>`

const PROFILE: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera Ortiz',
  email: 'sam@example.com',
  phone: '555-0100',
  links: { ...EMPTY_PROFILE.links, linkedin: 'https://linkedin.com/in/samrivera' },
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' }
}

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

describe.skipIf(!executablePath)('form extraction, filling and submit (headless browser)', () => {
  let browser: Browser
  let page: Page
  const resumePath = path.join(os.tmpdir(), 'jobquery-test-resume.pdf')

  beforeAll(async () => {
    fs.writeFileSync(resumePath, '%PDF-1.4 test')
    browser = await chromium.launch({ executablePath, headless: true })
    // Starting a browser can take a while on a busy machine.
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    fs.rmSync(resumePath, { force: true })
  })

  async function load(): Promise<Page> {
    page = await browser.newPage()
    await page.setContent(FORM_HTML)
    return page
  }

  it('reads labels, types, options and required flags', async () => {
    const p = await load()
    const { fields, frame } = await readForm(p, { clickApply: false })
    await readComboboxOptions(frame, fields)
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]))
    expect(byKey.first_name).toMatchObject({ label: 'First Name', type: 'text', required: true })
    expect(byKey.email.type).toBe('email')
    expect(byKey.phone.label).toBe('Phone')
    expect(byKey.resume).toMatchObject({ type: 'file', fileHint: 'resume' })
    expect(byKey.question_1.label).toBe('LinkedIn Profile')
    expect(byKey.question_2).toMatchObject({ type: 'select', options: ['Yes', 'No'] })
    expect(byKey.question_3).toMatchObject({ type: 'radio', options: ['Yes', 'No'], required: true, hasValue: false })
    expect(byKey.question_3.label).toMatch(/visa sponsorship/)
    expect(byKey.question_4).toMatchObject({ type: 'textarea', maxLength: 1500 })
    expect(byKey.gender).toMatchObject({ type: 'combobox', label: 'Gender' })
    expect(byKey.gender.options).toContain('Decline to self-identify')
    expect(byKey.consent).toMatchObject({ type: 'checkbox', label: 'I agree to the privacy policy' })
    await p.close()
  })

  it('maps known fields from the profile, fills the form and detects the confirmation', async () => {
    const p = await load()
    const { fields, frame } = await readForm(p, { clickApply: false })
    await readComboboxOptions(frame, fields)

    const answers: PreparedAnswer[] = fields.map((f) => {
      const field = toFormField(f)
      const mapped = mapKnownField(field, { profile: PROFILE, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse', jobLocation: 'New York, NY', company: 'Acme' })
      const value = isLongAnswer(field) ? 'I have shipped two payment systems and Acme is building a third.' : mapped?.value ?? ''
      return { fieldKey: f.key, label: f.label, type: field.type, required: f.required, options: f.options, value, source: mapped?.source ?? 'ai', confidence: 1, needsUser: mapped?.needsUser ?? false, note: null, lint: null }
    })
    const byKey = Object.fromEntries(answers.map((a) => [a.fieldKey, a]))
    expect(byKey.first_name.value).toBe('Sam')
    expect(byKey.last_name.value).toBe('Rivera Ortiz')
    expect(byKey.question_1.value).toContain('linkedin.com')
    expect(byKey.question_2.value).toBe('Yes')
    expect(byKey.question_3.value).toBe('No')
    expect(byKey.gender.value).toBe('Decline to self-identify')
    // Consent boxes are left for the person. Here the user ticks it in the review screen.
    expect(byKey.consent.needsUser).toBe(true)
    Object.assign(byKey.consent, { value: 'true', needsUser: false, source: 'user' })

    const { matched, unmatched } = matchAnswers(fields, answers)
    expect(unmatched).toHaveLength(0)
    const failures = await fillForm(p, frame, matched, { resume: resumePath, coverLetter: null })
    expect(failures).toEqual([])

    const values = await p.evaluate(() => ({
      first: (document.getElementById('first_name') as HTMLInputElement).value,
      auth: (document.getElementById('auth') as HTMLSelectElement).selectedOptions[0].text,
      sponsorNo: (document.querySelector('input[name=question_3][value=n]') as HTMLInputElement).checked,
      gender: (document.getElementById('gender') as HTMLInputElement).value,
      files: (document.getElementById('resume') as HTMLInputElement).files?.length
    }))
    expect(values).toEqual({ first: 'Sam', auth: 'Yes', sponsorNo: true, gender: 'Decline to self-identify', files: 1 })

    const baseline = await captureBaseline(p)
    expect(await clickSubmit(frame)).toBe(true)
    const outcome = await waitForOutcome(p, frame, baseline, 8000)
    expect(outcome.kind).toBe('confirmed')
    await p.close()
  }, 20_000)

  it('reports validation errors instead of claiming success', async () => {
    const p = await load()
    const { frame } = await readForm(p, { clickApply: false })
    const baseline = await captureBaseline(p)
    expect(await clickSubmit(frame)).toBe(true)
    const outcome = await waitForOutcome(p, frame, baseline, 8000)
    expect(outcome.kind).toBe('invalid')
    await p.close()
  }, 20_000)

  it('ignores thank-you text that was on the page before the click', async () => {
    page = await browser.newPage()
    await page.setContent(FORM_HTML.replace('<body>', '<body><div>Thank you for applying to Acme. Thanks for submitting your application early.</div>'))
    const { frame } = await readForm(page, { clickApply: false })
    const baseline = await captureBaseline(page)
    expect(await waitForUserToFinish(page, baseline, 2500)).toBe(false)
    expect(await clickSubmit(frame)).toBe(true)
    const outcome = await waitForOutcome(page, frame, baseline, 6000)
    expect(outcome.kind).toBe('invalid')
    await page.close()
  }, 20_000)
})

describe('field mapping', () => {
  it('picks options for yes, no and decline', () => {
    expect(pickOption(['Yes', 'No'], 'yes')).toBe('Yes')
    expect(pickOption(['Yes, I am', 'No, I am not'], 'no')).toBe('No, I am not')
    expect(pickOption(['Man', 'Woman', 'I don\'t wish to answer'], 'decline')).toBe('I don\'t wish to answer')
    expect(pickOption(['Red', 'Blue'], 'Green')).toBeNull()
  })

  it('never guesses salary or legal history', () => {
    const field = { key: 'q', label: 'What are your salary expectations?', type: 'text' as const, required: true, options: [], placeholder: null, maxLength: null, fileHint: null }
    const mapped = mapKnownField(field, { profile: PROFILE, settings: DEFAULT_SETTINGS, jobSource: 'lever', jobLocation: null, company: 'Acme' })
    expect(mapped?.needsUser).toBe(true)
    const legal = mapKnownField({ ...field, label: 'Have you ever been convicted of a felony?' }, { profile: PROFILE, settings: DEFAULT_SETTINGS, jobSource: 'lever', jobLocation: null, company: 'Acme' })
    expect(legal?.needsUser).toBe(true)
  })

  it('uses profile facts when the user gave one', () => {
    const profile = { ...PROFILE, facts: [{ question: 'Salary expectations', answer: '$150,000' }] }
    const field = { key: 'q', label: 'What are your salary expectations?', type: 'text' as const, required: true, options: [], placeholder: null, maxLength: null, fileHint: null }
    expect(mapKnownField(field, { profile, settings: DEFAULT_SETTINGS, jobSource: 'lever', jobLocation: null, company: 'Acme' })?.value).toBe('$150,000')
  })

  it('spots long answers and cover letter fields', () => {
    const base = { key: 'k', required: false, options: [], placeholder: null, maxLength: null, fileHint: null }
    expect(isLongAnswer({ ...base, label: 'Why do you want to join?', type: 'text' })).toBe(true)
    expect(isLongAnswer({ ...base, label: 'City', type: 'text' })).toBe(false)
    expect(isCoverLetterField({ ...base, label: 'Cover Letter', type: 'textarea' })).toBe(true)
  })
})

describe('questions only the person can answer', () => {
  const f = (label: string, type: 'text' | 'textarea' | 'checkbox' | 'select' = 'text') => ({ label, type })

  it('flags questions about AI use on the application', () => {
    for (const label of [
      'Did you use AI in preparing your application?',
      'Did you use generative AI to write your responses?',
      'Have you used an LLM to complete this application?',
      'AI Policy for Application',
      'Please disclose any use of ChatGPT or similar tools'
    ]) {
      expect(mustAskUser(f(label)), label).not.toBeNull()
    }
  })

  it('leaves ordinary AI skills questions to the writer', () => {
    for (const label of [
      'How would you apply AI to our product?',
      'Describe your experience building with LLMs',
      'Why do you want to work on Claude?',
      'What AI application are you most proud of building?',
      'Tell us about your experience applying AI to search'
    ]) {
      expect(mustAskUser(f(label, 'textarea')), label).toBeNull()
    }
  })

  it('flags legal terms, attestations and consent boxes', () => {
    expect(mustAskUser(f('I agree to the Terms of Service', 'checkbox'))).not.toBeNull()
    expect(mustAskUser(f('I have read and accept the Terms and Conditions', 'checkbox'))).not.toBeNull()
    expect(mustAskUser(f('I certify that the information above is true and complete', 'checkbox'))).not.toBeNull()
    expect(mustAskUser(f('Agreement to Arbitrate', 'select'))).not.toBeNull()
    expect(mustAskUser(f('First name'))).toBeNull()
    expect(mustAskUser(f('Cover letter (no AI-generated text)', 'textarea'))).not.toBeNull()
  })
})

describe('work authorization', () => {
  const field = (label: string) => ({ key: 'q', label, type: 'select' as const, required: true, options: ['Yes', 'No'], placeholder: null, maxLength: null, fileHint: null })
  const ctx = (jobLocation: string | null) => ({ profile: PROFILE, settings: DEFAULT_SETTINGS, jobSource: 'lever' as const, jobLocation, company: 'Acme' })

  it('answers from the country the question or job names', () => {
    expect(mapKnownField(field('Are you legally authorized to work in the United States?'), ctx(null))?.value).toBe('Yes')
    expect(mapKnownField(field('Are you legally authorized to work in the country of this job?'), ctx('São Paulo, Brazil'))?.value).toBe('No')
    expect(mapKnownField(field('Are you authorized to work for us?'), ctx('Austin, TX'))?.value).toBe('Yes')
  })

  it('asks the user when the country is unclear', () => {
    const mapped = mapKnownField(field('Are you authorized to work for us?'), ctx(null))
    expect(mapped?.needsUser).toBe(true)
  })
})

describe('when a cover letter is written', () => {
  const base = { key: 'k', placeholder: null, maxLength: null, options: [] }
  const letterUpload = (required: boolean) => ({ ...base, label: 'Cover Letter', type: 'file' as const, required, fileHint: 'cover_letter' as const })
  const letterBox = (required: boolean) => ({ ...base, label: 'Cover letter', type: 'textarea' as const, required, fileHint: null })
  const name = { ...base, label: 'Full name', type: 'text' as const, required: true, fileHint: null }

  it('writes one for a required cover letter upload or box', () => {
    expect(needsCoverLetter([name, letterUpload(true)], 'browser', DEFAULT_SETTINGS)).toBe(true)
    expect(needsCoverLetter([name, letterBox(true)], 'greenhouse_api', DEFAULT_SETTINGS)).toBe(true)
  })

  it('skips an optional cover letter field', () => {
    expect(needsCoverLetter([name, letterUpload(false)], 'browser', DEFAULT_SETTINGS)).toBe(false)
    expect(needsCoverLetter([name, letterBox(false)], 'greenhouse_api', DEFAULT_SETTINGS)).toBe(false)
    expect(needsCoverLetter([name], 'browser', DEFAULT_SETTINGS)).toBe(false)
  })

  it('writes one for an optional field when the setting says always', () => {
    const always = { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, alwaysCoverLetter: true } }
    expect(needsCoverLetter([name, letterUpload(false)], 'browser', always)).toBe(true)
    expect(needsCoverLetter([name], 'browser', always)).toBe(true)
  })

  it('writes none when the form could not be read ahead of time, since the live fill writes it if the form asks', () => {
    expect(needsCoverLetter([], 'none', DEFAULT_SETTINGS)).toBe(false)
  })

  it('still writes one for an unreadable form when a letter is always wanted', () => {
    expect(needsCoverLetter([], 'none', { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, alwaysCoverLetter: true } })).toBe(true)
  })
})
