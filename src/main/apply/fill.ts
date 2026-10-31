import type { Frame, Page } from 'playwright-core'
import type { FieldType, FormField, PreparedAnswer } from '@shared/types'
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

/** Opens each custom dropdown briefly to read its options, since they aren't in the DOM until opened. */
export async function readComboboxOptions(frame: Frame, fields: ExtractedField[]): Promise<void> {
  for (const field of fields) {
    if (field.type !== 'combobox' || field.options.length > 0) continue
    try {
      const box = frame.locator(sel(field.jpId))
      await box.click({ timeout: 2000 })
      await frame.waitForTimeout(350)
      const texts = await frame.locator('[role="option"]').allInnerTexts()
      field.options = [...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 200)
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
      const path = field.fileHint === 'cover_letter' ? files.coverLetter : field.fileHint === 'resume' ? files.resume : value || null
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
      for (const w of wanted) {
        const picked = pickOption(field.options, w)
        const i = picked ? field.options.indexOf(picked) : -1
        if (i !== -1) await checkInput(frame, field.optionIds[i])
      }
      return
    }
    case 'checkbox': {
      if (value === 'true') await checkInput(frame, field.jpId)
      else await frame.locator(sel(field.jpId)).uncheck({ force: true }).catch(() => {})
      return
    }
    case 'combobox': {
      await loc.click()
      await loc.fill(value.slice(0, 40))
      await frame.waitForTimeout(450)
      const option = frame.locator('[role="option"]', { hasText: value }).first()
      if (await option.isVisible().catch(() => false)) await option.click()
      else await loc.press('Enter')
      return
    }
    default: {
      await loc.fill(value)
    }
  }
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
    try {
      await fillOne(frame, field, answer, files)
    } catch (err) {
      failures.push({ label: field.label || field.key, reason: (err as Error).message.split('\n')[0] })
    }
  }
  await page.waitForTimeout(300)
  return failures
}
