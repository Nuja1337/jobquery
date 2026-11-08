import { convert } from 'html-to-text'
import type { RemoteType } from '@shared/types'

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
  bull: '*',
  copy: '(c)',
  reg: '(R)',
  trade: '(TM)'
}

/** Decodes one level of HTML entities. Greenhouse sends whole HTML documents escaped this way. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Lever sends list content as bare <li> items. Without a list around them they run together
 * ("ab"), so a fragment with items and no list gets one.
 */
function wrapBareListItems(html: string): string {
  if (!/<li[\s>]/i.test(html) || /<(?:ul|ol)[\s>]/i.test(html)) return html
  return `<ul>${html}</ul>`
}

/** Turns an HTML fragment into readable plain text with paragraph breaks. */
export function htmlToPlain(html: string): string {
  if (!html) return ''
  const text = convert(wrapBareListItems(html), {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
      { selector: 'h5', options: { uppercase: false } },
      { selector: 'h6', options: { uppercase: false } }
    ]
  })
  return tidyText(text)
}

/** Collapses runs of blank lines and trailing spaces. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** For APIs that send HTML inside an escaped string (Greenhouse). */
export function escapedHtmlToPlain(escaped: string): string {
  return htmlToPlain(decodeEntities(escaped))
}

// ---------------------------------------------------------------------------
// Remote, hybrid or on-site
// ---------------------------------------------------------------------------

/** "Remote" in front of these words names a thing, not a place to work from. */
const REMOTE_WORD = /\bremote\b(?![- ]+(?:sensing|sensors?|controls?|controller|desktop|access|procedures?|execution|attestation|rendering|viewer)\b)/
/**
 * "Distributed" alone is part of too many titles ("Distributed Systems Engineer"). It counts when it
 * describes the team or the company, or when it is the whole location.
 */
const DISTRIBUTED_WORK = /\bdistributed[- ](?:first|teams?|workforce|company|workplace|work|organi[sz]ation)\b|^\s*distributed\s*(?:$|[-–,(])|\(distributed\)/

/** Reads a short string such as a location, a title or an ATS workplace field. */
export function detectRemote(text: string | null | undefined): RemoteType {
  if (!text) return 'unknown'
  const t = text.toLowerCase()
  if (/\bhybrid\b/.test(t)) return 'hybrid'
  if (REMOTE_WORD.test(t) || /\bwork from home\b|\bwfh\b|\banywhere\b|\bworldwide\b/.test(t) || DISTRIBUTED_WORK.test(t)) return 'remote'
  if (/\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b/.test(t)) return 'onsite'
  return 'unknown'
}

/** Looks for explicit statements in a long description. Stays quiet unless the wording is clear. */
export function remoteFromDescription(description: string): RemoteType {
  const head = description.slice(0, 4000).toLowerCase()
  if (
    /\bhybrid (?:work|role|position|model|schedule|environment|setup|arrangement|working)\b|\bthis is a hybrid\b|\b\d\s*days? (?:a|per|each) week (?:in|at|from) the (?:office|hq)\b/.test(
      head
    )
  ) {
    return 'hybrid'
  }
  if (
    /\b(?:fully|100%|completely|entirely)[- ]remote\b|\bremote[- ]first\b|\bthis is a remote\b|\bwork from anywhere\b|\bremote[- ]friendly\b/.test(
      head
    )
  ) {
    return 'remote'
  }
  if (/\bon[- ]?site (?:role|position|only)\b|\bin[- ]office (?:role|position)\b/.test(head)) return 'onsite'
  return 'unknown'
}

/** First known answer wins: the ATS field, then the location, then the title, then the description. */
export function inferRemote(parts: { explicit?: string | null; location?: string | null; title?: string | null; description?: string }): RemoteType {
  for (const text of [parts.explicit, parts.location, parts.title]) {
    const found = detectRemote(text)
    if (found !== 'unknown') return found
  }
  return parts.description ? remoteFromDescription(parts.description) : 'unknown'
}

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

export interface SalaryRange {
  min: number
  max: number
  currency: string | null
}

const CURRENCY_CODES = 'USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|INR|SGD|JPY|BRL|MXN'
const SYMBOL = String.raw`[$£€]|C\$|A\$|CA\$|AU\$|` + CURRENCY_CODES
const RANGE_RE = new RegExp(
  String.raw`(?<c1>${SYMBOL})?\s?(?<a>\d[\d.,]*)\s?(?<ka>[kK])?\s?(?:-|–|—|to)\s?(?<c2>${SYMBOL})?\s?(?<b>\d[\d.,]*)\s?(?<kb>[kK])?(?<tail>[^\n]{0,40})`,
  'g'
)
const SINGLE_RE = new RegExp(String.raw`(?<c1>[$£€]|${CURRENCY_CODES})\s?(?<a>\d[\d.,]*)\s?(?<ka>[kK])?(?<tail>[^\n]{0,40})`, 'g')

function symbolToCurrency(symbol: string | undefined): string | null {
  if (!symbol) return null
  const s = symbol.toUpperCase()
  if (s === '$') return 'USD'
  if (s === '£') return 'GBP'
  if (s === '€') return 'EUR'
  if (s === 'C$' || s === 'CA$') return 'CAD'
  if (s === 'A$' || s === 'AU$') return 'AUD'
  return s
}

/** Reads "211,400", "211.4", "35,3" (decimal comma) or "70.000" (thousands dot). Returns null if it isn't a number. */
function parseAmount(raw: string, hasK: boolean): number | null {
  const cleaned = raw.replace(/[.,]+$/, '')
  if (!cleaned) return null
  let n: number
  if (/^\d{1,3}([.,]\d{3})+$/.test(cleaned)) n = Number(cleaned.replace(/[.,]/g, ''))
  else if (/^\d+[.,]\d{1,2}$/.test(cleaned)) n = Number(cleaned.replace(',', '.'))
  else n = Number(cleaned.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  return hasK ? n * 1000 : n
}

type Period = 'year' | 'hour' | 'month' | 'other' | null

function periodFrom(tail: string): Period {
  const t = tail.toLowerCase()
  if (/^\s*(?:\/|per|an?|each)?\s*(?:hour|hr)\b|^\s*\/\s*h\b|\bhourly\b/.test(t)) return 'hour'
  if (/^\s*(?:\/|per|a|each)?\s*(?:month|mo)\b|\bmonthly\b/.test(t)) return 'month'
  if (/^\s*(?:\/|per|a|each)?\s*(?:year|yr|annum)\b|\bannual|\bp\.?a\.?\b/.test(t)) return 'year'
  if (/^\s*(?:\/|per|a|each)?\s*(?:week|day|task|project|word|page|post|article)\b/.test(t)) return 'other'
  return null
}

function toYearly(min: number, max: number, period: Period): { min: number; max: number } | null {
  if (period === 'other') return null
  let factor = 1
  if (period === 'hour') {
    if (min < 5 || max > 1000) return null
    factor = 2080
  } else if (period === 'month') {
    if (min < 500 || max > 100_000) return null
    factor = 12
  } else if (min < 1000) {
    // A bare "50-75" could be anything. Only trust it when a period says so.
    return null
  }
  const lo = Math.round(min * factor)
  const hi = Math.round(max * factor)
  if (lo < 10_000 || hi > 3_000_000) return null
  return { min: lo, max: hi }
}

function currencyHint(text: string, found: string | null): string | null {
  if (found !== 'USD') return found
  if (/\b(?:CAD|CA\$|C\$)/.test(text)) return 'CAD'
  if (/\b(?:AUD|AU\$|A\$)/.test(text)) return 'AUD'
  return found
}

/**
 * Matches of a pay pattern. The next search starts where the numbers end, so the tail text of one
 * match (".. Salary $110,000 - $140,000") is still searched for the next one.
 */
function* amountMatches(re: RegExp, text: string): Generator<RegExpExecArray> {
  const scan = new RegExp(re.source, re.flags)
  let m: RegExpExecArray | null
  while ((m = scan.exec(text))) {
    yield m
    scan.lastIndex = Math.max(m.index + 1, m.index + m[0].length - (m.groups?.tail?.length ?? 0))
  }
}

const EXTRA_PAY_WORDS = 'bonus|relocation|relocating|sign(?:ing)?[- ]?on|stipend|allowance|commission|equity|stock|rsus?|referral|retention|incentive|reimbursement'
/** Money named just before the amount: "relocation bonus of up to $5,000 - $10,000". */
const EXTRA_BEFORE = new RegExp(`(?:${EXTRA_PAY_WORDS})(?:(?!salary|base|pay\\b|compensation|wage)[^.\\n;]){0,30}$`, 'i')
/** Money named right after the amount: "$10,000 - $20,000 annual bonus". */
const EXTRA_AFTER = new RegExp(`^\\s*(?:(?:per year|annual|yearly|one-time|target|performance|cash|discretionary|total|paid|up to)\\s+){0,3}(?:${EXTRA_PAY_WORDS})(?!\\w*\\s*(?:eligib|included|potential))`, 'i')

/** True when the amount at this position is a bonus, relocation or similar payment and not the salary. */
function isExtraPay(text: string, index: number, tail: string): boolean {
  return EXTRA_BEFORE.test(text.slice(Math.max(0, index - 50), index)) || EXTRA_AFTER.test(tail)
}

/**
 * Reads a yearly pay range from a short pay field or from the text of a posting.
 * Hourly and monthly pay is converted to yearly. Returns null when nothing clear is found.
 * Without a currency symbol or code a range is accepted only in a pay field (`fieldOnly: true`).
 */
export function parseSalary(text: string | null | undefined, options: { defaultCurrency?: string | null; fieldOnly?: boolean } = {}): SalaryRange | null {
  if (!text) return null
  const fieldOnly = options.fieldOnly ?? false
  for (const m of amountMatches(RANGE_RE, text)) {
    const g = m.groups!
    if (isExtraPay(text, m.index, g.tail ?? '')) continue
    const hasCurrency = Boolean(g.c1 || g.c2 || /^\s?(?:USD|EUR|GBP|CAD|AUD)\b/.test(g.tail ?? ''))
    if (!hasCurrency && !fieldOnly) continue
    const kb = Boolean(g.kb)
    let a = parseAmount(g.a, Boolean(g.ka))
    const b = parseAmount(g.b, kb)
    if (a === null || b === null) continue
    // "70 - 80k" means 70k to 80k.
    if (!g.ka && kb && a < 1000) a *= 1000
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const yearly = toYearly(lo, hi, periodFrom(g.tail ?? ''))
    if (!yearly) continue
    const tailCode = /^\s?(USD|EUR|GBP|CAD|AUD)\b/.exec(g.tail ?? '')?.[1]
    const currency = symbolToCurrency(g.c1 ?? g.c2) ?? tailCode ?? options.defaultCurrency ?? null
    return { ...yearly, currency: currencyHint(text, currency) }
  }
  if (!fieldOnly) return null
  for (const m of amountMatches(SINGLE_RE, text)) {
    const g = m.groups!
    if (isExtraPay(text, m.index, g.tail ?? '')) continue
    const a = parseAmount(g.a, Boolean(g.ka))
    if (a === null) continue
    const yearly = toYearly(a, a, periodFrom(g.tail ?? ''))
    if (!yearly) continue
    return { ...yearly, currency: currencyHint(text, symbolToCurrency(g.c1)) }
  }
  return null
}

/** Finds a pay range written into a posting's text. Needs a currency symbol or code to avoid matching years. */
export function findSalaryInText(description: string): SalaryRange | null {
  return parseSalary(description.slice(0, 12_000))
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Accepts ISO strings, "YYYY-MM-DD", and epoch seconds or milliseconds. Returns an ISO string or null. */
export function toIsoDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  let ms: number
  if (typeof value === 'number' || /^\d{9,13}$/.test(value)) {
    const n = Number(value)
    ms = n < 1e11 ? n * 1000 : n
  } else {
    ms = Date.parse(value)
  }
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const year = d.getUTCFullYear()
  if (year < 2000 || year > 2100) return null
  return d.toISOString()
}

/** "Senior Engineer, Cloud" and " Security Engineer " both come back tidy. */
export function cleanTitle(title: string): string {
  return decodeEntities(title).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Search queries for sources that return a whole feed
// ---------------------------------------------------------------------------

/**
 * Commas separate alternatives and words inside one alternative must all appear:
 * "react native, flutter" matches text that has both "react" and "native", or "flutter".
 * An empty query matches everything.
 */
export function matchesQuery(haystack: string, query: string | undefined): boolean {
  const groups = (query ?? '')
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean)
  if (groups.length === 0) return true
  const text = haystack.toLowerCase()
  return groups.some((g) => g.split(/\s+/).every((word) => text.includes(word)))
}
