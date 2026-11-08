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

// A line that says what the job needs or where it is. These are never dropped.
const REQUIREMENT_LINE =
  /\b(?:required?|requirements?|requires|must|years|yrs?|degree|clearance|citizen\w*|located|location|relocat\w*|on-?site|hybrid|remote|visas?|sponsor\w*)\b|\d\s*\+?\s*-?\s*years?\b/i

// The same words, minus the ones that show up in every equal-opportunity statement ("citizenship status").
const HARD_REQUIREMENT_LINE =
  /\b(?:required?|requires|must|years|yrs?|degree|clearance|located|relocat\w*|on-?site|visas?|sponsor\w*)\b|\d\s*\+?\s*-?\s*years?\b/i

const EEO_STATEMENT = /equal (?:employment )?opportunity|without regard to|regardless of/i

const BULLET = /^\s*(?:[-*•·▪‣◦–]|\d{1,2}[.)])\s+/

type SectionRank = 0 | 1 | 2 // 0 keep first, 1 neutral, 2 keep last

const HIGH_HEADER =
  /^(?:requirements?|qualifications?|responsibilit(?:y|ies)|duties|skills|experience|location|where|must[- ]haves?|minimum|preferred|nice[- ]to[- ]haves?|bonus|the (?:role|job|position)|role (?:overview|summary)|job (?:description|summary)|in this role|about (?:you|the (?:role|job|position)|this (?:role|job|position))|who you are|what (?:you(?:'|’)?(?:ll| will)|you) (?:do|need|bring|have|be doing)|what we(?:'|’)?re looking for|what we are looking for|you(?:'|’)?(?:ll| will) (?:do|need|have|bring)|you have|your (?:role|day|responsibilit)|work(?:ing)? (?:location|arrangement|model|environment)|on-?site|hybrid|remote)\b/i

const LOW_HEADER =
  /^(?:about (?:us|the company|[A-Z])|who we are|our (?:mission|story|values|culture|team|company)|the company|company (?:overview|description)|benefits|perks|what we offer|why (?:join|work|you)|life at|diversity|equal opportunity|how to apply|compensation (?:and|&) benefits|additional information)\b/i

/** Returns the section rank when the line reads as a heading, otherwise null. */
function headerRank(line: string): SectionRank | null {
  const t = line.trim()
  if (!t || t.length > 70 || BULLET.test(t) || /[.!?]$/.test(t)) return null
  const bare = t.replace(/^#{1,6}\s*/, '').replace(/^\*\*(.*?)\*\*:?$/, '$1').replace(/:$/, '').trim()
  if (!bare || bare.split(/\s+/).length > 8) return null
  if (HIGH_HEADER.test(bare)) return 0
  if (LOW_HEADER.test(bare)) return 2
  if (/^#{1,6}\s/.test(t) || /:$/.test(t) || /^\*\*.*\*\*:?$/.test(t)) return 1
  return null
}

interface Line {
  text: string
  blankBefore: boolean
  header: boolean
  rank: SectionRank
  section: number
  bullet: boolean
}

/** Turns <br> and block tags into line breaks and closes any triple quote, so a posting can't end the prompt's quote block. */
function normalizePosting(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(?:p|div|ul|ol|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\s*\/?\s*li\b[^>]*>/gi, '\n')
    .replace(/<\s*(?:p|div|ul|ol|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/"{3,}/g, '"')
}

function parseLines(text: string): Line[] {
  const lines: Line[] = []
  let blank = false
  let rank: SectionRank = 1
  let section = 0
  for (const raw of normalizePosting(text).split('\n')) {
    const t = raw.trim()
    if (!t) {
      blank = true
      continue
    }
    const hr = headerRank(t)
    if (hr !== null) {
      section++
      rank = hr
    }
    lines.push({ text: t, blankBefore: blank, header: hr !== null, rank, section, bullet: BULLET.test(t) })
    blank = false
  }
  return lines
}

function isProtected(text: string): boolean {
  if (EEO_STATEMENT.test(text)) return HARD_REQUIREMENT_LINE.test(text)
  return REQUIREMENT_LINE.test(text)
}

/** Legal and EEO text for one line. Long lines are cut into sentences so a requirement next to a legal sentence survives. */
function stripBoilerplate(line: Line): string | null {
  const t = line.text
  if (!BOILERPLATE.some((re) => re.test(t))) return t
  // A list item under Requirements or Qualifications is a requirement, even an E-Verify one.
  if (line.rank === 0 && line.bullet) return t
  if (t.length > 160) {
    const kept = t
      .split(/(?<=[.!?])\s+/)
      .filter((s) => !BOILERPLATE.some((re) => re.test(s)) || isProtected(s))
    return kept.length ? kept.join(' ') : null
  }
  return isProtected(t) ? t : null
}

function render(lines: Line[]): string {
  let out = ''
  for (const l of lines) out += out ? (l.blankBefore ? '\n\n' : '\n') + l.text : l.text
  return out
}

const SHORTENED = '[posting shortened]'

/**
 * Shortens a job description for a prompt. Legal and EEO lines go first, since they cost tokens and never change a fit
 * score or a cover letter. Lines that state a requirement or a location always stay. When the text is still over
 * budget, Requirements, Qualifications, Location and Responsibilities sections stay ahead of About and Benefits.
 */
export function trimDescription(text: string, maxChars: number): string {
  const all = parseLines(text)
  const stripped: Line[] = []
  for (const l of all) {
    const t = stripBoilerplate(l)
    if (t) stripped.push(t === l.text ? l : { ...l, text: t })
  }
  const fullLength = render(all).length
  // When most of the posting looks like legal text, the filter is probably wrong. Keep everything.
  const lines = fullLength > 0 && render(stripped).length < fullLength / 2 ? all : stripped
  const whole = render(lines)
  if (whole.length <= maxChars) return whole

  const budget = Math.max(0, maxChars - SHORTENED.length - 1)
  // Lower number is kept first. A requirement line in a weaker section still beats that section's other lines.
  const priority = (l: Line): number => (l.rank === 0 ? 0 : isProtected(l.text) ? 1 : l.rank + 1)
  const order = lines.map((_, i) => i).sort((a, b) => priority(lines[a]) - priority(lines[b]) || a - b)
  const chosen = new Set<number>()
  let used = 0
  for (const i of order) {
    const cost = lines[i].text.length + 2
    if (used + cost > budget) continue
    chosen.add(i)
    used += cost
  }
  // Headings only help when something under them survived.
  const withBody = new Set<number>()
  for (const i of chosen) if (!lines[i].header) withBody.add(lines[i].section)
  let picked = lines.filter((l, i) => chosen.has(i) && (!l.header || withBody.has(l.section)))
  if (picked.length === 0 && lines.length) {
    // One line longer than the whole budget. Cut it at a word.
    const first = lines[order[0]]
    const cut = first.text.slice(0, budget)
    picked = [{ ...first, text: cut.replace(/\s+\S*$/, '') || cut }]
  }
  return `${render(picked)}\n${SHORTENED}`
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

/**
 * Cuts text to a character limit at the last sentence end that fits, or returns null when not even the first
 * sentence fits. Never cuts mid-word. A sentence that ends exactly at the limit counts.
 */
export function fitWholeSentences(text: string, maxChars: number): string | null {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return null
  let end = -1
  const re = /[.!?]["')\]”’]*(?=\s|$)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const stop = m.index + m[0].length
    if (stop > maxChars) break
    // "e.g." and "Dr." end no sentence.
    const word = /(\S+)$/.exec(text.slice(0, m.index + 1))?.[1] ?? ''
    if (/^(?:e\.g|i\.e|vs|mr|mrs|ms|dr|st)\.$/i.test(word) && stop < text.length) continue
    end = stop
  }
  return end > 0 ? text.slice(0, end).trimEnd() : null
}
