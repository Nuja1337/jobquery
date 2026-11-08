import type { Frame, Locator, Page } from 'playwright-core'
import type { FieldType, FormField, PreparedAnswer } from '@shared/types'
import { countryOf, regionOf } from '../util/geo'
import { jaccard, normalizeQuestion } from '../util/text'
import type { ExtractedField } from './extractScript'
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
    fileHint: f.fileHint
  }
}

/**
 * The options a dropdown offers right now. They come from the dropdown's own list (the id in
 * aria-controls or aria-owns), because pages can hold other hidden option lists, such as the
 * country list of a phone number widget. Read this after opening the dropdown, since some
 * libraries only set the attribute then.
 */
async function ownOptions(frame: Frame, box: Locator): Promise<Locator> {
  const attr = (await box.getAttribute('aria-controls').catch(() => null)) || (await box.getAttribute('aria-owns').catch(() => null))
  const id = attr?.trim().split(/\s+/)[0]
  if (id) {
    const quoted = id.replace(/["\\]/g, '\\$&')
    // A list that isn't in the page yet is not a reason to read some other list.
    if ((await frame.locator(`[id="${quoted}"]`).count().catch(() => 0)) > 0) return frame.locator(`[id="${quoted}"] [role="option"]`)
  }
  return frame.locator('[role="option"]:visible')
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
      const texts = await optionTexts(await ownOptions(frame, box))
      field.options = [...new Set(texts.filter(Boolean))].slice(0, 200)
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
}

export interface FillFailure {
  label: string
  reason: string
}

async function fillOne(frame: Frame, field: ExtractedField, answer: PreparedAnswer, files: FillFiles): Promise<void> {
  const loc = frame.locator(sel(field.jpId)).first()
  const value = answer.value

  switch (field.type) {
    case 'file': {
      const path = filePathFor(field, answer, files)
      if (!path) throw new Error('No file to upload')
      await loc.setInputFiles(path)
      return
    }
    case 'select': {
      const picked = field.options.includes(value) ? value : pickOption(field.options, value)
      if (!picked) throw new Error(`"${value}" is not one of the options`)
      await loc.selectOption({ label: picked })
      return
    }
    case 'multiselect': {
      const wanted = parseList(value)
      const labels = wanted.map((w) => pickOption(field.options, w)).filter((x): x is string => Boolean(x))
      if (labels.length < wanted.length) throw new Error(`Some of ${value} aren't among the options`)
      await loc.selectOption(labels.map((label) => ({ label })))
      return
    }
    case 'radio': {
      const picked = field.options.includes(value) ? value : pickOption(field.options, value)
      const i = picked ? field.options.indexOf(picked) : -1
      if (i === -1) throw new Error(`"${value}" is not one of the options`)
      await checkInput(frame, field.optionIds[i])
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
    }
  }
}

/** A trailing phone dial code, such as the " +1" in "United States +1". */
const DIAL_CODE = /\s*\(?\+\d[\d\s-]*\)?\s*$/

export function stripDialCode(text: string): string {
  return text.replace(DIAL_CODE, '').trim()
}

const LOCATION_LABEL = /location|city|where (are )?you (are )?(based|located)|where do you (live|reside)/i

const firstSegment = (text: string) => text.split(',')[0].trim().toLowerCase()

function namesPlace(suggestion: string, place: string): boolean {
  const escaped = place.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const aliases = place === 'United States' ? '|usa|u\\.s\\.a?\\.?' : ''
  return new RegExp(`(^|[^a-z])(${escaped}${aliases})([^a-z]|$)`).test(suggestion.toLowerCase())
}

/**
 * Picks the suggestion that matches the wanted value, or null. A dial code is ignored on both
 * sides ("United States" picks "United States +1" but not "United States Minor Outlying Islands +1").
 * For a location, the suggestion's city must be the wanted city. When several cities share a
 * name, the one in the wanted country wins, then the wanted region.
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
    const kept = options.filter((t) => firstSegment(t) === city)
    if (kept.length === 1) return kept[0]
    if (kept.length > 1) {
      // Narrow to the wanted country first, then to the wanted region.
      const country = countryOf(value)
      const inCountry = country ? kept.filter((t) => namesPlace(t, country)) : []
      const pool = inCountry.length ? inCountry : kept
      const region = regionOf(value)
      return (region ? pool.find((t) => regionOf(t) === region) : undefined) ?? pool[0]
    }
  }
  return pickOption(options, value) ?? (bare !== lower ? pickOption(options, stripDialCode(value)) : null)
}

/** Types into a search box and waits up to about 3 seconds for a suggestion that matches. */
async function typeAndWait(
  frame: Frame,
  box: Locator,
  search: string,
  value: string,
  locationLike: boolean
): Promise<{ options: Locator; texts: string[]; picked: string | null }> {
  await box.fill('')
  await box.pressSequentially(search.slice(0, 40), { delay: 40 })
  const deadline = Date.now() + 3000
  let texts: string[] = []
  let same = 0
  for (;;) {
    const options = await ownOptions(frame, box)
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
  let result = await typeAndWait(frame, box, stripDialCode(value) || value, value, locationLike)
  if (!result.picked && locationLike) {
    // Geocoding boxes often search the city alone better than "City, State".
    const city = value.split(',')[0].trim()
    if (city && city !== value) result = await typeAndWait(frame, box, city, value, locationLike)
  }
  // Pressing Enter would take whatever suggestion is first, which can be the wrong one.
  if (result.texts.length === 0 && field.options.length === 0) {
    // A free-text box with no suggestion list keeps what was typed.
    await box.press('Tab').catch(() => {})
    return
  }
  if (!result.picked) {
    await box.press('Escape').catch(() => {})
    throw new Error(`"${value}" is not one of the options`)
  }
  await result.options.nth(result.texts.indexOf(result.picked)).click()
}

function filePathFor(field: ExtractedField, answer: PreparedAnswer, files: FillFiles): string | null {
  return field.fileHint === 'cover_letter' ? files.coverLetter : field.fileHint === 'resume' ? files.resume : answer.value || null
}

async function checkInput(frame: Frame, jpId: string): Promise<void> {
  const input = frame.locator(sel(jpId)).first()
  try {
    // Custom-styled radios and checkboxes often hide the real input, so force the check.
    await input.check({ force: true, timeout: 3000 })
  } catch {
    await input.click({ force: true })
  }
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
