import fs from 'node:fs'
import nodePath from 'node:path'
import type { Frame, Locator, Page } from 'playwright-core'
import type { FieldType, FormField, PreparedAnswer } from '@shared/types'
import { countryOf, regionOf } from '../util/geo'
import { jaccard, normalizeQuestion } from '../util/text'
import { clean } from './coverLetterPdf'
import { readPickedScript, tagSuggestionsScript, type ExtractedField } from './extractScript'
import { pickOption } from './fieldMap'

const sel = (jpId: string) => `[data-jp-id="${jpId}"]`

export function toFormField(f: ExtractedField): FormField {
  return {
    key: f.key,
    label: f.label,
    type: f.type as FieldType,
    required: f.required,
    options: f.options,
    placeholder: f.placeholder,
    maxLength: f.maxLength,
    fileHint: f.fileHint,
    hint: f.hint ?? null
  }
}

/**
 * The options a dropdown offers right now. They come from the dropdown's own list (the id in
 * aria-controls or aria-owns), because pages can hold other hidden option lists, such as the
 * country list of a phone number widget. Read this after opening the dropdown, since some
 * libraries only set the attribute then. A plain text box with a suggestion container beside it
 * (Lever's location box) has no roles, so its items come from that container.
 */
async function ownOptions(frame: Frame, box: Locator, jpId: string): Promise<Locator> {
  const attr = (await box.getAttribute('aria-controls').catch(() => null)) || (await box.getAttribute('aria-owns').catch(() => null))
  const id = attr?.trim().split(/\s+/)[0]
  if (id) {
    const quoted = id.replace(/["\\]/g, '\\$&')
    // A list that isn't in the page yet is not a reason to read some other list.
    if ((await frame.locator(`[id="${quoted}"]`).count().catch(() => 0)) > 0) return frame.locator(`[id="${quoted}"] [role="option"]`)
  }
  const roled = frame.locator('[role="option"]:visible')
  if ((await roled.count().catch(() => 0)) > 0) return roled
  const tagged = ((await frame.evaluate(tagSuggestionsScript(jpId)).catch(() => '')) as string)
  return tagged ? frame.locator(`[data-jp-sug="${tagged}"]:visible`) : roled
}

async function optionTexts(options: Locator): Promise<string[]> {
  const texts = await options.allInnerTexts().catch(() => [] as string[])
  return texts.map((t) => t.replace(/\s+/g, ' ').trim())
}

/** Opens each custom dropdown briefly to read its options, since they aren't in the DOM until opened. */
export async function readComboboxOptions(frame: Frame, fields: ExtractedField[]): Promise<void> {
  for (const field of fields) {
    if (field.type !== 'combobox' || field.options.length > 0) continue
    try {
      const box = frame.locator(sel(field.jpId))
      await box.click({ timeout: 2000 })
      await frame.waitForTimeout(350)
      const texts = await optionTexts(await ownOptions(frame, box, field.jpId))
      field.options = [...new Set(texts.filter(Boolean))]
      await box.press('Escape').catch(() => {})
    } catch {
      // Leave options empty. The filler will type the answer and pick the closest suggestion.
    }
  }
}

const TYPE_FAMILY: Record<string, string> = {
  text: 'text', email: 'text', tel: 'text', url: 'text', number: 'text', date: 'text', textarea: 'text',
  select: 'choice', radio: 'choice', combobox: 'choice', multiselect: 'multi', checkboxes: 'multi',
  checkbox: 'checkbox', file: 'file'
}

/**
 * Lines up prepared answers with the fields on the live page. Keys match first, then
 * labels, because some forms generate new ids on every load.
 */
export function matchAnswers(fields: ExtractedField[], answers: PreparedAnswer[]): {
  matched: Array<{ field: ExtractedField; answer: PreparedAnswer }>
  unmatched: ExtractedField[]
} {
  const remaining = [...answers]
  const matched: Array<{ field: ExtractedField; answer: PreparedAnswer }> = []
  const unmatched: ExtractedField[] = []
  for (const field of fields) {
    let idx = remaining.findIndex((a) => a.fieldKey === field.key)
    if (idx === -1) {
      const norm = normalizeQuestion(field.label)
      let bestScore = 0
      remaining.forEach((a, i) => {
        if (TYPE_FAMILY[a.type] !== TYPE_FAMILY[field.type]) return
        const score = jaccard(norm, normalizeQuestion(a.label))
        if (score > bestScore) {
          bestScore = score
          idx = i
        }
      })
      if (bestScore < 0.8) idx = -1
    }
    if (idx === -1) unmatched.push(field)
    else matched.push({ field, answer: remaining.splice(idx, 1)[0] })
  }
  return { matched, unmatched }
}

export interface FillFiles {
  resume: string | null
  coverLetter: string | null
  /** The name the employer sees for the resume. Without one, the file's own name is used. */
  resumeName?: string | null
}

export interface FillFailure {
  label: string
  reason: string
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Letters and digits only, so a phone mask or a thousands separator doesn't count as a different value. */
const alnum = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const digits = (s: string) => s.replace(/\D+/g, '')
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s)

async function fillOne(frame: Frame, field: ExtractedField, answer: PreparedAnswer, files: FillFiles): Promise<void> {
  const loc = frame.locator(sel(field.jpId)).first()
  const value = answer.value

  switch (field.type) {
    case 'file': {
      const path = filePathFor(field, answer, files)
      if (!path) throw new Error('No file to upload')
      await uploadFile(frame, loc, field, path, files)
      return
    }
    case 'select': {
      const picked = field.options.includes(value) ? value : pickOption(field.options, value)
      if (!picked) throw new Error(`"${value}" is not one of the options`)
      await loc.selectOption({ label: picked })
      await verifySelected(loc, [picked])
      return
    }
    case 'multiselect': {
      const wanted = parseList(value)
      const labels = wanted.map((w) => pickOption(field.options, w)).filter((x): x is string => Boolean(x))
      if (labels.length < wanted.length) throw new Error(`Some of ${value} aren't among the options`)
      await loc.selectOption(labels.map((label) => ({ label })))
      await verifySelected(loc, labels)
      return
    }
    case 'radio': {
      const wanted = value === 'true' ? 'Yes' : value === 'false' ? 'No' : value
      const picked = field.options.includes(wanted) ? wanted : pickOption(field.options, wanted)
      const i = picked ? field.options.indexOf(picked) : -1
      if (i === -1) throw new Error(`"${value}" is not one of the options`)
      await checkInput(frame, field.optionIds[i])
      await verifyChoice(frame, field, i)
      return
    }
    case 'checkboxes': {
      const wanted = parseList(value)
      const missing: string[] = []
      for (const w of wanted) {
        const picked = pickOption(field.options, w)
        const i = picked ? field.options.indexOf(picked) : -1
        if (i !== -1) await checkInput(frame, field.optionIds[i])
        else missing.push(w)
      }
      if (missing.length) throw new Error(`"${missing.join('", "')}" isn't among the options`)
      return
    }
    case 'checkbox': {
      if (value === 'true') await checkInput(frame, field.jpId)
      else await uncheckInput(frame, field.jpId)
      return
    }
    case 'combobox': {
      await fillCombobox(frame, loc, field, value)
      return
    }
    default: {
      await loc.fill(value)
      await verifyText(loc, field, value)
    }
  }
}

/**
 * Reads a text box back after filling it. A value cut by maxlength, wiped by the page or changed into
 * something else is a fill failure. Formatting alone (a phone mask, a thousands separator) is fine.
 */
async function verifyText(loc: Locator, field: ExtractedField, wanted: string): Promise<void> {
  const actual = await loc.inputValue({ timeout: 1000 }).catch(() => null)
  if (actual === null) return
  if (squash(actual) === squash(wanted)) return
  const a = alnum(actual)
  const w = alnum(wanted)
  if (a === w) return
  if (field.type === 'tel' && digits(wanted) !== '' && digits(actual).endsWith(digits(wanted))) return
  if (actual === '') throw new Error('The box is empty after filling it')
  if (w.startsWith(a)) {
    const limit = field.maxLength ? ` (limit ${field.maxLength})` : ''
    throw new Error(`The box kept ${actual.length} of ${wanted.length} characters${limit}`)
  }
  throw new Error(`The box shows "${short(actual)}" instead of "${short(wanted)}"`)
}

/** Reads the chosen labels of a select back. */
async function verifySelected(loc: Locator, expected: string[]): Promise<void> {
  const shown = await loc
    .evaluate((el) => Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.text), undefined, { timeout: 1000 })
    .catch(() => null)
  if (shown === null) return
  const have = new Set(shown.map(alnum))
  const missing = expected.filter((e) => !have.has(alnum(e)))
  if (missing.length === 0) return
  const now = shown.length ? shown.map((s) => `"${short(squash(s))}"`).join(', ') : 'nothing'
  throw new Error(`The dropdown shows ${now} instead of "${missing.map(short).join('", "')}"`)
}

/** After a radio group is set, the chosen option is on and no other option of the group is. */
async function verifyChoice(frame: Frame, field: ExtractedField, chosen: number): Promise<void> {
  const states: boolean[] = []
  for (const id of field.optionIds) {
    const el = frame.locator(sel(id)).first()
    const tag = await el.evaluate((n) => n.tagName.toLowerCase(), undefined, { timeout: 1000 }).catch(() => '')
    if (!tag) return
    states.push(
      tag === 'button'
        ? (await el.getAttribute('aria-pressed', { timeout: 1000 }).catch(() => null)) === 'true'
        : await el.isChecked({ timeout: 1000 }).catch(() => false)
    )
  }
  if (states[chosen] !== true) throw new Error(`"${field.options[chosen]}" did not stay chosen`)
  const other = states.findIndex((on, i) => on && i !== chosen)
  if (other !== -1) throw new Error(`The group shows "${field.options[other]}" chosen instead of "${field.options[chosen]}"`)
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain'
}

/**
 * The name a resume is uploaded under: "First Last - Resume.pdf", keeping the real extension.
 * Without a name it is "Resume.pdf". The files on disk keep their own names.
 */
export function resumeFileName(fullName: string | null | undefined, filePath: string): string {
  const name = clean(fullName ?? '')
  return `${name ? `${name} - Resume` : 'Resume'}${nodePath.extname(filePath)}`
}

/** Whether an input's accept list ("application/pdf,.doc") takes a file. An empty list takes anything. */
export function acceptsFile(accept: string, fileName: string, mimeType: string): boolean {
  const tokens = accept.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean)
  if (tokens.length === 0) return true
  const name = fileName.toLowerCase()
  const mime = mimeType.toLowerCase()
  return tokens.some((t) => (t.startsWith('.') ? name.endsWith(t) : t.endsWith('/*') ? mime.startsWith(t.slice(0, -1)) : t === mime || t === '*/*'))
}

/**
 * Attaches a file under a clean name and reads the input back. A resume goes up as
 * "First Last - Resume.pdf". A type the field's accept list does not take is refused.
 */
async function uploadFile(frame: Frame, loc: Locator, field: ExtractedField, path: string, files: FillFiles): Promise<void> {
  const name = field.fileHint === 'resume' && files.resumeName ? files.resumeName : nodePath.basename(path)
  const mimeType = MIME_BY_EXT[nodePath.extname(name).toLowerCase()] ?? 'application/octet-stream'
  const accept = ((await loc.getAttribute('accept', { timeout: 1000 }).catch(() => null)) ?? '').trim()
  if (!acceptsFile(accept, name, mimeType)) throw new Error(`This upload takes ${accept} and "${name}" is not one of those`)
  let buffer: Buffer
  try {
    buffer = await fs.promises.readFile(path)
  } catch {
    throw new Error(`Couldn't read the file ${nodePath.basename(path)}`)
  }
  await loc.setInputFiles({ name, mimeType, buffer })
  await frame.waitForTimeout(150)
  const held = await loc
    .evaluate((el) => Array.from((el as HTMLInputElement).files ?? []).map((f) => f.name), undefined, { timeout: 1000 })
    .catch(() => null)
  // A page that swaps the input for its own widget after an upload leaves nothing to read.
  if (held === null) return
  if (held.length === 0) throw new Error(`The upload field is empty after attaching "${name}"`)
  if (held.length !== 1 || held[0] !== name) throw new Error(`The upload field holds "${held.join('", "')}" instead of "${name}"`)
}

/** A trailing phone dial code, such as the " +1" in "United States +1". */
const DIAL_CODE = /\s*\(?\+\d[\d\s-]*\)?\s*$/

export function stripDialCode(text: string): string {
  return text.replace(DIAL_CODE, '').trim()
}

const LOCATION_LABEL = /location|city|where (are )?you (are )?(based|located)|where do you (live|reside)/i

const firstSegment = (text: string) => text.split(',')[0].trim().toLowerCase()

/** Metro areas that location boxes offer in place of the city. Each belongs to one city and region, so it can't be another city's. */
const METRO_AREAS: Array<{ name: RegExp; city: string; region: string }> = [
  { name: /^san francisco bay area$/, city: 'san francisco', region: 'CA' },
  { name: /^(?:greater seattle area|seattle metropolitan area)$/, city: 'seattle', region: 'WA' },
  { name: /^(?:greater boston(?: area)?|boston metropolitan area)$/, city: 'boston', region: 'MA' },
  { name: /^(?:greater new york city area|new york city metropolitan area)$/, city: 'new york', region: 'NY' },
  { name: /^(?:greater los angeles area|los angeles metropolitan area)$/, city: 'los angeles', region: 'CA' }
]

function namesPlace(suggestion: string, place: string): boolean {
  const escaped = place.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const aliases = place === 'United States' ? '|usa|u\\.s\\.a?\\.?' : ''
  return new RegExp(`(^|[^a-z])(${escaped}${aliases})([^a-z]|$)`).test(suggestion.toLowerCase())
}

/**
 * Picks the suggestion that matches the wanted value, or null. A dial code is ignored on both
 * sides ("United States" picks "United States +1" but not "United States Minor Outlying Islands +1").
 * For a location, the suggestion's city must be the wanted city, or a longer name of it in the wanted
 * region ("Athens-Clarke County, Georgia" for "Athens, GA"). The wanted region and country must match
 * too. A list that has only "Athens, Alabama" gives null for "Athens, GA".
 */
export function chooseSuggestion(texts: string[], value: string, locationLike: boolean): string | null {
  const options = texts.filter(Boolean)
  const lower = value.trim().toLowerCase()
  const exact = options.find((t) => t.toLowerCase() === lower)
  if (exact) return exact
  const bare = stripDialCode(value).toLowerCase()
  const dial = options.find((t) => stripDialCode(t).toLowerCase() === bare)
  if (dial) return dial
  if (locationLike) {
    const city = firstSegment(value)
    const country = countryOf(value)
    const region = regionOf(value)
    const regionFits = (t: string): boolean => {
      if (!region) return true
      const there = regionOf(t)
      return there ? there === region : country !== null && namesPlace(t, country)
    }
    // A US state or Canadian province in the suggestion already says which country it is in.
    const countryFits = (t: string): boolean =>
      !country || namesPlace(t, country) || (regionOf(t) !== null && (country === 'United States' || country === 'Canada'))
    const fits = (t: string) => regionFits(t) && countryFits(t)
    const longer = (t: string) => {
      const c = firstSegment(t)
      return region !== null && (c.startsWith(city + ' ') || c.startsWith(city + '-')) && regionOf(t) === region
    }
    const kept = options.filter((t) => firstSegment(t) === city)
    if (kept.length > 0) {
      const pool = kept.filter(fits)
      if (pool.length === 0) return null
      // Several cities share a name: the one in the wanted country wins, then the wanted region.
      const inCountry = country ? pool.filter((t) => namesPlace(t, country)) : []
      const best = inCountry.length ? inCountry : pool
      return (region ? best.find((t) => regionOf(t) === region) : undefined) ?? best[0]
    }
    const metro = (t: string) => {
      const name = firstSegment(t)
      const there = countryOf(t)
      return region !== null && regionOf(t) === null && (!there || there === country) && METRO_AREAS.some((m) => m.name.test(name) && m.city === city && m.region === region)
    }
    const extended = options.filter((t) => (longer(t) && countryFits(t)) || metro(t))
    if (extended.length > 0) return extended[0]
    const loose = pickOption(options, value) ?? (bare !== lower ? pickOption(options, stripDialCode(value)) : null)
    return loose && fits(loose) ? loose : null
  }
  return pickOption(options, value) ?? (bare !== lower ? pickOption(options, stripDialCode(value)) : null)
}

/** Types into a search box and waits up to about 3 seconds for a suggestion that matches. */
async function typeAndWait(
  frame: Frame,
  box: Locator,
  search: string,
  value: string,
  locationLike: boolean,
  jpId: string
): Promise<{ options: Locator; texts: string[]; picked: string | null }> {
  await box.fill('')
  await box.pressSequentially(search.slice(0, 40), { delay: 40 })
  const deadline = Date.now() + 3000
  let texts: string[] = []
  let same = 0
  for (;;) {
    const options = await ownOptions(frame, box, jpId)
    const now = await optionTexts(options)
    same = now.length > 0 && now.join('|') === texts.join('|') ? same + 1 : 0
    texts = now
    const picked = chooseSuggestion(texts, value, locationLike)
    if (picked) return { options, texts, picked }
    // A list that has stopped changing and has nothing to pick won't get better.
    if (same >= 3 || Date.now() >= deadline) return { options, texts, picked: null }
    await frame.waitForTimeout(150)
  }
}

async function fillCombobox(frame: Frame, box: Locator, field: ExtractedField, rawValue: string): Promise<void> {
  const value = rawValue.trim()
  const locationLike = LOCATION_LABEL.test(field.label)
  await box.click()
  let result = await typeAndWait(frame, box, stripDialCode(value) || value, value, locationLike, field.jpId)
  if (!result.picked && locationLike) {
    // Geocoding boxes often search the city alone better than "City, State".
    const city = value.split(',')[0].trim()
    if (city && city !== value) result = await typeAndWait(frame, box, city, value, locationLike, field.jpId)
  }
  // Pressing Enter would take whatever suggestion is first, which can be the wrong one.
  if (result.texts.length === 0 && field.options.length === 0) {
    // A free-text box with no suggestion list keeps what was typed. Only the first 40 characters were typed.
    if (value.length > 40) await box.fill(value)
    await box.press('Tab').catch(() => {})
    await verifyShown(frame, box, field.jpId, value)
    return
  }
  if (!result.picked) {
    await box.press('Escape').catch(() => {})
    throw new Error(`"${value}" is not one of the options`)
  }
  await result.options.nth(result.texts.indexOf(result.picked)).click()
  await verifyShown(frame, box, field.jpId, result.picked)
}

type Shown = { value: string; display: string; hiddenFilled: boolean }

/**
 * Reads a dropdown back after a pick: what the box holds, and what the control around it displays
 * (react-select shows its choice in a separate element, not in the input). A page that shows nothing
 * or another option is a fill failure. A plain text box with a suggestion list (Lever's location box)
 * is blurred first, since it clears itself on blur unless a suggestion was picked, and a hidden input
 * beside it (the selected location) must be filled.
 */
async function verifyShown(frame: Frame, box: Locator, jpId: string, wanted: string): Promise<void> {
  const tag = await box.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
  if (tag !== 'input') return
  const roleless = !(await box.getAttribute('role').catch(() => null))
  if (roleless) await box.blur().catch(() => {})
  const wants = [...new Set([wanted, stripDialCode(wanted)])].map((w) => squash(w).toLowerCase()).filter(Boolean)
  const find = async () => (await frame.evaluate(readPickedScript(jpId)).catch(() => null)) as Shown | null
  let read = await find()
  if (!read) return
  if (roleless) {
    if (read.value.trim() === '') throw new Error(`The box cleared "${wanted}" when it lost focus`)
    if (!read.hiddenFilled) throw new Error(`The page did not register "${wanted}" as a chosen option`)
  }
  // Some pages draw the choice a moment after the click.
  for (let i = 0; i < 6; i++) {
    const text = `${squash(read.value)} | ${squash(read.display)}`.toLowerCase()
    if (wants.some((w) => text.includes(w))) return
    await frame.waitForTimeout(100)
    read = (await find()) ?? read
  }
  const now = squash(read.value) || squash(read.display)
  throw new Error(now ? `The dropdown shows "${short(now)}" instead of "${short(wanted)}"` : `The dropdown shows nothing after choosing "${short(wanted)}"`)
}

function filePathFor(field: ExtractedField, answer: PreparedAnswer, files: FillFiles): string | null {
  return field.fileHint === 'cover_letter' ? files.coverLetter : field.fileHint === 'resume' ? files.resume : answer.value || null
}

async function checkInput(frame: Frame, jpId: string): Promise<void> {
  const input = frame.locator(sel(jpId)).first()
  // Ashby's yes/no choices are toggle buttons, not inputs.
  if ((await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'input')) === 'button') {
    await pressButton(frame, input)
    return
  }
  try {
    // Custom-styled radios and checkboxes often hide the real input, so force the check.
    await input.check({ force: true, timeout: 3000 })
  } catch {
    await input.click({ force: true })
  }
  if (!(await input.isChecked({ timeout: 1000 }).catch(() => false))) throw new Error("The option didn't stay selected")
}

/** Presses a toggle button once and waits for aria-pressed="true". A button that is already pressed is left alone. */
async function pressButton(frame: Frame, button: Locator): Promise<void> {
  const pressed = async () => (await button.getAttribute('aria-pressed', { timeout: 1000 }).catch(() => null)) === 'true'
  if (await pressed()) return
  await button.click({ timeout: 3000 })
  for (let i = 0; i < 10; i++) {
    if (await pressed()) return
    await frame.waitForTimeout(100)
  }
  throw new Error("The button didn't stay pressed")
}

/**
 * Unticks a box that the page ticked ahead of time. If it is still ticked afterwards this throws,
 * so the box shows up as a fill failure and the form is not sent with an agreement the person never gave.
 */
async function uncheckInput(frame: Frame, jpId: string): Promise<void> {
  const input = frame.locator(sel(jpId)).first()
  const ticked = () => input.isChecked({ timeout: 1000 }).catch(() => false)
  if (!(await ticked())) return
  await input.uncheck({ force: true, timeout: 3000 }).catch(() => {})
  // A styled box can ignore uncheck. Click it, but only while it is still ticked.
  if (await ticked()) await input.click({ force: true, timeout: 3000 }).catch(() => {})
  if (await ticked()) throw new Error("Couldn't untick this box")
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : [value]
  } catch {
    return value ? [value] : []
  }
}

/** Fills every matched field. Empty answers are skipped. Returns the fields that failed. */
export async function fillForm(
  page: Page,
  frame: Frame,
  pairs: Array<{ field: ExtractedField; answer: PreparedAnswer }>,
  files: FillFiles
): Promise<FillFailure[]> {
  const failures: FillFailure[] = []
  for (const { field, answer } of pairs) {
    const isFile = field.type === 'file'
    if (!isFile && (answer.needsUser || answer.value === '')) continue
    // An optional upload with nothing to upload is left empty. A required one fails below.
    if (isFile && !field.required && !filePathFor(field, answer, files)) continue
    try {
      await fillOne(frame, field, answer, files)
    } catch (err) {
      failures.push({ label: field.label || field.key, reason: (err as Error).message.split('\n')[0] })
    }
  }
  await page.waitForTimeout(300)
  return failures
}
