import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { FormField, PreparedAnswer } from '@shared/types'
import { botCheckShown, hasVisibleCaptcha, readForm } from './browser'
import type { ExtractedField } from './extractScript'
import { chooseSuggestion, fillForm, readComboboxOptions, stripDialCode } from './fill'
import { applyUrlFor, chooseEmployerLink, greenhouseIds, looksLikeApplication } from './prepare'

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

function answerFor(field: ExtractedField, value: string): PreparedAnswer {
  return {
    fieldKey: field.key,
    label: field.label,
    type: field.type as PreparedAnswer['type'],
    required: field.required,
    options: field.options,
    value,
    source: 'profile',
    confidence: 1,
    needsUser: false,
    note: null,
    lint: null
  }
}

const NO_FILES = { resume: null, coverLetter: null }

// Shaped like Greenhouse's react-select dropdowns: a visible combobox input, plus a hidden
// required helper input next to it that has no id or name.
const HELPER_HTML = `<!doctype html><html><body><form>
  <div><label for="first">First Name *</label><input id="first" name="first_name" required></div>
  <div><label id="country_label">Country*</label>
    <div><input id="country" role="combobox" aria-labelledby="country_label" aria-autocomplete="list">
      <input aria-hidden="true" tabindex="-1" required style="opacity:0;position:absolute;width:100px;height:20px"></div></div>
  <div><label id="gender_label">Gender*</label>
    <div><input id="gender" role="combobox" aria-labelledby="gender_label" aria-autocomplete="list">
      <input aria-hidden="true" tabindex="-1" required style="opacity:0;position:absolute;width:100px;height:20px"></div></div>
  <div><label for="phone">Phone <svg width="10" height="10"><text>SVGs not supported by this browser.</text></svg></label><input id="phone" type="tel"></div>
  <div><label for="cv">Resume</label><input id="cv" type="file" aria-hidden="true" tabindex="-1" style="opacity:0;position:absolute"></div>
  <fieldset><legend>Remote?</legend>
    <label><input type="radio" name="remote" value="y" aria-hidden="true" tabindex="-1" style="opacity:0;position:absolute"> Yes</label>
    <label><input type="radio" name="remote" value="n" aria-hidden="true" tabindex="-1" style="opacity:0;position:absolute"> No</label></fieldset>
</form></body></html>`

// A dropdown whose list belongs to it by aria-controls, next to a hidden page-wide option list.
const LISTBOX_HTML = `<!doctype html><html><body>
<label id="pro_label">Pronouns</label>
<input id="pro" role="combobox" aria-labelledby="pro_label" aria-autocomplete="list">
<ul id="pro_list" role="listbox" style="display:none">
  <li role="option">he/him</li><li role="option">she/her</li><li role="option">they/them</li></ul>
<ul id="phone_countries" role="listbox" style="display:none">
  <li role="option">United States +1</li><li role="option">Canada +1</li><li role="option">Uruguay +598</li></ul>
<script>
  const box = document.getElementById('pro'); const list = document.getElementById('pro_list');
  // Like react-select, the attribute is only there while the menu is open.
  box.addEventListener('click', () => { box.setAttribute('aria-controls', 'pro_list'); list.style.display = 'block'; });
</script></body></html>`

// A location box that only searches on key events and answers late, like a geocoding service.
const GEO_HTML = `<!doctype html><html><body>
<label id="loc_label">Location (City)</label>
<input id="loc" role="combobox" aria-labelledby="loc_label" aria-autocomplete="list" aria-controls="loc_list">
<ul id="loc_list" role="listbox"></ul>
<script>
  const box = document.getElementById('loc'); const list = document.getElementById('loc_list');
  let timer = null;
  box.addEventListener('keyup', () => {
    clearTimeout(timer); list.innerHTML = '';
    const q = box.value.trim().toLowerCase();
    if (q !== 'san francisco') return;
    timer = setTimeout(() => {
      for (const t of ['San Francisco de Macorís, Duarte, Dominican Republic', 'San Francisco, Agusan del Sur, Philippines', 'San Francisco, California, United States']) {
        const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = t;
        li.addEventListener('click', () => { box.value = t; list.innerHTML = ''; });
        list.appendChild(li);
      }
    }, 600);
  });
</script></body></html>`

const DIAL_HTML = `<!doctype html><html><body>
<label id="c_label">Country</label>
<input id="c" role="combobox" aria-labelledby="c_label" aria-autocomplete="list" aria-controls="c_list">
<ul id="c_list" role="listbox" style="display:none">
  <li role="option">United States Minor Outlying Islands +1</li><li role="option">United States +1</li><li role="option">Uruguay +598</li></ul>
<script>
  const box = document.getElementById('c'); const list = document.getElementById('c_list');
  box.addEventListener('click', () => { list.style.display = 'block'; });
  list.querySelectorAll('[role=option]').forEach((o) => o.addEventListener('click', () => { box.value = o.textContent; list.style.display = 'none'; }));
</script></body></html>`

describe.skipIf(!executablePath)('reading and filling live-style forms (headless browser)', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath, headless: true })
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
  })

  async function load(html: string): Promise<Page> {
    const page = await browser.newPage()
    await page.setContent(html)
    return page
  }

  it('skips the hidden helper input but keeps the visible dropdown', async () => {
    const page = await load(HELPER_HTML)
    const { fields } = await readForm(page, { clickApply: false })
    const labels = fields.map((f) => f.label)
    expect(labels.filter((l) => l === 'Country')).toHaveLength(1)
    expect(labels.filter((l) => l === 'Gender')).toHaveLength(1)
    expect(fields.find((f) => f.label === 'Country')).toMatchObject({ type: 'combobox', required: true })
    // Hidden file inputs and custom-styled radios stay in.
    expect(fields.find((f) => f.type === 'file')).toBeTruthy()
    expect(fields.find((f) => f.type === 'radio')?.options).toEqual(['Yes', 'No'])
    expect(fields).toHaveLength(6)
    await page.close()
  })

  it('leaves SVG fallback text out of a label', async () => {
    const page = await load(HELPER_HTML)
    const { fields } = await readForm(page, { clickApply: false })
    expect(fields.find((f) => f.type === 'tel')?.label).toBe('Phone')
    await page.close()
  })

  it('reads Lever labels up to the required mark, without the upload status text', async () => {
    // Shaped like Lever's live markup: the title and "✱" in .application-label, helper text after it.
    const page = await load(`<!doctype html><html><body><form>
      <label><div class="application-label">Resume/CV <span class="required">✱</span></div>
        <div class="application-field"><a href="#"><span class="default-label">ATTACH RESUME/CV</span><input type="file" name="resume" tabindex="-1"></a>
        <span><div class="resume-upload-label">Couldn't auto-read resume.</div></span></div></label>
      <label><div class="application-label">Current location <span class="required">✱</span></div>
        <div class="application-field"><input type="text" name="location"><div class="dropdown-no-results">No location found. Try entering a different location</div></div></label>
    </form></body></html>`)
    const { fields } = await readForm(page, { clickApply: false })
    expect(fields.map((f) => [f.label, f.required])).toEqual([
      ['Resume/CV', true],
      ['Current location', true]
    ])
    await page.close()
  })

  it("takes a radio group's question from its title, not from its first option", async () => {
    // Shaped like Ashby's live markup: question and options are all <label> elements in a fieldset.
    const page = await load(`<!doctype html><html><body><form>
      <fieldset class="ashby-application-form-input-radio-group">
        <label class="_label ashby-application-form-question-title" for="g">Gender</label>
        <div class="_description"><p>Input gender</p></div>
        <div class="_option"><span><input type="radio" id="g0" name="g"></span><label class="_label" for="g0">Male</label></div>
        <div class="_option"><span><input type="radio" id="g1" name="g"></span><label class="_label" for="g1">Female</label></div>
        <div class="_option"><span><input type="radio" id="g2" name="g"></span><label class="_label" for="g2">Decline to self-identify</label></div>
      </fieldset>
    </form></body></html>`)
    const { fields } = await readForm(page, { clickApply: false })
    expect(fields[0]).toMatchObject({ label: 'Gender', type: 'radio', options: ['Male', 'Female', 'Decline to self-identify'] })
    await page.close()
  })

  it('keeps a select2-style select that is hidden from assistive tech', async () => {
    const page = await load(`<!doctype html><html><body><form>
      <label for="loc">Office *</label>
      <select id="loc" name="office" aria-hidden="true" tabindex="-1" required style="position:absolute;width:1px;height:1px;opacity:0">
        <option value="">Select</option><option value="ny">New York</option><option value="sf">San Francisco</option></select>
      <span class="select2">Select</span>
    </form></body></html>`)
    const { fields } = await readForm(page, { clickApply: false })
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ label: 'Office', type: 'select', options: ['New York', 'San Francisco'] })
    const failures = await fillForm(page, page.mainFrame(), [{ field: fields[0], answer: answerFor(fields[0], 'San Francisco') }], NO_FILES)
    expect(failures).toEqual([])
    expect(await page.inputValue('#loc')).toBe('sf')
    await page.close()
  }, 20_000)

  it('unticks a box that was ticked ahead of time, and fails when it will not untick', async () => {
    const page = await load(`<!doctype html><html><body><form>
      <label><input type="checkbox" id="free" checked> I agree to the arbitration agreement</label>
      <label><input type="checkbox" id="stuck" checked> I agree to the non-compete</label>
      <label><input type="checkbox" id="plain"> Keep me posted</label>
      <script>document.getElementById('stuck').addEventListener('change', (e) => { e.target.checked = true })</script>
    </form></body></html>`)
    const { fields } = await readForm(page, { clickApply: false })
    const by = (id: string) => fields.find((f) => f.label.includes(id))!
    const unticked = (field: ExtractedField) => answerFor(field, 'false')
    const free = await fillForm(page, page.mainFrame(), [{ field: by('arbitration'), answer: unticked(by('arbitration')) }, { field: by('Keep'), answer: unticked(by('Keep')) }], NO_FILES)
    expect(free).toEqual([])
    expect(await page.isChecked('#free')).toBe(false)
    expect(await page.isChecked('#plain')).toBe(false)
    const stuck = await fillForm(page, page.mainFrame(), [{ field: by('non-compete'), answer: unticked(by('non-compete')) }], NO_FILES)
    expect(stuck).toEqual([{ label: expect.stringContaining('non-compete'), reason: "Couldn't untick this box" }])
    await page.close()
  }, 20_000)

  it('reads a dropdown from its own list and ignores a hidden page-wide one', async () => {
    const page = await load(LISTBOX_HTML)
    const { frame, fields } = await readForm(page, { clickApply: false })
    await readComboboxOptions(frame, fields)
    expect(fields[0].options).toEqual(['he/him', 'she/her', 'they/them'])
    await page.close()
  })

  it('types into a search box and waits for late suggestions', async () => {
    const page = await load(GEO_HTML)
    const { frame, fields } = await readForm(page, { clickApply: false })
    const failures = await fillForm(page, frame, [{ field: fields[0], answer: answerFor(fields[0], 'San Francisco, CA') }], NO_FILES)
    expect(failures).toEqual([])
    expect(await page.inputValue('#loc')).toBe('San Francisco, California, United States')
    await page.close()
  }, 20_000)

  it('picks "United States +1" for "United States"', async () => {
    const page = await load(DIAL_HTML)
    const { frame, fields } = await readForm(page, { clickApply: false })
    const failures = await fillForm(page, frame, [{ field: fields[0], answer: answerFor(fields[0], 'United States') }], NO_FILES)
    expect(failures).toEqual([])
    expect(await page.inputValue('#c')).toBe('United States +1')
    await page.close()
  }, 20_000)

  it('skips an optional upload with nothing to upload, and fails a required one', async () => {
    const html = `<!doctype html><html><body><form>
      <label for="a">Portfolio</label><input id="a" type="file" style="display:none">
      <label for="b">Transcript *</label><input id="b" type="file" required style="display:none">
    </form></body></html>`
    const page = await load(html)
    const { frame, fields } = await readForm(page, { clickApply: false })
    const optional = fields.find((f) => f.label === 'Portfolio')!
    const required = fields.find((f) => f.label === 'Transcript')!
    expect(optional).toMatchObject({ fileHint: 'other', required: false })
    const failures = await fillForm(
      page,
      frame,
      [
        { field: optional, answer: answerFor(optional, '') },
        { field: required, answer: answerFor(required, '') }
      ],
      NO_FILES
    )
    expect(failures).toEqual([{ label: 'Transcript', reason: 'No file to upload' }])
    await page.close()
  })

  it('does not take a DataDome challenge frame for the form', async () => {
    const page = await browser.newPage()
    await page.route('https://geo.captcha-delivery.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html><body><input name="a"><input name="b"><input name="c"></body></html>' })
    )
    await page.setContent(
      '<html><body><input name="email" aria-label="Email"><iframe src="https://geo.captcha-delivery.com/captcha/?x=1" width="300" height="300"></iframe></body></html>'
    )
    await page.waitForTimeout(500)
    const { fields } = await readForm(page, { clickApply: false })
    expect(fields.map((f) => f.key)).toEqual(['email'])
    expect(await botCheckShown(page)).toBe(true)
    expect(await hasVisibleCaptcha(page)).toBe(true)
    await page.close()
  })

  it('spots a PerimeterX challenge and stays quiet on a plain page', async () => {
    const plain = await load('<html><body><input name="x"></body></html>')
    expect(await botCheckShown(plain)).toBe(false)
    expect(await hasVisibleCaptcha(plain)).toBe(false)
    await plain.close()
    const px = await load('<html><body><div id="px-captcha"></div></body></html>')
    expect(await botCheckShown(px)).toBe(true)
    expect(await hasVisibleCaptcha(px)).toBe(true)
    await px.close()
  })
})

describe('choosing a suggestion', () => {
  it('strips a trailing dial code', () => {
    expect(stripDialCode('United States +1')).toBe('United States')
    expect(stripDialCode('Antigua and Barbuda (+1-268)')).toBe('Antigua and Barbuda')
    expect(stripDialCode('San Francisco')).toBe('San Francisco')
  })

  it('matches a country without its dial code', () => {
    const list = ['United States Minor Outlying Islands +1', 'United States +1', 'Uruguay +598']
    expect(chooseSuggestion(list, 'United States', false)).toBe('United States +1')
    expect(chooseSuggestion(list, 'United States +1', false)).toBe('United States +1')
  })

  it('prefers the wanted country, then the wanted region, among cities with the same name', () => {
    const list = [
      'San Francisco de Macorís, Duarte, Dominican Republic',
      'San Francisco, Agusan del Sur, Philippines',
      'San Francisco, California, United States'
    ]
    expect(chooseSuggestion(list, 'San Francisco, CA', true)).toBe('San Francisco, California, United States')
    const portlands = ['Portland, Maine, United States', 'Portland, Oregon, United States']
    expect(chooseSuggestion(portlands, 'Portland, OR', true)).toBe('Portland, Oregon, United States')
    expect(chooseSuggestion(['Springfield, Ohio, United States', 'Springfield, Illinois, United States'], 'Springfield', true)).toBe(
      'Springfield, Ohio, United States'
    )
  })

  it('returns null when nothing fits', () => {
    expect(chooseSuggestion(['Male', 'Female'], 'Robot', false)).toBeNull()
    expect(chooseSuggestion(['Boston, Massachusetts, United States'], 'Austin, TX', true)).toBeNull()
  })
})

describe('applyUrlFor and greenhouseIds', () => {
  const base = { applyUrl: null, ats: 'unknown' as const, source: 'greenhouse' as const }

  it('opens the embedded Greenhouse form for a hosted posting', () => {
    const job = { source: 'greenhouse' as const, url: 'https://job-boards.greenhouse.io/stripe/jobs/8172510', applyUrl: 'https://job-boards.greenhouse.io/stripe/jobs/8172510', ats: 'greenhouse' as const }
    expect(applyUrlFor(job)).toBe('https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8172510')
    expect(greenhouseIds(job)).toEqual({ token: 'stripe', id: '8172510' })
  })

  it('uses the embed address even when applyUrl points elsewhere', () => {
    const job = { source: 'greenhouse' as const, url: 'https://boards.greenhouse.io/figma/jobs/55', applyUrl: 'https://figma.com/careers/apply', ats: 'greenhouse' as const }
    expect(applyUrlFor(job)).toBe('https://job-boards.greenhouse.io/embed/job_app?for=figma&token=55')
  })

  it('keeps the EU host for EU boards', () => {
    const job = { source: 'greenhouse' as const, url: 'https://job-boards.eu.greenhouse.io/acme/jobs/9', applyUrl: null, ats: 'greenhouse' as const }
    expect(applyUrlFor(job)).toBe('https://job-boards.eu.greenhouse.io/embed/job_app?for=acme&token=9')
  })

  it('reads gh_jid from a company site, with the token from the job', () => {
    const job = { source: 'greenhouse' as const, url: 'https://stripe.com/jobs/search?gh_jid=8172510', applyUrl: null, ats: 'greenhouse' as const, atsToken: 'stripe', externalId: 'x' }
    expect(greenhouseIds(job)).toEqual({ token: 'stripe', id: '8172510' })
    expect(applyUrlFor(job)).toBe('https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8172510')
  })

  it('falls back to the stored token and id for a Greenhouse job', () => {
    const job = { source: 'greenhouse' as const, url: 'https://careers.example.com/role', applyUrl: null, ats: 'greenhouse' as const, atsToken: 'example', externalId: '123' }
    expect(greenhouseIds(job)).toEqual({ token: 'example', id: '123' })
    expect(greenhouseIds({ ...job, ats: 'unknown' })).toBeNull()
    expect(greenhouseIds({ ...job, externalId: 'abc' })).toBeNull()
    // A job-board posting resolved to a Greenhouse board has the board's own id, not the Greenhouse job id.
    expect(greenhouseIds({ ...job, source: 'remotive' })).toBeNull()
  })

  it('adds /apply to Lever postings, including the EU host', () => {
    expect(applyUrlFor({ ...base, ats: 'lever', url: 'https://jobs.lever.co/spotify/abc?lever-source=x' })).toBe('https://jobs.lever.co/spotify/abc/apply')
    expect(applyUrlFor({ ...base, ats: 'lever', url: 'https://jobs.eu.lever.co/acme/abc' })).toBe('https://jobs.eu.lever.co/acme/abc/apply')
    expect(applyUrlFor({ ...base, ats: 'lever', url: 'https://jobs.eu.lever.co/acme/abc/apply' })).toBe('https://jobs.eu.lever.co/acme/abc/apply')
  })

  it('keeps the Ashby and plain rules', () => {
    expect(applyUrlFor({ ...base, ats: 'ashby', url: 'https://jobs.ashbyhq.com/ramp/abc' })).toBe('https://jobs.ashbyhq.com/ramp/abc/application')
    expect(applyUrlFor({ ...base, url: 'https://example.com/jobs/1' })).toBe('https://example.com/jobs/1')
    expect(applyUrlFor({ ...base, url: 'https://example.com/jobs/1', applyUrl: 'https://example.com/apply/1' })).toBe('https://example.com/apply/1')
  })
})

describe('chooseEmployerLink', () => {
  it('takes the first apply link that leaves the job board', () => {
    const links = [
      { text: 'Apply for this position', href: 'https://remotive.com/remote-jobs/software-dev/abc' },
      { text: 'Apply for this position', href: 'mailto:jobs@example.com' },
      { text: 'Post a job', href: 'https://example.com/post' },
      { text: 'Apply for this position', href: 'https://jobs.ashbyhq.com/lemon-io/4dc7dd66-0000' },
      { text: 'Apply now', href: 'https://example.com/careers/1' }
    ]
    expect(chooseEmployerLink(links, 'Lemon.io')).toBe('https://jobs.ashbyhq.com/lemon-io/4dc7dd66-0000')
  })

  it("prefers an application system link only when its board is the job's company", () => {
    const links = [
      { text: 'Apply now', href: 'https://example.com/careers/1' },
      { text: 'Apply for this position', href: 'https://jobs.lever.co/acme/abc' }
    ]
    expect(chooseEmployerLink(links, 'Acme, Inc.')).toBe('https://jobs.lever.co/acme/abc')
    expect(chooseEmployerLink(links.slice(0, 1), 'Acme')).toBe('https://example.com/careers/1')
  })

  it("does not pick another company's board over the page's own link", () => {
    const links = [
      { text: 'Apply for this position', href: 'https://acme.com/careers/123' },
      { text: 'Apply', href: 'https://boards.greenhouse.io/othercorp/jobs/999' }
    ]
    expect(chooseEmployerLink(links, 'Acme')).toBe('https://acme.com/careers/123')
    expect(chooseEmployerLink(links, '')).toBe('https://acme.com/careers/123')
  })

  it('takes a lone application system link even when it is not the same name', () => {
    expect(chooseEmployerLink([{ text: 'Apply', href: 'https://boards.greenhouse.io/othercorp/jobs/999' }], 'Acme')).toBe('https://boards.greenhouse.io/othercorp/jobs/999')
  })

  it('accepts a hidden link only when exactly one address qualifies', () => {
    const one = { text: 'Apply', href: 'https://example.com/go' }
    expect(chooseEmployerLink([one, { ...one }], 'Acme', { onlyIfSingle: true })).toBe('https://example.com/go')
    expect(chooseEmployerLink([one, { text: 'Apply', href: 'https://example.com/other' }], 'Acme', { onlyIfSingle: true })).toBeNull()
    expect(chooseEmployerLink([], 'Acme', { onlyIfSingle: true })).toBeNull()
  })

  it('needs the word "apply" in the link text', () => {
    expect(chooseEmployerLink([{ text: 'Tips for applying', href: 'https://example.com/tips' }, { text: 'Application status', href: 'https://example.com/status' }], 'Acme')).toBeNull()
    expect(chooseEmployerLink([{ text: 'Tips for applying', href: 'https://example.com/tips' }, { text: 'Apply', href: 'https://example.com/go' }], 'Acme')).toBe('https://example.com/go')
  })

  it('returns null when every apply link stays on a board', () => {
    expect(chooseEmployerLink([{ text: 'Apply', href: 'https://remoteok.com/l/1' }, { text: 'Apply', href: 'not a url' }], 'Acme')).toBeNull()
    expect(chooseEmployerLink([], 'Acme')).toBeNull()
  })
})

describe('looksLikeApplication', () => {
  const f = (label: string, type: FormField['type'] = 'text'): FormField => ({ key: label, label, type, required: false, options: [], placeholder: null, maxLength: null, fileHint: null })
  it('accepts forms with an upload, or an email box among four or more fields', () => {
    expect(looksLikeApplication([f('Resume', 'file')])).toBe(true)
    expect(looksLikeApplication([f('Name'), f('Email', 'email'), f('Phone', 'tel'), f('LinkedIn')])).toBe(true)
  })
  it('rejects a newsletter signup or a site search', () => {
    expect(looksLikeApplication([f('Email address', 'email')])).toBe(false)
    expect(looksLikeApplication([f('Search jobs'), f('Location')])).toBe(false)
    expect(looksLikeApplication([f('First name'), f('Email'), f('Company')])).toBe(false)
  })
})
