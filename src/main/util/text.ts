// Small text helpers shared by the pipeline and the writing code.

const BOILERPLATE = [
  /equal (?:employment )?opportunity/i,
  /reasonable accommodation/i,
  /without regard to (?:race|age|sex)/i,
  /e-verify/i,
  /privacy (?:notice|policy)/i,
  /background check/i,
  /pay transparency/i,
  /applicants? (?:with|requiring) disabilit/i,
  /we do not accept unsolicited/i,
  /recruitment agenc/i
]

/**
 * Shortens a job description for a prompt. Legal and EEO paragraphs go first,
 * since they cost tokens and never change a fit score or a cover letter.
 */
export function trimDescription(text: string, maxChars: number): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const kept = paragraphs.filter((p) => !BOILERPLATE.some((re) => re.test(p)))
  let out = kept.join('\n\n')
  if (out.length <= maxChars) return out
  out = out.slice(0, maxChars)
  const lastBreak = Math.max(out.lastIndexOf('\n'), out.lastIndexOf('. '))
  return `${out.slice(0, lastBreak > maxChars * 0.7 ? lastBreak + 1 : maxChars).trim()}\n[posting shortened]`
}

/** Lowercases and strips punctuation so "Are you authorized to work in the US?" matches across forms. */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[*:?!.,()"'’]/g, ' ')
    .replace(/\b(please|kindly)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Word-set similarity between two normalized strings, 0 to 1. */
export function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(' ').filter(Boolean))
  const sb = new Set(b.split(' ').filter(Boolean))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}

/** Cuts text to a character limit at the last sentence end that fits. */
export function fitToLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('? '))
  return end > maxChars * 0.5 ? cut.slice(0, end + 1).trim() : cut.trim()
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? ''
}
