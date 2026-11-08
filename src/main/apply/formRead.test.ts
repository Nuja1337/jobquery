import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { FormField, PreparedAnswer } from '@shared/types'
import { botCheckShown, hasVisibleCaptcha, readForm } from './browser'
import type { ExtractedField } from './extractScript'
import { acceptsFile, chooseSuggestion, fillForm, readComboboxOptions, resumeFileName, stripDialCode, type FillFiles } from './fill'
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

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`./__fixtures__/forms/${name}`, import.meta.url)), 'utf8')

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

  describe('Ashby yes/no questions', () => {
    const pressed = (page: Page) => page.$$eval('button[data-option]', (bs) => bs.map((b) => b.getAttribute('aria-pressed')))

    it('reads each question as a required-aware Yes/No radio, without the hidden checkbox', async () => {
      const page = await load(fixture('ashby-yesno.html'))
      const { fields } = await readForm(page, { clickApply: false })
      expect(fields.map((f) => ({ label: f.label, type: f.type, required: f.required, options: f.options }))).toEqual([
        { label: 'Do you have at least 2 years of mobile engineering experience?', type: 'radio', required: true, options: ['Yes', 'No'] },
        { label: 'Will you now or in the future require visa sponsorship?', type: 'radio', required: true, options: ['Yes', 'No'] },
        { label: 'Were you referred by a current employee?', type: 'radio', required: false, options: ['Yes', 'No'] }
      ])
      expect(fields.every((f) => f.optionIds.length === 2 && !f.hasValue)).toBe(true)
      await page.close()
    })

    it('presses Yes and No and confirms aria-pressed', async () => {
      const page = await load(fixture('ashby-yesno.html'))
      const { frame, fields } = await readForm(page, { clickApply: false })
      const failures = await fillForm(
        page,
        frame,
        [
          { field: fields[0], answer: answerFor(fields[0], 'Yes') },
          { field: fields[1], answer: answerFor(fields[1], 'No') },
          { field: fields[2], answer: answerFor(fields[2], 'false') }
        ],
        NO_FILES
      )
      expect(failures).toEqual([])
      expect(await pressed(page)).toEqual(['true', 'false', 'false', 'true', 'false', 'true'])
      // A second pass leaves a pressed button alone.
      expect(await fillForm(page, frame, [{ field: fields[0], answer: answerFor(fields[0], 'Yes') }], NO_FILES)).toEqual([])
      expect((await pressed(page))[0]).toBe('true')
      await page.close()
    }, 20_000)

    it('fails when the button does not stay pressed', async () => {
      const page = await load(fixture('ashby-yesno.html'))
      const { frame, fields } = await readForm(page, { clickApply: false })
      // Replacing the buttons with copies drops the page's click handlers.
      await page.evaluate(() => document.querySelectorAll('button[data-option]').forEach((b) => b.replaceWith(b.cloneNode(true))))
      const failures = await fillForm(page, frame, [{ field: fields[0], answer: answerFor(fields[0], 'Yes') }], NO_FILES)
      expect(failures).toHaveLength(1)
      expect(failures[0].label).toContain('mobile engineering')
      await page.close()
    }, 20_000)
  })

  describe('Lever application form', () => {
    it('reads the location box as a combobox and skips the hidden survey groups', async () => {
      const page = await load(fixture('lever-location.html'))
      const { fields } = await readForm(page, { clickApply: false })
      expect(fields.find((f) => f.label === 'Current location')).toMatchObject({ type: 'combobox', required: true })
      // Seven radio groups sit in sections that display:none hides. None is a question.
      expect(await page.$$eval('.hidden input[type="radio"]', (els) => new Set(els.map((e) => (e as HTMLInputElement).name)).size)).toBe(7)
      expect(fields.filter((f) => f.type === 'radio' || f.type === 'checkboxes')).toEqual([])
      expect(fields.map((f) => f.label)).toEqual([
        'Full name', 'Email', 'Phone', 'Current location', 'Resume/CV', 'GitHub URL', 'What is your location?', 'Keep my details for future roles'
      ])
      await page.close()
    })

    it('keeps the picked location and fills the hidden selected location', async () => {
      const page = await load(fixture('lever-location.html'))
      const { frame, fields } = await readForm(page, { clickApply: false })
      await readComboboxOptions(frame, fields)
      const location = fields.find((f) => f.label === 'Current location')!
      const failures = await fillForm(page, frame, [{ field: location, answer: answerFor(location, 'Seattle, WA, USA') }], NO_FILES)
      expect(failures).toEqual([])
      expect(await page.inputValue('#location-input')).toBe('Seattle, WA, USA')
      expect(await page.inputValue('#selected-location')).toContain('Seattle, WA, USA')
      await page.close()
    }, 20_000)

    it('picks by city when the full address finds nothing', async () => {
      const page = await load(fixture('lever-location.html'))
      const { frame, fields } = await readForm(page, { clickApply: false })
      const location = fields.find((f) => f.label === 'Current location')!
      const failures = await fillForm(page, frame, [{ field: location, answer: answerFor(location, 'Seattle, Washington, United States') }], NO_FILES)
      expect(failures).toEqual([])
      expect(await page.inputValue('#location-input')).toBe('Seattle, WA, USA')
      await page.close()
    }, 20_000)

    it('fails when the location box clears itself because nothing was picked', async () => {
      const page = await load(fixture('lever-location.html'))
      const { frame, fields } = await readForm(page, { clickApply: false })
      const location = fields.find((f) => f.label === 'Current location')!
      const failures = await fillForm(page, frame, [{ field: location, answer: answerFor(location, 'Nowhere, ZZ') }], NO_FILES)
      expect(failures).toHaveLength(1)
      expect(failures[0]).toEqual({ label: 'Current location', reason: 'The box cleared "Nowhere, ZZ" when it lost focus' })
      expect(await page.inputValue('#selected-location')).toBe('')
      await page.close()
    }, 20_000)
  })

  describe('reading every field back after filling', () => {
    const run = async (page: Page, field: ExtractedField, value: string, files: FillFiles = NO_FILES) =>
      fillForm(page, page.mainFrame(), [{ field, answer: answerFor(field, value) }], files)

    it('fails a value that maxlength cut, and one the page wiped or changed', async () => {
      const page = await load(`<!doctype html><html><body><form>
        <label for="a">Short answer</label><input id="a" name="a" maxlength="10">
        <label for="b">Wiped</label><input id="b" name="b">
        <label for="c">Changed</label><input id="c" name="c">
        <label for="d">Phone</label><input id="d" name="d" type="tel">
        <script>
          document.getElementById('b').addEventListener('input', (e) => { e.target.value = '' });
          document.getElementById('c').addEventListener('input', (e) => { e.target.value = 'something else' });
          document.getElementById('d').addEventListener('input', (e) => {
            const n = e.target.value.replace(/\\D/g, '');
            e.target.value = n.length === 10 ? '(' + n.slice(0, 3) + ') ' + n.slice(3, 6) + '-' + n.slice(6) : n;
          });
        </script></form></body></html>`)
      const { fields } = await readForm(page, { clickApply: false })
      const by = (label: string) => fields.find((f) => f.label === label)!
      expect(await run(page, by('Short answer'), 'x'.repeat(30))).toEqual([
        { label: 'Short answer', reason: 'The box kept 10 of 30 characters (limit 10)' }
      ])
      expect(await run(page, by('Wiped'), 'hello')).toEqual([{ label: 'Wiped', reason: 'The box is empty after filling it' }])
      expect(await run(page, by('Changed'), 'hello')).toEqual([{ label: 'Changed', reason: 'The box shows "something else" instead of "hello"' }])
      expect(await run(page, by('Short answer'), 'fits fine')).toEqual([])
      // A phone mask only changes the formatting.
      expect(await run(page, by('Phone'), '5551234567')).toEqual([])
      expect(await page.inputValue('#d')).toBe('(555) 123-4567')
      await page.close()
    }, 30_000)

    it('fails a select that shows another label', async () => {
      const page = await load(`<!doctype html><html><body><form>
        <label for="s">State</label>
        <select id="s"><option value="">Select</option><option>Texas</option><option>Utah</option></select>
        <script>document.getElementById('s').addEventListener('change', (e) => { e.target.selectedIndex = 2 });</script>
      </form></body></html>`)
      const { fields } = await readForm(page, { clickApply: false })
      expect(fields[0].options).toEqual(['Texas', 'Utah'])
      expect(await run(page, fields[0], 'Texas')).toEqual([{ label: 'State', reason: 'The dropdown shows "Utah" instead of "Texas"' }])
      expect(await run(page, fields[0], 'Utah')).toEqual([])
      await page.close()
    }, 20_000)

    const REACT_SELECT = (onPick: string) => `<!doctype html><html><body><div class="select">
      <label id="l">Country</label>
      <div class="control"><div class="single-value" id="shown"></div>
        <div class="input-wrap"><input id="c" role="combobox" aria-labelledby="l" aria-autocomplete="list" aria-controls="list"></div></div>
      <ul id="list" role="listbox"><li role="option">Canada</li><li role="option">United States</li></ul>
      <div aria-live="polite" id="live"></div>
      <script>
        document.querySelectorAll('#list li').forEach((li) => li.addEventListener('click', () => { ${onPick} }));
      </script></div></body></html>`

    it('reads the choice a react-select style control displays, and fails when it shows nothing', async () => {
      const shows = await load(REACT_SELECT(`document.getElementById('shown').textContent = li.textContent; document.getElementById('c').value = ''`))
      const a = (await readForm(shows, { clickApply: false })).fields[0]
      expect(await run(shows, a, 'United States')).toEqual([])
      expect(await shows.textContent('#shown')).toBe('United States')
      await shows.close()

      const blank = await load(REACT_SELECT(`document.getElementById('c').value = ''`))
      const b = (await readForm(blank, { clickApply: false })).fields[0]
      expect(await run(blank, b, 'United States')).toEqual([{ label: 'Country', reason: 'The dropdown shows nothing after choosing "United States"' }])
      await blank.close()

      const wrong = await load(REACT_SELECT(`document.getElementById('shown').textContent = 'Canada'; document.getElementById('c').value = ''`))
      const c = (await readForm(wrong, { clickApply: false })).fields[0]
      expect(await run(wrong, c, 'United States')).toEqual([{ label: 'Country', reason: 'The dropdown shows "Canada" instead of "United States"' }])
      await wrong.close()
    }, 40_000)

    it('keeps a long free-text answer in a dropdown that has no suggestions', async () => {
      const page = await load(`<!doctype html><html><body><label id="l">Current employer</label>
        <input id="e" role="combobox" aria-labelledby="l" aria-autocomplete="list"></body></html>`)
      const { fields } = await readForm(page, { clickApply: false })
      const long = 'The International Association of Machinists and Aerospace Workers'
      expect(await run(page, fields[0], long)).toEqual([])
      expect(await page.inputValue('#e')).toBe(long)
      await page.close()
    }, 20_000)

    it('fails an Ashby yes/no group that ends up with both buttons pressed', async () => {
      const page = await load(fixture('ashby-yesno.html'))
      const { fields } = await readForm(page, { clickApply: false })
      await page.evaluate(() => {
        const b = document.querySelector('button[data-option]') as HTMLButtonElement
        b.addEventListener('click', () => b.parentElement!.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'true')))
      })
      const failures = await run(page, fields[0], 'Yes')
      expect(failures).toHaveLength(1)
      expect(failures[0].reason).toBe('The group shows "No" chosen instead of "Yes"')
      await page.close()
    }, 20_000)

    describe('uploads', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-upload-'))
      const stored = path.join(dir, 'resume-8f3a.pdf')
      const odt = path.join(dir, 'resume-8f3a.odt')
      fs.writeFileSync(stored, '%PDF-1.4 test')
      fs.writeFileSync(odt, 'odt test')
      afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
      const names = (page: Page) => page.$eval('#cv', (el) => Array.from((el as HTMLInputElement).files ?? []).map((f) => f.name))
      const form = (accept: string, script = '') => `<!doctype html><html><body><form>
        <label for="cv">Resume *</label><input id="cv" type="file" required ${accept ? `accept="${accept}"` : ''}>
        <script>${script}</script></form></body></html>`

      it('uploads the resume under a clean name and keeps its type', async () => {
        const page = await load(form('.pdf,.doc'))
        const { fields } = await readForm(page, { clickApply: false })
        const files = { resume: stored, coverLetter: null, resumeName: resumeFileName('Sam Rivera', stored) }
        expect(await run(page, fields[0], '', files)).toEqual([])
        expect(await names(page)).toEqual(['Sam Rivera - Resume.pdf'])
        expect(await page.$eval('#cv', (el) => (el as HTMLInputElement).files![0].type)).toBe('application/pdf')
        await page.close()
      })

      it('refuses a resume type the field does not take', async () => {
        const page = await load(form('application/pdf'))
        const { fields } = await readForm(page, { clickApply: false })
        const files = { resume: odt, coverLetter: null, resumeName: resumeFileName('Sam Rivera', odt) }
        const failures = await run(page, fields[0], '', files)
        expect(failures).toEqual([{ label: 'Resume', reason: 'This upload takes application/pdf and "Sam Rivera - Resume.odt" is not one of those' }])
        expect(await names(page)).toEqual([])
        await page.close()
      })

      it('fails when the input ends up empty or holding another file', async () => {
        const files = { resume: stored, coverLetter: null, resumeName: 'Sam Rivera - Resume.pdf' }
        const empty = await load(form('', `document.getElementById('cv').addEventListener('change', (e) => { e.target.value = '' })`))
        const e = (await readForm(empty, { clickApply: false })).fields[0]
        expect(await run(empty, e, '', files)).toEqual([{ label: 'Resume', reason: 'The upload field is empty after attaching "Sam Rivera - Resume.pdf"' }])
        await empty.close()

        const other = await load(
          form('', `document.getElementById('cv').addEventListener('change', (e) => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'other.pdf')); e.target.files = dt.files })`)
        )
        const o = (await readForm(other, { clickApply: false })).fields[0]
        expect(await run(other, o, '', files)).toEqual([
          { label: 'Resume', reason: 'The upload field holds "other.pdf" instead of "Sam Rivera - Resume.pdf"' }
        ])
        await other.close()
      })
    })

    it('reads every option of a long dropdown', async () => {
      const page = await load(`<!doctype html><html><body><label id="l">Country</label>
        <input id="c" role="combobox" aria-labelledby="l" aria-autocomplete="list" aria-controls="list"><ul id="list" role="listbox" style="display:none"></ul>
        <script>
          const list = document.getElementById('list');
          for (let i = 0; i < 250; i++) { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = 'Country ' + i; list.appendChild(li); }
          document.getElementById('c').addEventListener('click', () => { list.style.display = 'block' });
        </script></body></html>`)
      const { frame, fields } = await readForm(page, { clickApply: false })
      await readComboboxOptions(frame, fields)
      expect(fields[0].options).toHaveLength(250)
      await page.close()
    }, 30_000)
  })

  describe('what the extractor reads', () => {
    it('drops only the placeholder option of a select', async () => {
      const page = await load(`<!doctype html><html><body><form>
        <label for="a">Gender</label><select id="a"><option value="">Select...</option><option>Woman</option><option>Man</option><option>Choose not to disclose</option></select>
        <label for="b">Start</label><select id="b"><option value="">Please select</option><option value="">No preference</option><option>Now</option></select>
        <label for="c">Visa</label><select id="c"><option>Yes</option><option>No</option></select>
      </form></body></html>`)
      const { fields } = await readForm(page, { clickApply: false })
      expect(fields.map((f) => f.options)).toEqual([['Woman', 'Man', 'Choose not to disclose'], ['No preference', 'Now'], ['Yes', 'No']])
      await page.close()
    })

    it('takes a Greenhouse upload label and required flag from its group', async () => {
      const page = await load(`<!doctype html><html><body><form>
        <div role="group" aria-labelledby="r-label"><label id="r-label">Resume/CV<span>*</span></label>
          <button type="button">Attach</button><input type="file" id="r" style="display:none"><label for="r">Attach</label></div>
        <div role="group" aria-labelledby="c-label"><label id="c-label">Cover Letter</label>
          <button type="button">Attach</button><input type="file" id="c" style="display:none"><label for="c">Attach</label></div>
      </form></body></html>`)
      const { fields } = await readForm(page, { clickApply: false })
      expect(fields.map((f) => [f.label, f.required, f.fileHint])).toEqual([
        ['Resume/CV', true, 'resume'],
        ['Cover Letter', false, 'cover_letter']
      ])
      await page.close()
    })

    it('reads resume words in other languages and a lone upload as the resume', async () => {
      const hint = async (labels: string[]) => {
        const page = await load(`<!doctype html><html><body><form>${labels.map((l, i) => `<label for="f${i}">${l}</label><input id="f${i}" type="file">`).join('')}</form></body></html>`)
        const { fields } = await readForm(page, { clickApply: false })
        await page.close()
        return fields.map((f) => f.fileHint)
      }
      expect(await hint(['Resume or cover letter', 'Portfolio'])).toEqual(['resume', 'other'])
      expect(await hint(['Lebenslauf', 'Anschreiben cover letter'])).toEqual(['resume', 'cover_letter'])
      expect(await hint(['Curriculum vitae', 'Attachment'])).toEqual(['resume', 'resume'])
      expect(await hint(['Additional attachments', 'Resume'])).toEqual(['other', 'resume'])
      expect(await hint(['Upload your documents'])).toEqual(['resume'])
      expect(await hint(['Cover letter'])).toEqual(['cover_letter'])
    })

    it("skips Ashby's autofill pane", async () => {
      const page = await load(`<!doctype html><html><body><form>
        <div class="ashby-application-form-autofill-input-root"><label for="auto">Upload file</label><input id="auto" type="file"></div>
        <label for="n">Name</label><input id="n" name="_systemfield_name">
        <label for="r">Resume</label><input id="r" type="file">
      </form></body></html>`)
      const { fields } = await readForm(page, { clickApply: false })
      expect(fields.map((f) => f.label)).toEqual(['Name', 'Resume'])
      await page.close()
    })
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

  it('never fills Athens, GA as Athens, Alabama', () => {
    expect(chooseSuggestion(['Athens, Alabama, United States'], 'Athens, GA', true)).toBeNull()
    expect(chooseSuggestion(['Athens, Alabama, United States', 'Athens, Georgia, United States'], 'Athens, GA', true)).toBe('Athens, Georgia, United States')
    expect(chooseSuggestion(['Athens, Greece'], 'Athens, GA', true)).toBeNull()
    expect(chooseSuggestion(['Athens, Alabama, United States'], 'Athens, Georgia, United States', true)).toBeNull()
  })

  it('accepts a longer city name in the wanted region', () => {
    expect(chooseSuggestion(['Athens-Clarke County, Georgia, United States'], 'Athens, GA', true)).toBe('Athens-Clarke County, Georgia, United States')
    // The same longer name in another region does not count, and neither does another city in the region.
    expect(chooseSuggestion(['Athens-Clarke County, Georgia, United States'], 'Athens, AL', true)).toBeNull()
    expect(chooseSuggestion(['Atlanta, Georgia, United States'], 'Athens, GA', true)).toBeNull()
  })

  it('needs the wanted country to match', () => {
    expect(chooseSuggestion(['Paris, Texas, United States'], 'Paris, France', true)).toBeNull()
    expect(chooseSuggestion(['Paris, Île-de-France, France'], 'Paris, France', true)).toBe('Paris, Île-de-France, France')
    // A state in the suggestion already says the country.
    expect(chooseSuggestion(['Seattle, Washington'], 'Seattle', true)).toBe('Seattle, Washington')
  })
})

describe('resumeFileName and acceptsFile', () => {
  it('names the resume after the person and keeps the real extension', () => {
    expect(resumeFileName('Sam Rivera', 'C:/data/resumes/resume-8f3a.pdf')).toBe('Sam Rivera - Resume.pdf')
    expect(resumeFileName('Sam Rivera', '/data/cv.final.DOCX')).toBe('Sam Rivera - Resume.DOCX')
    expect(resumeFileName("Zoë O'Neil / Jr.", '/data/a.pdf')).toBe("Zoë O'Neil Jr - Resume.pdf")
  })

  it('falls back to "Resume" with no name', () => {
    expect(resumeFileName('', '/data/a.pdf')).toBe('Resume.pdf')
    expect(resumeFileName('  ', '/data/a.docx')).toBe('Resume.docx')
    expect(resumeFileName(null, '/data/a.pdf')).toBe('Resume.pdf')
  })

  it('reads an accept list', () => {
    expect(acceptsFile('', 'a.odt', 'application/vnd.oasis.opendocument.text')).toBe(true)
    expect(acceptsFile('.pdf, .DOC', 'a.pdf', 'application/pdf')).toBe(true)
    expect(acceptsFile('.pdf,.doc', 'a.docx', 'application/x')).toBe(false)
    expect(acceptsFile('application/pdf', 'a.pdf', 'application/pdf')).toBe(true)
    expect(acceptsFile('application/*', 'a.docx', 'application/x')).toBe(true)
    expect(acceptsFile('image/*', 'a.pdf', 'application/pdf')).toBe(false)
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
