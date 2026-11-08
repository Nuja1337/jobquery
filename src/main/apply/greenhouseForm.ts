import type { FieldType, FormField } from '@shared/types'

// Greenhouse publishes each job's application questions in its public Job Board API, so the
// app can draft every answer before a browser is opened.
// https://developers.greenhouse.io/job-board.html#retrieve-a-job

interface GhField {
  name: string
  type: string
  values?: Array<{ label: string; value: string | number }>
}

interface GhQuestion {
  label: string
  required: boolean
  description?: string | null
  fields: GhField[]
}

interface GhJobWithQuestions {
  questions?: GhQuestion[]
  location_questions?: GhQuestion[]
  compliance?: Array<{ type: string; questions: GhQuestion[] }> | null
  demographic_questions?: { questions?: Array<{ label: string; required: boolean; type: string; answer_options?: Array<{ label: string }> }> } | null
}

const EEO_LABELS: Record<string, string> = {
  gender: 'Gender',
  race: 'Race',
  hispanic_ethnicity: 'Are you Hispanic/Latino?',
  veteran_status: 'Veteran status',
  disability_status: 'Disability status'
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m
  })
}

/** The longest hint kept. A question's instruction is a sentence or two. */
export const HINT_MAX_LENGTH = 300

/** A question description from the API as one short plain line, or null when it holds no text. The API sends HTML, sometimes entity-escaped. */
export function cleanHint(raw: string | null | undefined): string | null {
  if (!raw) return null
  let text = raw
  // A description that arrives escaped decodes to markup, so strip once more after decoding.
  for (let pass = 0; pass < 2; pass++) {
    text = decodeEntities(text.replace(/<\s*\/?\s*(?:br|p|div|li|ul|ol|h\d)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''))
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > HINT_MAX_LENGTH ? `${text.slice(0, HINT_MAX_LENGTH - 1).trimEnd()}…` : text
}

function convertQuestion(q: GhQuestion): FormField | null {
  const fileField = q.fields.find((f) => f.type === 'input_file')
  const field = fileField ?? q.fields.find((f) => f.type !== 'input_hidden')
  if (!field) return null
  const label = (EEO_LABELS[field.name] ?? q.label).replace(/\s+/g, ' ').trim()
  let type: FieldType
  switch (field.type) {
    case 'input_file':
      type = 'file'
      break
    case 'textarea':
      type = 'textarea'
      break
    case 'multi_value_single_select':
      type = 'select'
      break
    case 'multi_value_multi_select':
      type = 'checkboxes'
      break
    default:
      type = field.name === 'email' ? 'email' : field.name === 'phone' ? 'tel' : 'text'
  }
  return {
    key: field.name,
    label,
    type,
    required: q.required,
    options: (field.values ?? []).map((v) => v.label.trim()),
    placeholder: null,
    maxLength: null,
    fileHint: type === 'file' ? (/cover/i.test(field.name) ? 'cover_letter' : /resume|cv/i.test(field.name) ? 'resume' : 'other') : null,
    hint: cleanHint(q.description)
  }
}

/** Converts the API's question list into form fields. Exported for tests. */
export function greenhouseFields(data: GhJobWithQuestions): FormField[] {
  const questions = [
    ...(data.questions ?? []),
    ...(data.location_questions ?? []),
    ...(data.compliance ?? []).flatMap((c) => c.questions ?? [])
  ]
  const fields: FormField[] = []
  const seen = new Set<string>()
  for (const q of questions) {
    const f = convertQuestion(q)
    if (f && !seen.has(f.key)) {
      seen.add(f.key)
      fields.push(f)
    }
  }
  for (const [i, q] of (data.demographic_questions?.questions ?? []).entries()) {
    const key = `demographic_${i}`
    fields.push({
      key,
      label: q.label,
      type: /multi/.test(q.type) ? 'checkboxes' : 'select',
      required: q.required,
      options: (q.answer_options ?? []).map((o) => o.label),
      placeholder: null,
      maxLength: null,
      fileHint: null
    })
  }
  return fields
}

/** Fetches a Greenhouse job's application questions. Returns null if the job isn't on the API. */
export async function fetchGreenhouseFields(boardToken: string, jobId: string): Promise<FormField[] | null> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(jobId)}?questions=true`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'jobpls/0.1 (+https://github.com/Nuja1337/jobpls)' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) return null
  return greenhouseFields((await res.json()) as GhJobWithQuestions)
}
