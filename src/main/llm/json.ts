import type { z } from 'zod'

/** Pulls the first JSON object or array out of a model reply, ignoring code fences and chatter. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start === -1) throw new Error('No JSON found in the reply.')
  const open = body[start]
  const close = open === '{' ? '}' : ']'
  // Walk forward tracking depth so trailing prose after the JSON is ignored.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return JSON.parse(body.slice(start, i + 1))
    }
  }
  throw new Error('The JSON in the reply is incomplete.')
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

export function parseWithSchema<T>(text: string, schema: z.ZodType<T>): ParseOutcome<T> {
  let data: unknown
  try {
    data = extractJson(text)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  const result = schema.safeParse(data)
  if (result.success) return { ok: true, value: result.data }
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') }
}

/** Instructions appended to a prompt when the provider can't enforce a schema itself. */
export function jsonInstructions(schemaJson: unknown): string {
  return [
    'Reply with one JSON value and nothing else. No code fences, no commentary.',
    'It must match this JSON Schema:',
    JSON.stringify(schemaJson)
  ].join('\n')
}
