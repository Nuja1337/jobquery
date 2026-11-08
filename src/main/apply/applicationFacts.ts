import { EMPTY_APPLICATION_FACTS } from '@shared/defaults'
import { currencyInQuestion, isSalaryExpectationQuestion, skillFromYearsQuestion, workKindIn } from '@shared/questionTopics'
import type { ApplicationFacts, FormField, LanguageLevel, PlatformKind, Profile } from '@shared/types'
import { countryOf, currencyOf, jobCountry, regionNames } from '../util/geo'
import { relativesAnswer, referralAnswer } from './companyQuestions'
import { namedCountries, namedCountry, sameCountryName } from './countries'
import { answer, degreeRank, educationInProgress, highestDegree, isChoice, type MapContext, type MappedAnswer, pickOption, words } from './fieldMap'
import { willingnessFamily, willingnessNote } from './questionFamilies'

// Answers that come from the facts the person gave in the interview (profile.application): address,
// phone code, salary, notice period and start date, years with a skill, relocation, travel, age,
// driver's license, clearance, language levels, references and GPA. An empty fact gives a
// needs-you answer with a note, so nothing is guessed.

const plainOf = (label: string): string =>
  label
    .toLowerCase()
    .replace(/\(optional\)|\(required\)|\*|:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const needs = (note: string): MappedAnswer => ({ value: '', source: 'profile', confidence: 0, needsUser: true, note })

/** Answers with `wanted`, or asks the person when the form's options don't hold it. */
function give(field: FormField, wanted: string, confidence: number, mismatch: string, note: string | null = null): MappedAnswer {
  return answer(field, wanted, 'profile', confidence, note) ?? needs(mismatch)
}

const yesNo = (field: FormField, value: boolean | null, missing: string, confidence = 0.9): MappedAnswer =>
  value === null ? needs(missing) : give(field, value ? 'Yes' : 'No', confidence, 'The options on this question have no Yes or No. Answer it yourself.')

const hasYesNoOptions = (field: FormField): boolean =>
  field.type === 'checkbox' || (isChoice(field) && field.options.length > 0 && pickOption(field.options, 'Yes') !== null && pickOption(field.options, 'No') !== null)

const num = (n: number): string => String(Math.round(n * 100) / 100)
const thousands = (n: number): string => Math.round(n).toLocaleString('en-US')
const plural = (n: number, unit: string): string => `${num(n)} ${unit}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------------------
// Options that spell a number range: "3-5 years", "5+", "Under 100k", "2 weeks", "Immediately"
// ---------------------------------------------------------------------------

type Unit = 'day' | 'week' | 'month' | 'year'
const DAYS: Record<Unit, number> = { day: 1, week: 7, month: 30.4, year: 365 }

interface Bucket {
  lo: number
  hi: number
  unit: Unit | null
}

function unitIn(text: string): Unit | null {
  if (/\b(?:days?)\b/.test(text)) return 'day'
  if (/\b(?:weeks?|wks?)\b/.test(text)) return 'week'
  if (/\b(?:months?|mos?)\b/.test(text)) return 'month'
  if (/\b(?:years?|yrs?)\b/.test(text)) return 'year'
  return null
}

/** The range of numbers an option spells, or null when it holds none. */
function parseBucket(option: string): Bucket | null {
  const text = option.toLowerCase().replace(/[$€£]/g, '').trim()
  if (/\b(?:immediate\w*|asap|right away|now|no notice|none|n\/a)\b/.test(text) && !/\d/.test(text)) return { lo: 0, hi: 0, unit: unitIn(text) }
  const tokens = [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k)?/g)]
  if (tokens.length === 0) return null
  const values = tokens.map((t) => Number(t[1].replace(/,/g, '')) * (t[2] ? 1000 : 1))
  // "100-120k": the k belongs to both.
  if (values.length > 1 && tokens[tokens.length - 1][2] && !tokens[0][2] && values[0] < values[1] / 10) values[0] *= 1000
  const unit = unitIn(text)
  if (values.length >= 2) return { lo: Math.min(values[0], values[1]), hi: Math.max(values[0], values[1]), unit }
  const n = values[0]
  if (/\b(?:less than|under|below|fewer than|up to|max(?:imum)?|within)\b|</.test(text)) return { lo: 0, hi: n, unit }
  if (/\+|\bor more\b|\band (?:above|over|up|more)\b|\bor (?:greater|higher|over)\b|\b(?:more than|over|above|at least|minimum|min)\b|>/.test(text)) return { lo: n, hi: Infinity, unit }
  return { lo: n, hi: n, unit }
}

/**
 * The option whose range holds `value`. Values are in `unit`; an option in another unit is converted.
 * When several fit, the one that starts closest to the value wins. With `roundUp`, a value that
 * no option holds picks the smallest option above it.
 */
function pickBucket(options: string[], value: number, unit: Unit, roundUp = false): string | null {
  const parsed = options
    .map((option) => ({ option, bucket: parseBucket(option) }))
    .filter((p): p is { option: string; bucket: Bucket } => p.bucket !== null)
    .map(({ option, bucket }) => {
      const factor = bucket.unit ? DAYS[unit] / DAYS[bucket.unit] : 1
      return { option, v: value * factor, lo: bucket.lo, hi: bucket.hi }
    })
  const hits = parsed.filter((p) => p.v >= p.lo - 1e-9 && p.v <= p.hi + 1e-9)
  if (hits.length > 0) return hits.sort((a, b) => b.lo - a.lo)[0].option
  if (!roundUp) return null
  const above = parsed.filter((p) => p.lo > p.v).sort((a, b) => a.lo - b.lo)
  return above[0]?.option ?? null
}

// ---------------------------------------------------------------------------
// Address and phone code
// ---------------------------------------------------------------------------

const LINE_1 = /^(?:address(?: line)?(?: ?(?:1|one))?|street(?: address| name)?(?: ?(?:1|one))?|address \(street\)|street address(?: line)? ?(?:1|one))(?: \(.*\))?$/
const LINE_2 = /^(?:address(?: line)? ?(?:2|two)|street address(?: line)? ?(?:2|two)|apartment|apt|suite|unit|flat|building|apartment,? suite(?:,? etc\.?| or unit)?|apt\.? ?\/ ?suite|apartment ?\/ ?suite(?: ?\/ ?unit)?)(?: \(.*\))?$/
const CITY = /^(?:city|town|city ?\/ ?town|city or town|town ?\/ ?city|city of residence|current city|home city)(?: \(.*\))?$/
const REGION = /^(?:state|province|region|county|state ?\/ ?province|state or province|state ?\/ ?region|state,? province,? or region|state or region|province ?\/ ?state|state ?\/ ?province ?\/ ?region|state ?\/ ?county|prefecture|state or territory)(?: \(.*\))?$/
const POSTAL = /^(?:zip|zip code|zipcode|postal code|postcode|post code|zip ?\/ ?postal code|postal ?\/ ?zip code|zip or postal code|postal or zip code|zip ?\/ ?postcode|postal)(?: \(.*\))?$/
// A single field for the whole address.
const FULL_ADDRESS = /\b(?:your|home|mailing|residential|current|full|complete|permanent|postal)\s+(?:street\s+)?address\b|\baddress from which you (?:plan|will|intend|would)\b/
const NOT_A_HOME_ADDRESS = /\b(?:e-?mail|ip|web|url|website|company|employer|office|reference|supervisor|manager|previous|school|university|billing|wallet|linkedin|github)\b/
const PHONE_CODE = /\b(?:country code|dial(?:l?ing)? code|calling code|phone code|phone country|country dial|international (?:dial(?:l?ing)? )?code)\b/

const fullAddress = (a: ApplicationFacts['address']): string => {
  const region = [a.region, a.postalCode].map((s) => s.trim()).filter(Boolean).join(' ')
  return [a.street, a.city, region, a.country].map((s) => s.trim()).filter(Boolean).join(', ')
}

/** The trailing digits of a dial code in an option such as "United States +1", "+44", "(+49)" or "1". */
function dialDigits(option: string): string | null {
  const m = option.match(/\+\s*(\d[\d\s-]*)\)?\s*$/) ?? option.match(/^\(?\+\s*(\d[\d\s-]*)\)?(?:\s|$)/) ?? option.match(/^\(?(\d{1,4})\)?$/)
  return m ? m[1].replace(/\D/g, '') : null
}

/** Picks the option with this dial code. When several countries share it ("+1"), the profile's country decides. */
export function pickDialCode(options: string[], code: string, country: string): string | null {
  const digits = code.replace(/\D/g, '')
  if (!digits) return null
  const hits = options.filter((o) => dialDigits(o) === digits)
  if (hits.length === 0) return null
  if (hits.length === 1) return hits[0]
  const home = country ? (countryOf(country) ?? country) : ''
  if (!home) return null
  const nameOf = (o: string) => o.replace(/\s*\(?\+\s*\d[\d\s-]*\)?\s*$/, '').trim()
  // An option named exactly like the country wins over "United States Minor Outlying Islands".
  const exact = hits.filter((o) => nameOf(o).toLowerCase() === home.toLowerCase())
  if (exact.length === 1) return exact[0]
  const same = hits.filter((o) => countryOf(nameOf(o)) === home)
  return same.length === 1 ? same[0] : null
}

function addressAnswer(field: FormField, plain: string, facts: ApplicationFacts, profile: Profile): MappedAnswer | null {
  const a = facts.address
  const isText = field.type === 'text' || field.type === 'textarea'

  if (PHONE_CODE.test(plain) && !/\b(?:zip|postal|state|province)\b/.test(plain)) {
    const code = facts.phoneCountryCode.trim()
    if (isChoice(field) && field.options.length > 0) {
      if (!field.options.some((o) => dialDigits(o) !== null)) return null
      if (!code) return needs('Add your phone country code in Profile.')
      const picked = pickDialCode(field.options, code, a.country || profile.location)
      return picked ? answer(field, picked, 'profile', 0.9) : needs(`No option matches the phone code ${code}. Choose it yourself.`)
    }
    if (!code) return needs('Add your phone country code in Profile.')
    return answer(field, code.startsWith('+') ? code : `+${code}`, 'profile', 0.9)
  }

  if (!isText && !isChoice(field)) return null

  if (LINE_1.test(plain)) return a.street.trim() ? give(field, a.street.trim(), 0.9, 'Choose the address yourself.') : needs('Add your street address in Profile.')
  if (LINE_2.test(plain)) return { value: '', source: 'profile', confidence: 0, needsUser: false, note: 'Address line 2 is not in your profile.' }
  if (CITY.test(plain)) return a.city.trim() ? give(field, a.city.trim(), 0.9, 'Choose the city yourself.') : null
  if (REGION.test(plain)) {
    if (!a.region.trim()) return needs('Add your state or region in Profile.')
    if (isChoice(field) && field.options.length > 0) {
      for (const name of regionNames(a.region)) {
        const picked = pickOption(field.options, name)
        if (picked) return answer(field, picked, 'profile', 0.9)
      }
      return needs(`No option matches ${a.region}. Choose it yourself.`)
    }
    return answer(field, a.region.trim(), 'profile', 0.9)
  }
  if (POSTAL.test(plain)) return a.postalCode.trim() ? give(field, a.postalCode.trim(), 0.9, 'Enter the postal code yourself.') : needs('Add your postal code in Profile.')
  if (isText && FULL_ADDRESS.test(plain) && !NOT_A_HOME_ADDRESS.test(plain) && plain.split(' ').length <= 30) {
    const text = fullAddress(a)
    return text && (a.street.trim() || a.city.trim()) ? answer(field, text, 'profile', 0.85) : needs('Add your address in Profile.')
  }
  return null
}

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

const NOT_A_SALARY_ANSWER = /\b(?:describe|explain|tell us|job description|posting|listed|posted|offer letter|benefits|equity|bonus|comfortable|acceptable|align\w*|work for you)\b/
// Yes/no questions that ask whether a pay figure suits the person. The facts hold an expectation, not a limit.
const SALARY_JUDGMENT = /\b(?:comfortable|acceptable|align\w*|work for you|fine with|okay with|ok with|agree\w*|accept\w*)\b/
const SALARY_WORDS = /\b(?:salary|compensation|pay range|pay rate|hourly rate|base pay)\b/

function salaryJudgmentAnswer(field: FormField, plain: string): MappedAnswer | null {
  if (!hasYesNoOptions(field) || !SALARY_WORDS.test(plain) || !SALARY_JUDGMENT.test(plain) || /\b(?:describe|explain|tell us)\b/.test(plain)) return null
  return needs('This asks whether a pay figure suits you. Your profile holds an expectation, not a limit. Answer it yourself.')
}

type Period = 'hour' | 'month' | 'year'

/** How many of each period make a year. A full-time year is 2,080 hours. */
const PER_YEAR: Record<Period, number> = { year: 1, month: 12, hour: 2080 }

/** An amount paid per `from` period, written per `to` period. */
const convertPeriod = (amount: number, from: Period, to: Period): number => (amount * PER_YEAR[from]) / PER_YEAR[to]

const PERIOD_WORDS: Array<[Period, RegExp]> = [
  ['hour', /\bper hour\b|\bhourly\b|\ban hour\b|\/ ?h(?:ou)?rs?\b/],
  ['month', /\bper month\b|\bmonthly\b|\ba month\b|\bper mo\b|\/ ?(?:mo|mth|month)s?\b/],
  ['year', /\bper (?:year|annum|yr)\b|\bannual(?:ly)?\b|\byearly\b|\ba year\b|\bannum\b|\bp\.a\.|\/ ?(?:yr|year)s?\b/]
]

/** The pay periods a text names. */
function periodsIn(text: string): Period[] {
  const lower = text.toLowerCase()
  return PERIOD_WORDS.filter(([, pattern]) => pattern.test(lower)).map(([period]) => period)
}

function periodAsked(plain: string): Period | null {
  const found = periodsIn(plain)
  return found.length === 1 ? found[0] : null
}

/**
 * The option of a salary list that holds the amount. Each option is read in its own pay period
 * ("8,000+ per month", "$100+ per hour"), else in the period the question names, else in a year when
 * the entry is yearly. The amount is converted into that period first. Returns 'unclear' when an
 * option's period cannot be told, since a monthly figure compared with yearly options picks a wrong one.
 */
function pickSalaryOption(options: string[], amount: number, from: Period, labelPeriod: Period | null, atCap = false): string | null | 'unclear' {
  const cells: Array<{ option: string; lo: number; hi: number; value: number }> = []
  for (const option of options) {
    const bucket = parseBucket(option)
    if (!bucket) continue
    const own = periodsIn(option)
    if (own.length > 1) return 'unclear'
    const period = own[0] ?? labelPeriod ?? (from === 'year' ? 'year' : null)
    if (!period) return 'unclear'
    cells.push({ option, lo: bucket.lo, hi: bucket.hi, value: convertPeriod(amount, from, period) })
  }
  const hits = cells.filter((c) => c.value >= c.lo - 1e-9 && c.value <= c.hi + 1e-9)
  // The amount is the posted maximum, so an option that tops out at or under it fits better than one that starts there.
  if (atCap) {
    const under = hits.filter((c) => c.hi <= c.value + 1e-9)
    if (under.length > 0) return under.sort((a, b) => b.lo - a.lo)[0].option
  }
  return hits.length > 0 ? hits.sort((a, b) => b.lo - a.lo)[0].option : null
}

type SalaryEntry = ApplicationFacts['salary'][number]

/**
 * The top of the posted pay range, written in the entry's pay period, when the posting states a range in the
 * entry's currency and the entry's target is above it. 'flag' when the minimum does not fit under the top
 * either. Null when the range does not apply: none posted, another currency, or the target already fits.
 * The posted range is a yearly figure.
 */
function postedCap(entry: SalaryEntry, ctx: MapContext): { cap: number; max: number } | 'flag' | null {
  const max = ctx.jobSalaryMax
  const posted = ctx.jobCurrency?.trim().toUpperCase()
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0 || !posted || posted !== entry.currency.trim().toUpperCase()) return null
  const cap = convertPeriod(max, 'year', entry.period)
  const target = entry.target ?? entry.min
  if (target === null || target <= cap + 1e-9) return null
  if (entry.min === null || entry.min > cap + 1e-9) return 'flag'
  return { cap, max }
}

function salaryAnswer(field: FormField, plain: string, ctx: MapContext): MappedAnswer | null {
  if (field.type === 'checkbox' || !isSalaryExpectationQuestion(field.label) || NOT_A_SALARY_ANSWER.test(plain) || plain.split(' ').length > 22) return null
  const entries = ctx.profile.application.salary
  const country = jobCountry(ctx.jobLocation, ctx.jobCountry)
  const currency = currencyInQuestion(field.label) ?? (ctx.jobCurrency?.trim().toUpperCase() || null) ?? currencyOf(country)
  let entry = currency ? entries.find((e) => e.currency.trim().toUpperCase() === currency) : undefined
  let note: string | null = null
  let confidence = 0.9
  if (!entry) {
    if (currency) return needs(`Add your expected salary in ${currency} in Profile.`)
    if (entries.length === 0) return needs('Add your salary expectation in Profile.')
    if (entries.length > 1) return needs("Couldn't tell which currency this asks about. Answer it yourself.")
    entry = entries[0]
    note = 'Used your only salary entry. Check that the currency fits.'
    confidence = 0.7
  }
  const cur = entry.currency.trim().toUpperCase()
  const wantMin = /\b(?:minimum|at least|lowest|floor|min)\b/.test(plain)
  let lo = entry.min
  let hi = entry.target
  let single = wantMin ? (entry.min ?? entry.target) : (entry.target ?? entry.min)
  // The posting states a range in the entry's currency and the target is above its top: send the top, or flag.
  const capped = entry.answerStyle === 'negotiable' ? null : postedCap(entry, ctx)
  if (capped === 'flag') return needs('Your target is above the posted maximum and your minimum does not fit under it. Answer it yourself.')
  if (capped !== null && !wantMin) {
    hi = capped.cap
    single = capped.cap
    note = `${note ? `${note} ` : ''}Your target is above the posted maximum of ${thousands(capped.max)} ${cur} a year, so this sends the maximum.`
  }
  if (wantMin) hi = lo ?? hi
  if (lo === null) lo = single
  if (hi === null) hi = single
  const asked = periodAsked(plain)
  let period: Period = entry.period
  const entered = single
  if (asked && asked !== entry.period) {
    const conv = (n: number | null) => (n === null ? null : asked === 'hour' ? Math.round(convertPeriod(n, entry.period, asked) * 100) / 100 : Math.round(convertPeriod(n, entry.period, asked)))
    lo = conv(lo)
    hi = conv(hi)
    single = conv(single)
    period = asked
  } else if (!asked && entry.period !== 'year' && (entry.answerStyle === 'number' || field.type === 'number')) {
    return needs(`Your salary is entered per ${entry.period}. This form doesn't say which period it wants, so answer it yourself.`)
  }
  if (entry.answerStyle === 'negotiable') {
    if (field.type === 'number') return needs('This field needs a number, and you chose to answer salary questions with "negotiable".')
    return give(field, 'Negotiable, depending on the full package.', confidence, 'None of the options fit "negotiable". Choose one yourself.', note)
  }
  if (single === null) return needs('Add your salary amount in Profile.')
  if (isChoice(field) && field.options.length > 0) {
    // The amount is converted from the period it was entered in, to the period each option uses.
    const picked = pickSalaryOption(field.options, entered ?? single, entry.period, asked, capped !== null && !wantMin)
    if (picked === 'unclear') return needs(`Your salary is entered per ${entry.period}, and these options don't make clear which pay period they use. Choose one yourself.`)
    return picked ? answer(field, picked, 'profile', confidence, note) : needs('None of the salary options fit your expectation. Choose one yourself.')
  }
  if (field.type === 'number' || entry.answerStyle === 'number') return answer(field, String(single), 'profile', confidence, note)
  const perPeriod = period === 'year' ? '' : ` per ${period}`
  const first = lo ?? single
  const last = hi ?? single
  const text = first === last ? `${thousands(first)} ${cur}${perPeriod}` : `${thousands(first)} to ${thousands(last)} ${cur}${perPeriod}`
  return answer(field, text, 'profile', confidence, note)
}

// ---------------------------------------------------------------------------
// Notice period and start date
// ---------------------------------------------------------------------------

const NOTICE = /\bnotice\b/
const NOTICE_CUE = /\b(?:period|weeks?|days?|months?|how (?:much|long)|current employer|give|required|resign\w*)\b/
const NOT_NOTICE = /\b(?:privacy|legal|data|cookie|candidate|terms)\b/
const START_DATE =
  /\b(?:earliest|desired|preferred|expected|anticipated|ideal)\b.{0,20}\b(?:start|availab\w*|join\w*)|\bwhen (?:can|could|would) you (?:start|join|begin)|\bavailable to (?:start|join)|\bhow soon can you\b|\bavailable from\b|\byour (?:start|availability) date\b|\bdate (?:you are |you're )?available\b/
const NOT_START = /\b(?:end date|graduat\w*|previous|employment history|degree|school)\b/

const ASAP = ['As soon as possible', 'Immediately', 'Immediate', 'ASAP', 'Right away', 'Now']
/** The date pattern a placeholder shows, such as "MM/DD/YYYY" inside "Select date (MM/DD/YYYY)". */
const DATE_PATTERN = /\b(yyyy|yy|mm|dd)([^a-z0-9]{1,2})(yyyy|yy|mm|dd)(?:\2(yyyy|yy|mm|dd))?\b/
const looksLikeDate = (field: FormField): boolean => field.type === 'date' || DATE_PATTERN.test((field.placeholder ?? '').toLowerCase())

/** Writes a date the way the field's placeholder shows it, ISO when it shows nothing. */
export function formatDate(d: Date, hint: string | null): string {
  const y = String(d.getFullYear())
  const part: Record<string, string> = { yyyy: y, yy: y.slice(2), mm: String(d.getMonth() + 1).padStart(2, '0'), dd: String(d.getDate()).padStart(2, '0') }
  const shown = (hint ?? '').toLowerCase().match(DATE_PATTERN)
  if (!shown) return `${y}-${part.mm}-${part.dd}`
  return [shown[1], shown[3], shown[4]].filter(Boolean).map((token) => part[token]).join(shown[2])
}

function startOf(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate())
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12 }
const SPAN = /\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|eight|ten|twelve)[\s-]*(days?|weeks?|wks?|months?|mos?)\b/g
const UNIT_DAYS = { day: 1, week: 7, wk: 7, month: 30.4, mo: 30.4 } as const

/** The distinct lengths of time a text names, in days. */
function spansIn(plain: string): number[] {
  const found = new Set<number>()
  for (const m of plain.matchAll(SPAN)) {
    const n = NUMBER_WORDS[m[1]] ?? Number(m[1])
    found.add(n * UNIT_DAYS[m[2].replace(/s$/, '') as keyof typeof UNIT_DAYS])
  }
  return [...found]
}

type Compare = '<' | '<=' | '>' | '>='

/** The comparison a question states ("longer than", "within", "at least"), or null when it has none or mixes them. */
function comparatorIn(text: string): Compare | null {
  const found: Compare[] = []
  let rest = text
  const take = (re: RegExp, op: Compare) => {
    if (!re.test(rest)) return
    found.push(op)
    rest = rest.replace(re, ' ')
  }
  take(/\b(?:no longer than|not longer than|no more than|not more than|at most|up to|within|maximum(?: of)?|no later than)\b|\bor (?:less|shorter|fewer|sooner)\b/, '<=')
  take(/\b(?:shorter than|less than|under|below|fewer than)\b/, '<')
  take(/\bat least\b|\bor (?:more|longer)\b|\bminimum(?: of)?\b/, '>=')
  take(/\b(?:longer than|more than|greater than|over|exceeds?|above|in excess of)\b/, '>')
  return found.length === 1 ? found[0] : null
}

const compare = (value: number, op: Compare, limit: number): boolean =>
  op === '<' ? value < limit : op === '<=' ? value <= limit : op === '>' ? value > limit : value >= limit

const MISREAD_TIME = 'This compares a length of time in a way the app could misread. Answer it yourself.'

/** A yes/no question that compares the notice period with a length of time, or null when it names none. */
function noticeComparison(field: FormField, plain: string, weeks: number): MappedAnswer | null {
  const spans = spansIn(plain)
  if (spans.length === 0) return null
  const op = spans.length === 1 ? comparatorIn(plain) : null
  if (!op) return needs(MISREAD_TIME)
  return yesNo(field, compare(weeks * 7, op, spans[0]), 'Add your notice period in Profile.', 0.85)
}

function noticeAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  const weeks = facts.noticeWeeks
  if (weeks === null) return needs('Add your notice period in Profile.')
  if (hasYesNoOptions(field) && field.type !== 'checkbox') {
    const compared = noticeComparison(field, plain, weeks)
    if (compared) return compared
  }
  if (field.type === 'number') {
    if (/\bdays\b/.test(plain)) return answer(field, num(weeks * 7), 'profile', 0.9) ?? needs('Enter the notice period yourself.')
    if (/\bmonths\b/.test(plain)) return answer(field, num(weeks / 4.345), 'profile', 0.9) ?? needs('Enter the notice period yourself.')
    return answer(field, num(weeks), 'profile', 0.9) ?? needs('Enter the notice period yourself.')
  }
  if (isChoice(field) && field.options.length > 0) {
    if (weeks === 0) {
      for (const candidate of ['Immediately', 'Immediate', 'No notice', 'None', 'Available now']) {
        const picked = pickOption(field.options, candidate)
        if (picked) return answer(field, picked, 'profile', 0.9)
      }
    }
    const picked = pickBucket(field.options, weeks, 'week', true)
    return picked ? answer(field, picked, 'profile', 0.85) : needs('None of the options fit your notice period. Choose one yourself.')
  }
  if (weeks === 0) return give(field, 'No notice period.', 0.9, 'Enter the notice period yourself.')
  const text = /\bdays\b/.test(plain) ? plural(weeks * 7, 'day') : plural(weeks, 'week')
  return give(field, text, 0.9, 'Enter the notice period yourself.')
}

/** Days from today until the person can start: the notice period, or the earliest start date when that is later. */
function availableInDays(facts: ApplicationFacts, ctx: MapContext): number | null {
  const today = startOf(ctx.now ?? new Date())
  const given = facts.earliestStart ? startOf(new Date(`${facts.earliestStart.slice(0, 10)}T00:00:00`)) : null
  const set = given && !Number.isNaN(given.getTime()) ? given : null
  if (facts.noticeWeeks === null && !set) return null
  let days = (facts.noticeWeeks ?? 0) * 7
  if (set) days = Math.max(days, Math.round((set.getTime() - today.getTime()) / 86_400_000))
  return days
}

const START_WORDS = /\b(?:start|join|begin|available|availability|onboard\w*|commence)\b/
const START_TIMED = /\bwithin\b|\bin (?:less than|under|the next)\b|\bno later than\b|\b(?:start|join|begin)\w*\s+in\b/

/** "Can you start within 2 weeks?" compared with the notice period and the earliest start date. */
function startWithinAnswer(field: FormField, plain: string, facts: ApplicationFacts, ctx: MapContext): MappedAnswer | null {
  if (!hasYesNoOptions(field) || field.type === 'checkbox' || !START_WORDS.test(plain) || NOT_START.test(plain) || !START_TIMED.test(plain)) return null
  const spans = spansIn(plain)
  if (spans.length === 0) return null
  const days = availableInDays(facts, ctx)
  if (days === null) return needs('Add your notice period or earliest start date in Profile.')
  const op = spans.length === 1 ? (comparatorIn(plain) ?? '<=') : null
  if (!op) return needs(MISREAD_TIME)
  return yesNo(field, compare(days, op, spans[0]), 'Add your notice period or earliest start date in Profile.', 0.85)
}

function startDateAnswer(field: FormField, facts: ApplicationFacts, ctx: MapContext): MappedAnswer | null {
  const today = startOf(ctx.now ?? new Date())
  const given = facts.earliestStart ? startOf(new Date(`${facts.earliestStart.slice(0, 10)}T00:00:00`)) : null
  // With no notice period and no start date there is nothing to answer from.
  if (facts.noticeWeeks === null && (!given || Number.isNaN(given.getTime()))) return needs('Add your notice period or earliest start date in Profile.')
  const weeks = facts.noticeWeeks ?? 0
  let start = new Date(today.getTime() + weeks * 7 * 86_400_000)
  start = startOf(start)
  if (facts.earliestStart) {
    const set = startOf(new Date(`${facts.earliestStart.slice(0, 10)}T00:00:00`))
    if (!Number.isNaN(set.getTime()) && set > start) start = set
  }
  const soon = start.getTime() === today.getTime()
  const days = Math.round((start.getTime() - today.getTime()) / 86_400_000)
  // A date input takes ISO whatever its placeholder says. A text box follows the format its placeholder shows.
  if (looksLikeDate(field)) return answer(field, formatDate(start, field.type === 'date' ? null : field.placeholder), 'profile', 0.85)
  if (isChoice(field) && field.options.length > 0) {
    if (soon) {
      for (const candidate of ASAP) {
        const picked = pickOption(field.options, candidate)
        if (picked) return answer(field, picked, 'profile', 0.85)
      }
    }
    const picked = pickBucket(field.options, days, 'day', true)
    return picked ? answer(field, picked, 'profile', 0.8) : needs('None of the options fit your start date. Choose one yourself.')
  }
  if (soon) return give(field, 'As soon as possible.', 0.85, 'Enter the start date yourself.')
  if (facts.earliestStart && start > startOf(new Date(today.getTime() + weeks * 7 * 86_400_000))) {
    return give(field, `Available from ${formatDate(start, null)}.`, 0.85, 'Enter the start date yourself.')
  }
  return give(field, `${plural(weeks, 'week')} after an offer.`, 0.85, 'Enter the start date yourself.')
}

// ---------------------------------------------------------------------------
// Years with a skill
// ---------------------------------------------------------------------------

const SKILL_ALIASES: Record<string, string> = {
  js: 'javascript', ecmascript: 'javascript', ts: 'typescript', node: 'nodejs', reactjs: 'react', vuejs: 'vue', nextjs: 'next',
  angularjs: 'angular', golang: 'go', k8s: 'kubernetes', postgresql: 'postgres', mongo: 'mongodb', python3: 'python', py: 'python',
  csharp: 'c#', cpp: 'c++', amazonwebservices: 'aws', googlecloud: 'gcp', googlecloudplatform: 'gcp', microsoftazure: 'azure',
  ml: 'machinelearning', rubyonrails: 'rails', ror: 'rails', mssql: 'sqlserver', cicd: 'cicd', restapis: 'rest', restapi: 'rest',
  restful: 'rest', restfulapis: 'rest', springboot: 'spring', tailwindcss: 'tailwind', dotnet: 'net', aspnet: 'aspnet',
  reactnative: 'reactnative', ios: 'ios', swiftui: 'swiftui', objectivec: 'objectivec', tf: 'terraform', gql: 'graphql',
  postgres: 'postgres', sklearn: 'scikitlearn', scikitlearn: 'scikitlearn', pytorch: 'pytorch', tensorflow: 'tensorflow'
}

/** A skill name reduced to a form that "Node.js", "NodeJS" and "node" share. */
export function canonicalSkill(skill: string): string {
  const flat = skill.toLowerCase().trim().replace(/\s+(?:development|programming|framework|language|skills?)$/, '').replace(/[\s._/-]+/g, '')
  return SKILL_ALIASES[flat] ?? flat
}

/** Years for a skill, matched case-insensitively and through aliases. Undefined when the profile has none. */
export function yearsWith(skillYears: Record<string, number>, skill: string): number | undefined {
  const wanted = canonicalSkill(skill)
  for (const [key, years] of Object.entries(skillYears)) if (canonicalSkill(key) === wanted && typeof years === 'number') return years
  return undefined
}

const THRESHOLD = /(\b(?:do you have|have you (?:got|had)|are you|at least|minimum(?: of)?|over|more than|less than|fewer than|under|below|at most|no more than|not more than|maximum(?: of)?|up to)\b.*?)(\d+)\s*\+?\s*(?:or more )?(?:years?|yrs)\b/
const UPPER_LIMIT = /\b(?:less than|fewer than|under|below|at most|no more than|not more than|maximum(?: of)?|up to)$/
const UPPER_LIMIT_INCLUSIVE = /\b(?:at most|no more than|not more than|maximum(?: of)?|up to)$/
const LOWER_LIMIT = /\b(?:at least|more than|over|minimum(?: of)?|greater than)\b/

/**
 * Whether the person's years meet the limit the question states: at least, more than, less than, at
 * most and the like. Null when the wording gives a range or two limits, so the person decides.
 */
function meetsYears(plain: string, match: RegExpMatchArray, years: number): boolean | null {
  const n = Number(match[2])
  const before = match[1].trim()
  const after = plain.slice((match.index ?? 0) + match[0].length)
  if (/\b(?:between|from)\b/.test(before) || /\d\s*(?:-|–|to)$/.test(before) || /^\s*(?:-|–|to)\s*\d/.test(after)) return null
  const upper = UPPER_LIMIT.test(before)
  if (upper && LOWER_LIMIT.test(before.replace(/\b(?:no|not) more than\b/, ' '))) return null
  if (upper) return UPPER_LIMIT_INCLUSIVE.test(before) ? years <= n : years < n
  if (/^\s*(?:or (?:less|fewer|under|below)|and (?:under|below))\b/.test(after)) return years <= n
  if (/\b(?:more than|over|greater than)$/.test(before)) return years > n
  return years >= n
}

/** Words of a "how many years of experience" question that don't name a skill or a kind of work. */
const GENERIC_YEARS_WORDS = new Set([
  'how', 'many', 'years', 'year', 'of', 'total', 'overall', 'professional', 'relevant', 'work', 'working',
  'industry', 'full', 'time', 'experience', 'do', 'you', 'have', 'in', 'the', 'your', 'number', 'yrs',
  'a', 'an', 'minimum', 'maximum', 'at', 'least', 'combined', 'cumulative'
])
/** Years followed by a kind of work, with no "experience" in between: "2+ years shipping AAA titles". */
const WORK_AFTER_YEARS = /\d\s*\+?\s*(?:years?|yrs)\s+(?:(?:of|in|as|working|with)\s+)?(?:[a-z-]+\s+){0,3}?(?:shipp\w*|lead\w*|led|manag\w*|build\w*|develop\w*|work\w*|program\w*|design\w*|writ\w*|releas\w*|publish\w*|creat\w*)/
const NOT_WORK_YEARS = /\b(?:age|old|older)\b/

// Words of the lead-in that the threshold pattern takes in with the number: "do you have", "at least", "more than".
const LEAD_IN_WORDS = new Set(['do', 'you', 'have', 'got', 'had', 'are', 'at', 'least', 'minimum', 'of', 'over', 'more', 'than', 'less', 'fewer', 'under', 'below', 'most', 'no', 'not', 'maximum', 'up', 'to'])

/** The question without its number and lead-in. Words the pattern took in with the number stay when they are not part of the lead-in. */
function subjectOf(plain: string, threshold: RegExpMatchArray | null): string {
  if (!threshold) return plain
  const at = threshold.index ?? 0
  const extra = words(threshold[1]).filter((w) => !LEAD_IN_WORDS.has(w))
  return `${plain.slice(0, at)} ${extra.join(' ')} ${plain.slice(at + threshold[0].length)}`
}

/** True when the question asks for years of nothing but general experience, so the total answers it. */
function onlyGenericYears(plain: string, threshold: RegExpMatchArray): boolean {
  const rest = subjectOf(plain, threshold)
    .replace(/\b(?:or (?:more|longer|less|fewer|under|below|greater|higher|over|above)|and (?:above|over|up|more|longer|under|below)|plus)\b/g, ' ')
    .replace(/\d+/g, ' ')
  return words(rest).every((w) => GENERIC_YEARS_WORDS.has(w))
}

/** The experience facts with defaults under them, so a profile saved before they existed still reads. */
const experienceOf = (facts: ApplicationFacts): ApplicationFacts['experience'] => ({ ...EMPTY_APPLICATION_FACTS.experience, ...(facts.experience ?? {}) })
const educationOf = (facts: ApplicationFacts): ApplicationFacts['education'] => ({ ...EMPTY_APPLICATION_FACTS.education, ...(facts.education ?? {}) })

type YearsFact = 'professionalSoftware' | 'gamesIndustry' | 'teamLead' | 'peopleManagement'
const YEARS_FACT: Record<'software' | 'games_industry' | 'team_lead' | 'people_management', { fact: YearsFact; name: string }> = {
  software: { fact: 'professionalSoftware', name: 'professional software work' },
  games_industry: { fact: 'gamesIndustry', name: 'work in the games industry' },
  team_lead: { fact: 'teamLead', name: 'leading a team' },
  people_management: { fact: 'peopleManagement', name: 'managing people' }
}
const PROSE_YEARS = /\b(?:describe|tell us|explain|list|share|examples?|why|how (?:do|did|would))\b/
const KIND_FLAG = 'This asks for years in a specific kind of work. Your profile only has total years of experience. Answer it yourself.'

/**
 * A years question that names a kind of work: software, the games industry, leading a team or managing
 * people each read their own years fact. Shipping, a lead role, game development and the like have no
 * fact, so they flag. Null when the question names no kind of work.
 */
function yearsKindAnswer(field: FormField, plain: string, threshold: RegExpMatchArray | null, skill: string | null, profile: Profile): MappedAnswer | null {
  if (field.type === 'checkbox' || field.type === 'textarea' || NOT_WORK_YEARS.test(plain) || !/\b(?:years?|yrs)\b|\bhow long\b/.test(plain)) return null
  if (PROSE_YEARS.test(plain)) return null
  const found = workKindIn(subjectOf(plain, threshold))
  if (!found) return null
  if (threshold && !hasYesNoOptions(field)) return null
  if (!threshold && hasYesNoOptions(field)) return null
  if (found.kind === 'other' || found.kind === 'shipping' || !found.exact) return skill ? null : needs(KIND_FLAG)
  const { fact, name } = YEARS_FACT[found.kind]
  const years = experienceOf(profile.application)[fact]
  if (years === null || years === undefined) return needs(`Add your years of ${name} in Profile.`)
  if (threshold) {
    const meets = meetsYears(plain, threshold, years)
    if (meets === null) return needs('This question asks for a range of years. Answer it yourself.')
    return yesNo(field, meets, `Add your years of ${name} in Profile.`, 0.85)
  }
  if (isChoice(field) && field.options.length > 0) {
    const picked = pickBucket(field.options, years, 'year')
    return picked ? answer(field, picked, 'profile', 0.85) : needs(`None of the options fit ${num(years)} years. Choose one yourself.`)
  }
  if (field.type === 'number') return answer(field, num(years), 'profile', 0.9)
  return answer(field, plural(years, 'year'), 'profile', 0.9)
}

function yearsAnswer(field: FormField, plain: string, profile: Profile): MappedAnswer | null {
  const skill = skillFromYearsQuestion(field.label)
  const threshold = plain.match(THRESHOLD)
  // A skill the person gave years for answers from those years. Otherwise a kind of work reads its own fact.
  if (!skill || yearsWith(profile.application.skillYears, skill) === undefined) {
    const byKind = yearsKindAnswer(field, plain, threshold, skill, profile)
    if (byKind) return byKind
  }
  if (threshold && hasYesNoOptions(field) && (skill || /experience/.test(plain) || (WORK_AFTER_YEARS.test(plain) && !NOT_WORK_YEARS.test(plain)))) {
    if (!skill && !onlyGenericYears(plain, threshold)) {
      return needs('This asks for years in a specific kind of work. Your profile only has total years of experience. Answer it yourself.')
    }
    const years = skill ? yearsWith(profile.application.skillYears, skill) : (profile.yearsExperience ?? undefined)
    if (years === undefined) return needs(skill ? `Add your years with ${skill} in Profile.` : 'Add your years of experience in Profile.')
    const meets = meetsYears(plain, threshold, years)
    if (meets === null) return needs('This question asks for a range of years. Answer it yourself.')
    return yesNo(field, meets, 'Add your years of experience in Profile.', 0.85)
  }
  if (!skill || field.type === 'checkbox') return null
  const years = yearsWith(profile.application.skillYears, skill)
  if (years === undefined) {
    const shown = field.label.match(new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))?.[0] ?? skill
    return needs(`Add your years with ${shown} in Profile.`)
  }
  if (isChoice(field) && field.options.length > 0) {
    const picked = pickBucket(field.options, years, 'year')
    return picked ? answer(field, picked, 'profile', 0.85) : needs(`None of the options fit ${num(years)} years. Choose one yourself.`)
  }
  if (field.type === 'number') return answer(field, num(years), 'profile', 0.9)
  return answer(field, plural(years, 'year'), 'profile', 0.9)
}

// ---------------------------------------------------------------------------
// Relocation, travel, age, license, clearance
// ---------------------------------------------------------------------------

const RELOCATION = /\brelocat\w*/
const RELOCATION_CUE = /\b(?:willing|open|able|prepared|ready|happy|comfortable|consider|would you)\b/
const NOT_RELOCATION = /\b(?:assistance|support|package|reimburse\w*|stipend|need|expenses?|own cost|self-?funded)\b/
// Wording that puts the moving cost on the person. The relocation fact says nothing about paying for it.
const RELOCATION_SELF_PAID = /\b(?:your|own) (?:expenses?|costs?)\b|\bat your (?:own )?(?:expense|cost)\b|\bself-?funded\b|\bout of pocket\b|\b(?:not|no|without) (?:covered|paid|reimbursed|provided|assistance|support|reimbursement|financial)\b/

function relocationAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  // "Relocate or commute" is answered by the availability facts, which read both the commute and relocation facts.
  if (/\bcommut/.test(plain)) return null
  if (!RELOCATION.test(plain) || !RELOCATION_CUE.test(plain)) return null
  const { willing, places } = facts.relocation
  const selfPaid = RELOCATION_SELF_PAID.test(plain)
  if (selfPaid && willing !== false) return needs('This asks about relocating at your own cost. Your profile does not say whether you would. Answer it yourself.')
  // Not willing to relocate at all means No whoever pays.
  if (NOT_RELOCATION.test(plain) && !selfPaid) return null
  if (willing === null) return needs('Add whether you would relocate in Profile.')
  if (willing && places.length > 0) {
    const named = countryOf(field.label.replace(/\bus\b/g, ''))
    const listed = (p: string) => plain.includes(p.trim().toLowerCase()) || (named !== null && countryOf(p) === named)
    if (named && !places.some(listed)) return needs("This names a place that is not on your relocation list. Answer it yourself.")
  }
  return yesNo(field, willing, 'Add whether you would relocate in Profile.')
}

const TRAVEL = /\btravel\w*/
const TRAVEL_CUE = /\b(?:willing\w*|able|comfortable|open|ready|prepared|available|capable)\b/
/** Most travel, as a share of the time, each level of willingness stands for. */
const TRAVEL_MAX = { none: 0, some: 25, frequent: 75 } as const
/** The share a level is when a form lists ranges to choose from. */
const TRAVEL_PICK = { none: 0, some: 25, frequent: 50 } as const

function travelAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!TRAVEL.test(plain) || !TRAVEL_CUE.test(plain)) return null
  const level = facts.travel
  if (level === null) return needs('Add how much you would travel in Profile.')
  const pct = plain.match(/(\d+)\s*(?:%|percent)/)
  if (isChoice(field) && field.options.length > 0 && !hasYesNoOptions(field)) {
    const picked = pickBucket(field.options, TRAVEL_PICK[level], 'year')
    return picked ? answer(field, picked, 'profile', 0.8) : needs('None of the options fit your travel answer. Choose one yourself.')
  }
  if (field.type === 'number') return answer(field, String(TRAVEL_PICK[level]), 'profile', 0.8)
  if (!hasYesNoOptions(field) && field.type !== 'text' && field.type !== 'textarea') return null
  if (hasYesNoOptions(field) || /^(?:are|do|would|can)\b/.test(plain)) {
    if (pct) return yesNo(field, Number(pct[1]) <= TRAVEL_MAX[level], 'Add how much you would travel in Profile.', 0.85)
    return yesNo(field, level !== 'none', 'Add how much you would travel in Profile.', 0.85)
  }
  const text = level === 'none' ? 'No travel.' : level === 'some' ? 'Yes, occasionally.' : 'Yes, frequently.'
  return give(field, text, 0.8, 'Enter your travel answer yourself.')
}

/** Wording that puts the age limit above the person ("under 18", "younger than 18", "a minor"). */
const BELOW_AGE = /\b(?:under|younger than|below|less than|minor|underage|under-age)\b/
/** Wording that puts it below ("at least 18", "over 18", "18 or older"). */
const ABOVE_AGE = /\b(?:at least|older|over|above|or more)\b|18\+/

/** True when an age question also asks for something else, such as "18 or older and authorized to work in the US". */
function ageCompound(plain: string): boolean {
  const at = plain.search(/\b(?:18|eighteen)\b|\bminor\b|\bunder-?age\b|\b(?:legal|minimum|working) age\b|\bage of majority\b/)
  if (at < 0) return false
  const tail = plain
    .slice(at)
    .replace(/\b(?:years?(?: of age| old)?|yrs|of age|old)\b|\bor (?:older|over|above|more|younger|under|less)\b/g, ' ')
  return /\b(?:and|with|plus)\b|&/.test(tail)
}

function over18Answer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  const asksMinor = /^(?:are|is) (?:you )?(?:a )?minor\b|\bunder-?age\b/.test(plain)
  const mentions18 = /\b(?:18|eighteen)\b/.test(plain) && /\b(?:years?|age|older|over|above|at least|under|younger|below)\b|18\+/.test(plain) && !/\b(?:18|eighteen)[- ]months?\b/.test(plain)
  const legalAge = /\b(?:legal|minimum|working) age\b|\bage of majority\b/.test(plain)
  if (!mentions18 && !legalAge && !asksMinor) return null
  // A different age ("at least 21") is not what over18 says.
  if (!mentions18 && !asksMinor && /\b(?:1[0-79]|2\d|3\d)\b/.test(plain)) return null
  if (mentions18 && /\b(?:19|2\d)\b/.test(plain)) return null
  const below = BELOW_AGE.test(plain)
  if (below && ABOVE_AGE.test(plain)) return needs('This age question is worded in a way the app could misread. Answer it yourself.')
  if (ageCompound(plain)) {
    if (below || asksMinor) return needs('This age question also asks about something else. Answer it yourself.')
    // Not over 18 makes the whole statement untrue. Otherwise the other part decides, so another branch answers it.
    if (facts.over18 === false) return yesNo(field, false, 'Add whether you are over 18 in Profile.')
    if (facts.over18 === null) return needs('Add whether you are over 18 in Profile. This question also asks about something else.')
    return null
  }
  // "Are you under 18?" asks the opposite of "Are you over 18?".
  return yesNo(field, facts.over18 === null || !below ? facts.over18 : !facts.over18, 'Add whether you are over 18 in Profile.')
}

function licenseAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!/\bdriv(?:er|ing)'?s?\s+licen[cs]e\b|\bdrivers?\s+licen[cs]e\b/.test(plain.replace(/['’]/g, ''))) return null
  if (/\b(?:number|no\.?|state|expir\w*|issu\w*|class|upload|photo|copy|scan)\b/.test(plain)) return null
  // "...and are you authorized to work in the US?" is a second question the license fact cannot answer.
  if (/\b(?:authori[sz]\w*|eligib\w*|sponsor\w*|citizen\w*|visa|right to work|clearance)\b/.test(plain)) return null
  return yesNo(field, facts.driversLicense, "Add whether you have a driver's license in Profile.")
}

const CLEARANCE_LEVELS = ['top secret', 'ts/sci', 'ts', 'secret', 'confidential', 'public trust']
/** Whole-word match, so "ts" does not match inside "meets" or "secret" inside "secretary". */
const levelPattern = (level: string): RegExp => new RegExp(`(?<![a-z/])${level.replace('/', '\\/')}(?![a-z/])`)
// Public Trust is a suitability finding, not a clearance level, so it does not answer "Do you hold an active clearance?".
const PUBLIC_TRUST = /^public trust\b/i

const CLEARANCE_HISTORY = /\b(?:ever|previously|formerly|denied|revoked|suspended|lapsed|expired|had)\b/

function clearanceAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!/\bclearance\b/.test(plain) || /\b(?:police|criminal|background|medical|travel|pre-?employment|work|visa)\b.{0,15}clearance/.test(plain)) return null
  // "Have you ever held..." and "Were you denied..." ask about history, which the clearance held now does not answer.
  if (CLEARANCE_HISTORY.test(plain)) return needs('This asks about your clearance history. Answer it yourself.')
  const held = facts.clearance.trim()
  const missing = 'Add your security clearance in Profile. Enter "None" if you have none.'
  const eligible = clearanceEligibleAnswer(field, plain, facts)
  if (eligible) return eligible
  if (/\b(?:obtain|eligib\w*|able to (?:get|obtain)|willing to (?:undergo|obtain|get)|apply for|ability to)\b/.test(plain)) {
    return needs('Whether you could get a clearance is your call. Answer it yourself.')
  }
  const hasNone = /^(?:none|no|n\/a|no clearance|not applicable)$/i.test(held)
  const which = /^(?:what|which)\b|\bclearance (?:level|type)\b|\blevel of (?:security )?clearance\b|\bhighest\b.*clearance/.test(plain)
  if (/^other\b/i.test(held)) return needs('Your clearance is saved as "Other", which does not say which level. Answer it yourself.')
  if (which) {
    if (!held) return needs(missing)
    if (hasNone) return give(field, 'None', 0.9, 'Choose your clearance yourself.')
    return give(field, held, 0.9, 'None of the options match your clearance. Choose it yourself.')
  }
  if (!held) return needs(missing)
  if (hasNone) return yesNo(field, false, missing)
  const asked = CLEARANCE_LEVELS.find((l) => levelPattern(l).test(plain))
  if (asked && !held.toLowerCase().includes(asked)) return needs('This names a clearance level that differs from yours. Answer it yourself.')
  if (!asked && PUBLIC_TRUST.test(held)) return needs('Your saved clearance is Public Trust, which may not count as an active clearance here. Answer it yourself.')
  return yesNo(field, true, missing)
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

const LANGUAGE_NAMES = [
  'english', 'german', 'french', 'spanish', 'italian', 'portuguese', 'dutch', 'swedish', 'norwegian', 'danish', 'finnish', 'polish',
  'russian', 'ukrainian', 'czech', 'turkish', 'arabic', 'hebrew', 'hindi', 'bengali', 'urdu', 'chinese', 'mandarin', 'cantonese',
  'japanese', 'korean', 'vietnamese', 'thai', 'indonesian', 'greek', 'romanian', 'hungarian'
]
const LANGUAGE_NAME = new RegExp(`\\b(${LANGUAGE_NAMES.join('|')})\\b`)
const LANGUAGE_CUE = /\b(?:proficien\w*|fluen\w*|level|speak\w*|command|spoken|written|language skills?|native|bilingual|conversational|fluent)\b/
const LANGUAGE_ALIAS: Record<string, string> = { mandarin: 'chinese' }

const LEVEL_RANK: Record<LanguageLevel, number> = { basic: 1, conversational: 2, fluent: 3, native: 4 }
const LEVEL_OPTIONS: Record<LanguageLevel, string[]> = {
  basic: ['Basic', 'Elementary proficiency', 'Elementary', 'Beginner', 'Limited working proficiency', 'A2', 'A1'],
  conversational: ['Conversational', 'Intermediate', 'Professional working proficiency', 'Limited working proficiency', 'B2', 'B1'],
  fluent: ['Fluent', 'Full professional proficiency', 'Advanced', 'Proficient', 'Professional', 'C1'],
  native: ['Native', 'Native or bilingual proficiency', 'Native or bilingual', 'Bilingual', 'Mother tongue', 'C2']
}

function languageAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (/\b(?:programming|coding|code|software)\b/.test(plain) || !LANGUAGE_CUE.test(plain)) return null
  const name = plain.match(LANGUAGE_NAME)?.[1]
  if (!name) return null
  const wanted = LANGUAGE_ALIAS[name] ?? name
  const entry = Object.entries(facts.languageLevels).find(([lang]) => (LANGUAGE_ALIAS[lang.trim().toLowerCase()] ?? lang.trim().toLowerCase()) === wanted)
  const shown = name.charAt(0).toUpperCase() + name.slice(1)
  if (!entry) return needs(`Add your ${shown} level in Profile.`)
  const level = entry[1]
  if (hasYesNoOptions(field) || /^(?:do|are|can|have|would)\b/.test(plain)) {
    // "Native" and "bilingual" need the top level. Fluent, near-native and the like need fluent or better.
    const nativeAsked = /\b(?:native|bilingual|mother tongue)\b/.test(plain.replace(/\bnear[- ]native\b/g, ' '))
    const fluentAsked = /\b(?:fluen\w*|near[- ]native|full professional|business[- ]level|advanced)\b/.test(plain)
    const needed = nativeAsked ? LEVEL_RANK.native : fluentAsked ? LEVEL_RANK.fluent : LEVEL_RANK.conversational
    return yesNo(field, LEVEL_RANK[level] >= needed, `Add your ${shown} level in Profile.`)
  }
  if (isChoice(field) && field.options.length > 0) {
    for (const candidate of LEVEL_OPTIONS[level]) {
      const picked = pickOption(field.options, candidate)
      if (picked) return answer(field, picked, 'profile', 0.85)
    }
    return needs(`No option matches ${level} ${shown}. Choose it yourself.`)
  }
  return give(field, level.charAt(0).toUpperCase() + level.slice(1), 0.85, `Enter your ${shown} level yourself.`)
}

// "In which language(s) are you business fluent?" asks for the languages the person speaks, not for one language's level.
const SPOKEN_LANGUAGES =
  /\b(?:which|what|select|choose|list|name)\b[^?]{0,40}\blanguages\b[^?]{0,60}\b(?:speak|spoken|fluent|fluency|proficient|proficiency|converse|communicate)\b|\blanguages\b[^?]{0,30}\b(?:you|do you|are you)\b[^?]{0,30}\b(?:speak|fluent|proficient|converse)\b|\b(?:spoken|business|fluent) languages\b|\blanguages spoken\b/
const NOT_SPOKEN = /\b(?:programming|program|coding|code|software|scripting|markup|framework|frameworks|technical)\b/
const LANGUAGE_GROUPS = [
  ['chinese', 'mandarin'],
  ['filipino', 'tagalog'],
  ['farsi', 'persian']
]
const GENERIC_LANGUAGE_WORDS = new Set(['language', 'languages', 'sign', 'and', 'or', 'of', 'the'])

/** "German (B1)" gives "German". */
const languageNameOf = (entry: string): string => entry.replace(/\s*[([].*$/, '').replace(/\s*[-–,:].*$/, '').trim()

/** The words an option may use for a language, with its aliases ("Chinese" also reads "Mandarin"). */
function languageForms(name: string): string[] {
  const own = words(name).filter((w) => !GENERIC_LANGUAGE_WORDS.has(w))
  const forms = new Set(own)
  for (const group of LANGUAGE_GROUPS) if (own.some((w) => group.includes(w))) for (const g of group) forms.add(g)
  return [...forms]
}

/** A profile language that names a low level in brackets or after a dash ("German (B1)") is not one the person is fluent in. */
const LOW_LEVEL = /\b(?:basic|beginner|elementary|intermediate|conversational|limited|learning|a[12]|b[12])\b/i

/** Languages the person is fluent in: those rated fluent or native, or the profile's languages when none is rated. */
function fluentLanguages(profile: Profile): Array<{ name: string; level: LanguageLevel }> {
  const rated = Object.entries(profile.application.languageLevels)
  if (rated.length > 0) return rated.filter(([, level]) => level === 'fluent' || level === 'native').map(([name, level]) => ({ name: languageNameOf(name), level }))
  return profile.languages
    .filter((entry) => entry.trim() && !LOW_LEVEL.test(entry.slice(languageNameOf(entry).length)))
    .map((entry) => ({ name: languageNameOf(entry), level: 'fluent' as LanguageLevel }))
}

function spokenLanguagesAnswer(field: FormField, plain: string, profile: Profile): MappedAnswer | null {
  const text = plain.replace(/language\(s\)/g, 'languages')
  if (!SPOKEN_LANGUAGES.test(text) || NOT_SPOKEN.test(text) || !isChoice(field) || field.options.length === 0 || hasYesNoOptions(field)) return null
  const fluent = fluentLanguages(profile)
  if (fluent.length === 0) return needs('Add your languages and levels in Profile.')
  const optionsFor = (list: Array<{ name: string }>): string[] => {
    const forms = new Set(list.flatMap((l) => languageForms(l.name)))
    return field.options.filter((o) => words(o).some((w) => forms.has(w)))
  }
  const fluentOptions = optionsFor(fluent)
  if (fluentOptions.length === 0) return needs('None of the options match the languages you are fluent in. Choose them yourself.')
  const done = (value: string): MappedAnswer => ({ value, source: 'profile', confidence: 0.85, needsUser: false, note: null })
  if (field.type === 'multiselect' || field.type === 'checkboxes') return done(JSON.stringify(fluentOptions))
  // A single choice takes the native language, or the only fluent one.
  const native = optionsFor(fluent.filter((l) => l.level === 'native'))
  const single = native.length === 1 ? native : native.length === 0 && fluentOptions.length === 1 ? fluentOptions : []
  return single.length === 1 ? done(single[0]) : needs('You speak more than one of these languages. Choose the one to give yourself.')
}

// ---------------------------------------------------------------------------
// Experience with a named skill, as a yes/no question
// ---------------------------------------------------------------------------

// "Do you have demonstrated experience using C++ in the form of school, work or personal projects?"
const EXPERIENCE_WITH =
  /^(?:do you have|have you (?:got|had)|do you possess|do you hold|do you bring)\b.*?\b(?:experience|expertise|proficiency|familiarity|knowledge)\b(?: [a-z]+){0,3}? (?:using|with|in|of|on)\s+(.+)$/
// Where the skill ends and the rest of the sentence begins.
const SKILL_CLAUSE_END = /\s+(?:in the form of|in the|through|via|from|either|such as|including|as part|as a|for|at|within|during|by|whether)\b|\s+e\.g\.|\s*[(;:]/
const SKILL_NOT_NAMED = /^(?:a|an|the|any|our|your|my|this|that|these|those|some|other|working|building|developing|shipping|managing|leading)\b/

/** True when the profile lists the skill, as a skill or with years of experience. */
function knowsSkill(profile: Profile, skill: string): boolean {
  const years = yearsWith(profile.application.skillYears, skill)
  if (years !== undefined && years > 0) return true
  const wanted = canonicalSkill(skill)
  const wordsWanted = words(skill)
  const plainName = /^[\p{L}\p{N} ]+$/u.test(skill.trim()) && skill.trim().length > 2
  return profile.skills.some((s) => canonicalSkill(s) === wanted || (plainName && wordsWanted.every((w) => words(s).includes(w))))
}

/**
 * "Do you have experience using C++?" is Yes when the profile lists the skill. An unknown skill returns
 * null, so the model decides; the profile can't say the person has none.
 */
function experienceAnswer(field: FormField, plain: string, profile: Profile): MappedAnswer | null {
  if (field.type === 'checkbox' || !isChoice(field) || field.options.length === 0 || !hasYesNoOptions(field)) return null
  if (/\byears?\b|\byrs\b/.test(plain)) return null
  const rest = plain.replace(/[?!]+\s*$/, '').match(EXPERIENCE_WITH)?.[1]
  if (!rest) return null
  const phrase = rest.split(SKILL_CLAUSE_END)[0].trim()
  const skills = phrase.split(/\s*(?:,|\/|\bor\b|\band\b)\s*/).map((s) => s.trim()).filter(Boolean)
  if (skills.length === 0 || skills.length > 4 || skills.some((s) => SKILL_NOT_NAMED.test(s) || s.split(' ').length > 4)) return null
  const either = /\bor\b/.test(phrase)
  const known = either ? skills.some((s) => knowsSkill(profile, s)) : skills.every((s) => knowsSkill(profile, s))
  return known ? yesNo(field, true, '', 0.85) : null
}

// ---------------------------------------------------------------------------
// References and GPA
// ---------------------------------------------------------------------------

const REFERENCES_LABEL = /^(?:please )?(?:provide |list |include |add |enter )?(?:your |any |two |three |2 |3 )?(?:professional |personal |work |employment |character )?references?(?: \(.*\))?(?: available)?$|\breferences? (?:available|upon request|on request)\b|\b(?:provide|list|include|name)\b.{0,30}\breferences?\b/
const NOT_REFERENCES = /\b(?:referral|referred|referrer|reference (?:number|code|id|name|email|phone)|job reference|requisition|check|contact|consent|permission|may we|can we|do you have)\b/

function referencesAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (field.type !== 'text' && field.type !== 'textarea') return null
  if (!REFERENCES_LABEL.test(plain) || NOT_REFERENCES.test(plain)) return null
  const text = facts.references.trim()
  return text ? answer(field, text, 'profile', 0.85) : needs('Add your references answer in Profile.')
}

function gpaAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!/\bgpa\b|\bgrade point average\b/.test(plain)) return null
  const gpa = facts.gpa.trim()
  const threshold = plain.match(/\b(?:above|over|at least|minimum|higher than|greater than|of)\s*(\d(?:\.\d+)?)/)
  if (threshold && hasYesNoOptions(field)) {
    const value = Number(gpa.match(/\d(?:\.\d+)?/)?.[0])
    if (!gpa || Number.isNaN(value)) return needs('Add your GPA in Profile.')
    return yesNo(field, value >= Number(threshold[1]), 'Add your GPA in Profile.', 0.85)
  }
  if (!gpa) return needs('Add your GPA in Profile.')
  if (isChoice(field) && field.options.length > 0) {
    const value = Number(gpa.match(/\d(?:\.\d+)?/)?.[0])
    const picked = Number.isNaN(value) ? null : pickBucket(field.options, value, 'year')
    return picked ? answer(field, picked, 'profile', 0.8) : give(field, gpa, 0.8, 'None of the options fit your GPA. Choose one yourself.')
  }
  return answer(field, gpa, 'profile', 0.85)
}

// ---------------------------------------------------------------------------
// Citizenship
// ---------------------------------------------------------------------------

const PERMANENT = /\b(?:permanent resident|green card|lawful permanent|landed immigrant)\b/
const OTHER_CITIZENSHIP = /\b(?:dual|multiple|second|additional|another|other than|apart from|aside from|besides|in addition to|any other)\b/

// A nationality word names the country a citizenship question asks about, whatever country the job is in.
const NATIONALITIES: Record<string, string> = {
  american: 'United States', canadian: 'Canada', mexican: 'Mexico', british: 'United Kingdom', english: 'United Kingdom', scottish: 'United Kingdom', welsh: 'United Kingdom',
  german: 'Germany', french: 'France', indian: 'India', chinese: 'China', japanese: 'Japan', korean: 'South Korea', brazilian: 'Brazil', australian: 'Australia',
  irish: 'Ireland', dutch: 'Netherlands', spanish: 'Spain', italian: 'Italy', swedish: 'Sweden', polish: 'Poland', portuguese: 'Portugal', norwegian: 'Norway',
  danish: 'Denmark', finnish: 'Finland', swiss: 'Switzerland', austrian: 'Austria', belgian: 'Belgium', czech: 'Czech Republic', hungarian: 'Hungary', romanian: 'Romania',
  greek: 'Greece', turkish: 'Turkey', ukrainian: 'Ukraine', russian: 'Russia', israeli: 'Israel', egyptian: 'Egypt', nigerian: 'Nigeria', kenyan: 'Kenya',
  filipino: 'Philippines', indonesian: 'Indonesia', malaysian: 'Malaysia', thai: 'Thailand', vietnamese: 'Vietnam', pakistani: 'Pakistan', bangladeshi: 'Bangladesh',
  argentine: 'Argentina', argentinian: 'Argentina', chilean: 'Chile', colombian: 'Colombia', singaporean: 'Singapore', taiwanese: 'Taiwan', emirati: 'United Arab Emirates',
  saudi: 'Saudi Arabia', estonian: 'Estonia', lithuanian: 'Lithuania', latvian: 'Latvia', european: 'EU', eu: 'EU'
}
const EU_MEMBERS = [
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy',
  'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden'
].map((c) => c.toLowerCase())
// An adjective before "citizen" that is not a nationality, so the question is still about the named or job country.
const NOT_A_NATIONALITY = /^(?:legal|natural|naturali[sz]ed|current|full|dual|permanent|lawful|us|u|s|usa|the|a|an|your|any|and|or|u\.s\.)$/
const NATIONALITY_SHAPE = /^[a-z]+(?:ian|ish|ese|ean|ani|ali|ch|ic|ine)$/

/** The countries a citizenship question names by nationality, "EU" for the European Union, and the words it could not place. */
function nationalitiesIn(plain: string): { countries: string[]; unplaced: string[] } {
  const text = plain.replace(/\beuropean union\b/g, 'eu').replace(/\bu\.s\.?(?=\W|$)/g, 'us')
  const countries = new Set<string>()
  const unplaced: string[] = []
  for (const w of text.match(/[a-z]+/g) ?? []) {
    if (NATIONALITIES[w]) countries.add(NATIONALITIES[w])
  }
  // An unlisted nationality ("a Peruvian citizen") is not the job's country, so the answer waits for the person.
  for (const m of text.matchAll(/\b([a-z]+)\s+(?:citizens?|nationals?|permanent residents?)\b/g)) {
    const w = m[1]
    if (!NATIONALITIES[w] && !NOT_A_NATIONALITY.test(w) && NATIONALITY_SHAPE.test(w)) unplaced.push(w)
  }
  return { countries: [...countries], unplaced }
}

/**
 * "Are you a US citizen?" and "Are you a citizen or permanent resident of Canada?", answered from the
 * authorization entry for that country. `country` is the one the question names or the job is in.
 * A nationality word ("Are you a Canadian citizen?") names the country itself, never the job's.
 */
export function citizenshipAnswer(field: FormField, country: string | null, facts: ApplicationFacts): MappedAnswer | null {
  const plain = plainOf(field.label)
  // "Dual citizenship" and "a citizen of a country other than the US" ask about citizenships the
  // authorization entries do not list, so the facts cannot answer them.
  if (OTHER_CITIZENSHIP.test(plain) && /\bcitizen/.test(plain)) return needs('This asks about a second citizenship, which your profile does not record. Answer it yourself.')
  const asksCitizen = /\bcitizen(?:ship)?\b/.test(plain) && /^(?:are|is|do|have)\b/.test(plain)
  const asksPermanent = PERMANENT.test(plain)
  if ((!asksCitizen && !asksPermanent) || /\b(?:sponsor\w*|visa|authori[sz]ed|work)\b/.test(plain)) return null
  const nat = nationalitiesIn(plain)
  if (nat.unplaced.length > 0 || nat.countries.length > 1) return needs('This names a nationality the app could not match to one country. Answer it yourself.')
  if (nat.countries.length === 1) {
    // "Are you a Canadian citizen living in the US?" names two countries.
    const named = namedCountries(field.label).filter((c) => nat.countries[0] === 'EU' || countryName(c) !== countryName(nat.countries[0]))
    if (named.length > 0) return needs('This names a nationality and a country that differ. Answer it yourself.')
    return nationalityAnswer(field, nat.countries[0], asksCitizen, asksPermanent, facts)
  }
  if (!country) return null
  const entry = facts.authorization.find((e) => countryOf(e.country) === country || e.country.trim().toLowerCase() === country.toLowerCase())
  // No entry for that country: the citizenships and the other entries may still say. When they do not, the model decides, as before.
  if (!entry) {
    const fromFacts = nationalityAnswer(field, country, asksCitizen, asksPermanent, facts)
    return fromFacts.needsUser ? null : fromFacts
  }
  const yes = (asksCitizen && entry.status === 'citizen') || (asksPermanent && entry.status === 'permanent_resident')
  return yesNo(field, yes, 'Add your work authorization for this country in Profile.', 0.9)
}

/** "Are you a Canadian citizen or permanent resident?" from the owner's citizenships and the authorization entry for that country. */
function nationalityAnswer(field: FormField, nation: string, asksCitizen: boolean, asksPermanent: boolean, facts: ApplicationFacts): MappedAnswer {
  const eu = nation === 'EU'
  const inNation = (name: string): boolean => (eu ? EU_MEMBERS.includes(countryName(name)) : countryName(name) === countryName(nation))
  const citizen = citizenCountries(facts).some(inNation)
  const resident = facts.authorization.some((e) => e.status === 'permanent_resident' && inNation(e.country))
  if ((asksCitizen && citizen) || (asksPermanent && resident)) return yesNo(field, true, '', 0.9)
  // Only a citizenship list, or an entry for that country that is not "citizen", can say they are not a citizen.
  const citizenKnown = !asksCitizen || (facts.citizenships ?? []).length > 0 || facts.authorization.some((e) => inNation(e.country))
  const residentKnown = !asksPermanent || facts.authorization.length > 0
  if (citizenKnown && residentKnown) return yesNo(field, false, '', 0.9)
  return needs(asksCitizen && !citizenKnown ? 'Add your citizenships in Profile.' : 'Add your work authorization for this country in Profile.')
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

type EducationLevel = NonNullable<ApplicationFacts['education']['highestCompleted']>
const EDU_RANK: Record<EducationLevel, number> = { high_school: 1, some_college: 1, associate: 2, bachelor: 3, master: 4, doctorate: 5 }
const EDU_NAME: Record<number, string> = { 1: 'high school', 2: "associate's", 3: "bachelor's", 4: "master's", 5: 'doctorate' }

/** A question without apostrophes and the dots of abbreviations: "U.S." gives "us" and "Bachelor's" gives "bachelors". */
const squash = (plain: string): string => plain.replace(/['’‘]/g, '').replace(/(?<=\b[a-z])\./g, '')

const isYesNo = (field: FormField): boolean => field.type !== 'checkbox' && hasYesNoOptions(field)

const DEGREE_LEVELS: Array<[number, RegExp]> = [
  [5, /\b(?:phd|doctorate|doctoral|doctor of philosophy|dphil)\b/],
  [4, /\b(?:masters?|mba|msc|meng|graduate degree|advanced degree|postgraduate)\b/],
  [3, /\b(?:bachelors?|bsc|bs|ba|beng|bse|undergraduate|four year degree|4 year degree)\b/],
  [2, /\b(?:associates? degree|associates? of (?:arts|science|applied science)|aas)\b/],
  [1, /\b(?:high school|ged|secondary school)\b/]
]
// Wording that turns a degree question into something the degree fact does not answer.
const DEGREE_UNREADABLE =
  /\b(?:ever|never|not|nt|progress|pursuing|working toward|expect\w*|anticipat\w*|pending|plan\w*|willing|intend\w*|accredited|recogni[sz]ed|from an?|and|cost|waive\w*|acceptable|obtain|attain)\b/
const FIELD_STOP = /\b(?:the|a|an|of|in|degree|degrees|studies|study|program|programme|field|fields|discipline|disciplines|area|areas|subject|subjects|major|majors)\b/g
const FIELD_ALIASES: Record<string, string> = { cs: 'computer science', compsci: 'computer science', 'comp sci': 'computer science' }

const fieldKey = (text: string): string => {
  const flat = text.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const aliased = FIELD_ALIASES[flat] ?? flat
  return aliased.replace(FIELD_STOP, ' ').replace(/\s+/g, ' ').trim()
}
/** True when the listed field is the person's field or one of the fields a combined name holds. */
const fieldMatches = (listed: string, held: string): boolean => {
  const a = fieldKey(listed)
  const b = fieldKey(held)
  // "computer science and engineering" holds both "computer science" and "engineering", but "science" is not its field.
  return a !== '' && b !== '' && (a === b || b.split(' and ').some((part) => part.trim() === a))
}

/** The highest level the person holds, from the education fact first and the profile's education entries second. */
function heldLevel(profile: Profile, now: Date | undefined): number | null {
  const given = educationOf(profile.application).highestCompleted
  if (given) return EDU_RANK[given]
  const degree = highestDegree(profile, now)
  const rank = degree ? degreeRank(degree) : 0
  return rank > 0 ? rank : null
}

/**
 * True when something on the profile says the person may hold or be working toward a degree at this
 * rank or above, so a plain No could be wrong. Degrees in progress never count as earned, but they
 * are not a No either.
 */
function mayReachLevel(profile: Profile, rank: number, held: number, now: Date | undefined): boolean {
  let inProgress = false
  for (const ed of profile.education) {
    const degree = (ed.degree ?? '').trim()
    if (!degree) continue
    const r = degreeRank(degree)
    if (educationInProgress(ed, now)) {
      inProgress = true
      if (r === 0 || r >= rank) return true
    } else if (r === 0 || r > held) return true
  }
  // Enrolled in something the profile does not name: it could be this degree.
  return educationOf(profile.application).currentlyEnrolled === true && !inProgress
}

const OR_HIGHER = /\b(?:or|and) (?:higher|above|more|advanced)\b/g
const OR_EQUIVALENT = /\bor (?:equivalent|relevant|related|practical|professional|industry|work)(?: \w+)? experience\b|\bor equivalent(?: degree| education)?\b/g
const RELATED_FIELD = /\bor (?:a |an )?(?:closely |directly )?(?:related|similar|relevant|equivalent)(?: technical| quantitative| engineering)?(?: field| fields| discipline| disciplines| area)?\b/g

/** The degree level a question names, the fields it lists, and whether it leaves room for related fields or equivalent experience. */
function parseDegreeQuestion(c: string): { rank: number | null; fields: string[]; related: boolean; equivalent: boolean; clean: boolean } {
  let text = c.replace(/[?!]+\s*$/, '').replace(/\bscrum master\b/g, ' ')
  const ranks = DEGREE_LEVELS.filter(([, re]) => re.test(text)).map(([rank]) => rank)
  const equivalent = new RegExp(OR_EQUIVALENT.source).test(text)
  text = text.replace(OR_EQUIVALENT, ' ').replace(OR_HIGHER, ' ')
  for (const [, re] of DEGREE_LEVELS) text = text.replace(new RegExp(re.source, 'g'), ' ')
  text = text.replace(/\bof (?:science|arts|fine arts|engineering|applied science|business administration)\b/g, ' ').replace(/\b(?:degrees?|diploma)\b/g, ' ')
  const related = /\b(?:related|similar|relevant|closely related|equivalent)\b/.test(text)
  const intro = text.match(/\b(?:in|of)\s+(.+)$/)
  const before = (intro ? text.slice(0, intro.index) : text).replace(/\s+/g, ' ').trim()
  const fieldText = (intro?.[1] ?? '')
    .replace(RELATED_FIELD, ' ')
    .replace(/\b(?:related|similar|relevant)(?: technical)? (?:field|fields|discipline|disciplines|area)\b/g, ' ')
  const fields = fieldText.split(/\s*(?:,|\bor\b|\band\b|\/)\s*/).map((f) => f.trim()).filter((f) => fieldKey(f) !== '')
  const clean = /^(?:(?:do|does|did|have|has|are|is|you|hold|possess|a|an|the|your|completed|earned|obtained|received|graduated|with|or|s|college|university|four|year|4|post|secondary|postsecondary)\s*)*$/.test(before)
  return { rank: ranks.length > 0 ? Math.min(...ranks) : null, fields, related, equivalent, clean }
}

function degreeAnswer(field: FormField, c: string, ctx: MapContext): MappedAnswer | null {
  const parsed = parseDegreeQuestion(c)
  const generic = /\b(?:college|university|four year|4 year|post ?secondary) degree\b/.test(c) || /\b(?:a|an|any|your) degree\b/.test(c)
  if (parsed.rank === null && !generic) return null
  if (DEGREE_UNREADABLE.test(c) || !parsed.clean) return needs('This degree question is worded in a way the app could misread. Answer it yourself.')
  // A bare "degree" or "college degree" means at least a bachelor's.
  const asked = parsed.rank ?? 3
  const held = heldLevel(ctx.profile, ctx.now)
  const missing = 'Add your highest completed education in Profile.'
  if (held === null) return needs(missing)
  if (held >= asked) {
    if (parsed.fields.length === 0) return parsed.related ? needs('This asks for a related field. Answer it yourself.') : yesNo(field, true, missing, 0.85)
    const edu = educationOf(ctx.profile.application)
    const mine = [...edu.fields, ...edu.relatedFields]
    if (mine.length === 0) return needs('Add your field of study in Profile.')
    if (parsed.fields.some((listed) => mine.some((m) => fieldMatches(listed, m)))) return yesNo(field, true, missing, 0.85)
    return needs("Your field of study is not on this question's list. Answer it yourself.")
  }
  if (parsed.rank === null) return needs('This asks about a degree, and your profile shows none at the bachelor level. Answer it yourself.')
  if (parsed.equivalent) return needs('This accepts equivalent experience. Answer it yourself.')
  if (mayReachLevel(ctx.profile, asked, held, ctx.now)) return needs(`Your profile shows a ${EDU_NAME[asked]} degree that may be in progress or completed. Answer it yourself.`)
  return yesNo(field, false, missing, 0.85)
}

const ENROLLED =
  /\b(?:enrolled|studying|attending|pursuing)\b|\b(?:are you|am i)\b.{0,25}\bstudent\b|\bcurrent student\b|\bstill in (?:school|college|university)\b/
const ENROLLED_WORDS = new Set([
  'are', 'you', 'currently', 'presently', 'now', 'a', 'an', 'the', 'student', 'enrolled', 'in', 'at', 'any', 'school', 'college', 'university', 'degree', 'program',
  'programme', 'course', 'courses', 'studying', 'attending', 'pursuing', 'education', 'higher', 'post', 'postsecondary', 'secondary', 'classes', 'or', 'am', 'i', 'still', 'current'
])

function enrolledAnswer(field: FormField, c: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!ENROLLED.test(c) || !/\b(?:school|college|university|degree|program|programme|student|courses?|classes|education)\b/.test(c)) return null
  const left = words(c).filter((w) => !ENROLLED_WORDS.has(w))
  if (left.length > 0) return needs('This asks about your studies in a way the app could misread. Answer it yourself.')
  return yesNo(field, educationOf(facts).currentlyEnrolled, 'Add whether you are enrolled in Profile.')
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const GRADUATION = /\b(?:expected|anticipated|estimated|projected)\b.{0,25}\bgraduat\w*|\bwhen (?:do|will|are) you (?:expect to |plan to |anticipate )?(?:\w+ ){0,2}graduat\w*/

function graduationAnswer(field: FormField, c: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!GRADUATION.test(c) || field.type === 'textarea' || field.type === 'checkbox') return null
  const given = educationOf(facts).expectedGraduation?.trim() ?? ''
  const m = given.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return needs('Add your expected graduation date in Profile.')
  const year = m[1]
  const month = Number(m[2])
  const day = m[3] ? Number(m[3]) : null
  const yearOnly = /\byear\b/.test(c) && !/\b(?:date|month)\b/.test(c)
  const monthOnly = /\bmonth\b/.test(c) && !/\b(?:date|year)\b/.test(c)
  if (isChoice(field) && field.options.length > 0) {
    const long = MONTHS[month - 1]
    const mm = String(month).padStart(2, '0')
    const candidates = yearOnly ? [year] : monthOnly ? [long, mm, String(month)] : [`${long} ${year}`, `${long.slice(0, 3)} ${year}`, `${mm}/${year}`, `${year}-${mm}`, `${long}, ${year}`]
    for (const candidate of candidates) {
      const picked = field.options.find((o) => o.trim().toLowerCase() === candidate.toLowerCase())
      if (picked) return answer(field, picked, 'profile', 0.85)
    }
    return needs('None of the options match your expected graduation. Choose one yourself.')
  }
  if (yearOnly) return answer(field, year, 'profile', 0.85)
  if (monthOnly) return answer(field, field.type === 'number' ? String(month) : MONTHS[month - 1], 'profile', 0.85)
  if (field.type === 'number') return needs('This field needs a number, and a graduation date is not one. Answer it yourself.')
  const hint = (field.placeholder ?? '').toLowerCase()
  const dayWanted = field.type === 'date' || /\bdd\b/.test(hint)
  if (dayWanted && day === null) return needs('This asks for a day, and your expected graduation has only a month. Answer it yourself.')
  const date = new Date(Number(year), month - 1, day ?? 1)
  if (field.type === 'date') return answer(field, formatDate(date, null), 'profile', 0.85)
  if (DATE_PATTERN.test(hint)) return answer(field, formatDate(date, field.placeholder ?? null), 'profile', 0.85)
  return answer(field, day === null ? `${MONTHS[month - 1]} ${year}` : formatDate(date, null), 'profile', 0.85)
}

function educationAnswer(field: FormField, plain: string, ctx: MapContext): MappedAnswer | null {
  if (field.type === 'file') return null
  const c = squash(plain)
  const graduation = graduationAnswer(field, c, ctx.profile.application)
  if (graduation) return graduation
  if (!isYesNo(field) || !/^(?:do|does|did|have|has|are|is|am|can|could|would|will)\b/.test(c)) return null
  return enrolledAnswer(field, c, ctx.profile.application) ?? degreeAnswer(field, c, ctx)
}

// ---------------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------------

const CERT_WORD = /\b(?:certified|certifications?|certificates?)\b/
const CERT_GENERIC =
  /\b(?:do|does|did|you|have|has|hold|holds|possess|are|is|a|an|the|any|your|current|currently|valid|active|certified|certifications?|certificates?|in|of|for|as)\b/g
const CERT_UNREADABLE =
  /\b(?:ever|never|not|nt|expired?|renew\w*|lapsed|plan\w*|willing|working toward|pursuing|obtain\w*|earn|will|would|can|could|able|intend\w*|progress|studying|exam|and|relevant|required|related|preferred)\b/

/** A certification name reduced to letters and digits, so "Scrum Master" and "ScrumMaster" agree. */
const certKey = (text: string): string => text.toLowerCase().replace(CERT_GENERIC, ' ').replace(/[^a-z0-9]+/g, '')

/** The names a certification on the profile answers to: whole, without its bracketed acronym, and the acronym alone. */
function certNames(cert: string): string[] {
  const inside = [...cert.matchAll(/\(([^)]*)\)/g)].map((m) => m[1])
  const outside = cert.replace(/\([^)]*\)/g, ' ')
  return [certKey(cert), certKey(outside), ...inside.map(certKey)].filter(Boolean)
}

function certificationAnswer(field: FormField, plain: string, profile: Profile): MappedAnswer | null {
  if (!isYesNo(field)) return null
  const c = squash(plain).replace(/[?!]+\s*$/, '')
  if (!CERT_WORD.test(c) || !/^(?:do|does|did|have|has|are|is|can|could|would|will)\b/.test(c)) return null
  const certs = profile.certifications.map((s) => s.trim()).filter(Boolean)
  const unreadable = needs('This certification question is worded in a way the app could misread. Answer it yourself.')
  // "Do you have any certifications?"
  const bare = c.replace(/\b(?:do|does|you|have|has|hold|possess|any|certifications?|certificates?|professional|industry|technical)\b/g, ' ').replace(/\s+/g, ' ').trim()
  if (bare === '') return certs.length > 0 ? yesNo(field, true, '', 0.85) : needs('Add your certifications in Profile.')
  const text = c.replace(/\bor (?:equivalent|similar)(?: certification)?\b/g, ' ')
  if (CERT_UNREADABLE.test(text)) return unreadable
  if (certs.length === 0) return needs('Add your certifications in Profile.')
  const wanted = certKey(text)
  if (!wanted) return unreadable
  if (certs.some((cert) => certNames(cert).includes(wanted))) return yesNo(field, true, '', 0.85)
  return needs('Your profile does not list this certification by name. Answer it yourself.')
}

// ---------------------------------------------------------------------------
// Titles shipped
// ---------------------------------------------------------------------------

const SHIPPED = /\b(?:shipped|ship|shipping|released|published)\b/
const TITLE_WORD = /\b(?:titles?|games?)\b/
const NUMBER_WORD_VALUE: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 }
const SHIPPED_WORDS = new Set([
  'have', 'you', 'ever', 'shipped', 'ship', 'shipping', 'released', 'published', 'a', 'an', 'the', 'any', 'at', 'least', 'one', 'two', 'three', 'four', 'five',
  'or', 'more', 'than', 'title', 'titles', 'game', 'games', 'aaa', 'commercial', 'commercially', 'professionally', 'previously', 'before', 'on', 'do',
  'how', 'many', 'number', 'of', 'video', 'platform', 'platforms', 'console', 'consoles', 'mobile', 'pc', 'vr', 'web', 'to', 'market', 'is', 'there', 'multiple', 'playstation', 'xbox', 'virtual', 'reality'
])
const PLATFORM_WORDS: Array<[PlatformKind, RegExp]> = [
  ['console', /\b(?:consoles?|playstation|xbox)\b/],
  ['mobile', /\bmobile\b/],
  ['pc', /\bpc\b/],
  ['vr', /\b(?:vr|virtual reality)\b/],
  ['web', /\bweb\b/]
]

/** "Have you shipped at least one AAA title?", "How many titles have you shipped?" and "Have you shipped on console?". */
function shippedAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  const c = squash(plain).replace(/[?!]+\s*$/, '')
  const platforms = PLATFORM_WORDS.filter(([, re]) => re.test(c)).map(([kind]) => kind)
  if (field.type === 'file' || field.type === 'checkbox' || field.type === 'textarea' || !SHIPPED.test(c) || (!TITLE_WORD.test(c) && platforms.length === 0)) return null
  if (/\b(?:years?|yrs)\b|\bdescribe\b|\btell us\b|\bexplain\b|\blist\b|\bname\b|\bwhich\b|\bwhat\b/.test(c)) return null
  const asksCount = /^how many\b|^number of\b/.test(c)
  if (!asksCount && !isYesNo(field)) return null
  const unreadable = needs('This asks about the games you shipped in a way the app could misread. Answer it yourself.')
  if (words(c.replace(/\d+/g, ' ')).some((w) => !SHIPPED_WORDS.has(w))) return unreadable
  const exp = experienceOf(facts)
  const aaa = /\baaa\b/.test(c)
  if (platforms.length > 1 || (aaa && platforms.length > 0)) return unreadable
  const what = aaa ? 'AAA titles' : 'titles'

  if (asksCount) {
    if (platforms.length > 0) return unreadable
    const n = aaa ? exp.aaaTitles : exp.shippedTitles
    if (n === null || n === undefined) return needs(`Add how many ${what} you shipped in Profile.`)
    if (isChoice(field) && field.options.length > 0) {
      const picked = pickBucket(field.options, n, 'year')
      return picked ? answer(field, picked, 'profile', 0.85) : needs(`None of the options fit ${num(n)}. Choose one yourself.`)
    }
    return answer(field, String(n), 'profile', 0.9)
  }

  // "at least 3 titles", "3+ titles", "more than two games", "a title", "any game"
  const spelled = c.match(/\b(?:at least|more than) (\d+|one|two|three|four|five|a|an)\b/)
  const counted = c.match(/(\d+)\s*\+?\s*(?:or more )?(?:aaa )?(?:titles?|games?)\b/)
  let min = 1
  if (spelled) min = (Number(spelled[1]) || NUMBER_WORD_VALUE[spelled[1]]) + (/\bmore than\b/.test(spelled[0]) ? 1 : 0)
  else if (counted) min = Number(counted[1])
  else if (/\bmultiple\b/.test(c)) min = 2

  if (platforms.length === 1) {
    if (min > 1) return unreadable
    if (exp.platforms.includes(platforms[0])) return yesNo(field, true, '', 0.85)
    if (exp.shippedTitles === 0) return yesNo(field, false, '', 0.85)
    if (exp.platforms.length > 0) return yesNo(field, false, '', 0.8)
    return needs('Add the platforms you shipped on in Profile.')
  }
  const count = aaa ? exp.aaaTitles : exp.shippedTitles
  if (count === null || count === undefined) {
    if (exp.shippedTitles === 0) return yesNo(field, false, '', 0.85)
    return needs(`Add how many ${what} you shipped in Profile.`)
  }
  return yesNo(field, count >= min, '', 0.85)
}

// ---------------------------------------------------------------------------
// Authorization: export control, immigration, citizenships, visa types, any employer
// ---------------------------------------------------------------------------

const withoutBrackets = (text: string): string => text.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ')
const US_PERSON = /\b(?:us|united states) persons?\b/
const NON_US_PERSON = /\bforeign persons?\b|\bnon ?-?(?:us|united states) persons?\b/
const US_PERSON_GUARD =
  /\b(?:and|sponsor\w*|authori[sz]ed|willing|able|clearance|ever|will|would|can|could|not|never|require\w*|need|eligible|license|access)\b/

function exportControlAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  const gap = needs(willingnessNote('export_control'))
  if (!isYesNo(field)) return gap
  const c = withoutBrackets(squash(plain)).replace(/[?!]+\s*$/, '').trim()
  const foreign = NON_US_PERSON.test(c)
  const rest = c.replace(NON_US_PERSON, ' ')
  if (!US_PERSON.test(rest) && !foreign) return gap
  if (!/^(?:are you|is|am i)\b/.test(c) || US_PERSON_GUARD.test(rest) || (foreign && US_PERSON.test(rest))) return gap
  const fact = facts.exportControlUsPerson
  if (fact === null || fact === undefined) return gap
  return yesNo(field, foreign ? !fact : fact, '', 0.9)
}

/** A country as a comparable name: "USA" and "United States" agree. */
const countryName = (text: string): string => (countryOf(text) ?? text.trim()).toLowerCase()

/** The countries the person is a citizen of: the citizenships fact and the authorization entries marked citizen. */
function citizenCountries(facts: ApplicationFacts): string[] {
  const names = [...(facts.citizenships ?? []), ...facts.authorization.filter((e) => e.status === 'citizen').map((e) => e.country)]
  return [...new Set(names.map(countryName).filter(Boolean))]
}

const DUAL_WORDS = /\b(?:dual|multiple|more than one|second|additional|another|any other|other than|apart from|aside from|besides|in addition to|excluding|except)\b/
const OTHER_THAN = /\b(?:other than|apart from|aside from|besides|in addition to|excluding|except)\b/
const DUAL_GUARD =
  /\b(?:ever|not|nt|never|renounc\w*|plan\w*|willing|eligible|entitled|apply\w*|obtain\w*|acquir\w*|permanent|resident|green card|visa|authori[sz]ed|sponsor\w*|work)\b/

function dualCitizenshipAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  const c = squash(plain)
  if (!/\bcitizen\w*|\bnationalit\w+/.test(c) || !DUAL_WORDS.test(c) || !isYesNo(field)) return null
  // "US" in capitals names the country, and the country list reads it only next to no other country.
  const usNamed = /\b(?:US|U\.S\.|USA)(?![\w.])/.test(field.label) ? ['united states'] : []
  const named = [...new Set([...namedCountries(field.label).map(countryName), ...usNamed])]
  const unreadable = needs('This asks about citizenship in a way the app could misread. Answer it yourself.')
  if (DUAL_GUARD.test(c) || (named.length < 2 && /\band\b/.test(c))) return unreadable
  const held = citizenCountries(facts)
  const missing = 'Add your citizenships in Profile.'
  // One citizenship on the list counts as the whole list. An empty list is not an answer.
  const listed = (facts.citizenships ?? []).length > 0
  if (named.length >= 2) {
    return held.length > 0 && named.every((n) => held.includes(n)) ? yesNo(field, true, missing) : needs('This names countries that are not all on your citizenship list. Answer it yourself.')
  }
  if (named.length === 1) {
    const others = held.filter((h) => h !== named[0])
    if (OTHER_THAN.test(c)) return others.length > 0 ? yesNo(field, true, missing) : listed ? yesNo(field, false, missing) : needs(missing)
    if (held.includes(named[0]) && held.length >= 2) return yesNo(field, true, missing)
    return held.length === 1 && listed ? yesNo(field, false, missing) : needs(missing)
  }
  if (OTHER_THAN.test(c)) return needs('This asks about countries other than one the question does not name. Answer it yourself.')
  if (held.length >= 2) return yesNo(field, true, missing)
  return held.length === 1 && listed ? yesNo(field, false, missing) : needs(missing)
}

type VisaAsked = 'stem_opt' | 'opt' | 'f1' | 'h1b' | 'tn'
const VISA_GUARD =
  /\b(?:ever|previously|formerly|prior|past|used to|transfer\w*|extension|extend\w*|expir\w*|apply\w*|eligible|plan\w*|will|would|going to|switch\w*|convert\w*|change\w*|cap|lottery|approved|petition\w*|pending|filed|require\w*|need\w*|not|nt|no longer|and|sponsor\w*)\b/

/** The visa types a question names: OPT, STEM OPT, F-1, H-1B and TN. */
function visasIn(c: string): VisaAsked[] {
  const found: VisaAsked[] = []
  const stem = /\bstem[\s-]*opt\b|\bstem extension\b/.test(c)
  if (stem) found.push('stem_opt')
  const opt = /\boptional practical training\b/.test(c) || /\bopt\b(?![\s-]*(?:in|out|to|for|into)\b)/.test(c.replace(/\bstem[\s-]*opt\b/g, ' '))
  if (opt) found.push('opt')
  if (!opt && !stem && /\bf-?1\b/.test(c)) found.push('f1')
  if (/\bh-?1b\b/.test(c)) found.push('h1b')
  if (/\btn (?:visa|status|permit|nafta|professional)\b|\b(?:nafta|usmca) (?:tn|professional)\b|\b(?:on|under|via|using|hold|holding|have|has) (?:a |an |the )?tn\b/.test(c)) found.push('tn')
  return found
}

/** Whether the visa type held is the one asked about. Null when the profile does not say. */
function visaHeld(asked: VisaAsked, type: string): boolean | null {
  if (type === '') return null
  if (asked === 'h1b' || asked === 'tn') return type === asked
  if (asked === 'stem_opt') return type === 'stem_opt'
  if (asked === 'opt') return type === 'f1_opt' || type === 'stem_opt'
  // F-1 status: OPT holders are on it, H-1B and TN holders are not, and "other" could be an F-1 on campus.
  if (type === 'f1_opt' || type === 'stem_opt') return true
  return type === 'other' ? null : false
}

function visaAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  const c = squash(plain).replace(/[?!]+\s*$/, '')
  const asked = visasIn(c)
  if (asked.length === 0 || !isYesNo(field)) return null
  // A sponsorship question that names a visa is answered by the sponsorship rules.
  if (/\bsponsor\w*/.test(c)) return null
  if (/\bcpt\b|\bcurricular practical training\b/.test(c) || VISA_GUARD.test(c) || (/\bor\b/.test(c) && asked.length < 2)) {
    return needs('This asks about a visa status in a way the app could misread. Answer it yourself.')
  }
  const entry = facts.authorization.find((e) => sameCountryName(e.country, 'United States'))
  if (!entry) return needs('Add your U.S. work authorization in Profile.')
  const verdicts = asked.map((a) => (entry.status !== 'visa' ? false : visaHeld(a, entry.visaType ?? '')))
  if (verdicts.some((v) => v === true)) return yesNo(field, true, '')
  if (verdicts.every((v) => v === false)) return yesNo(field, false, '')
  return needs('Add your U.S. visa type in Profile.')
}

const ANY_EMPLOYER = /\bany (?:us |american |canadian |uk )?(?:employer|company)\b|\bunrestricted\b|\bopen work permit\b/
const ONE_EMPLOYER =
  /\b(?:specific|particular|single|one) employer\b|\bemployer[- ]specific\b|\b(?:tied|restricted|limited|bound|sponsored) (?:to|by) (?:a |an |one |your )?(?:specific |particular |single )?(?:employer|company)\b/
const EMPLOYER_GUARD = /\b(?:not|nt|never|without|except|other than|besides|no longer|ever|will|would|and|sponsor\w*)\b/

function anyEmployerAnswer(field: FormField, plain: string, ctx: MapContext): MappedAnswer | null {
  const c = squash(plain).replace(/[?!]+\s*$/, '')
  // A question about needing sponsorship is answered by the sponsorship rules, as visaAnswer does.
  // "...for any employer without sponsorship" stays here, where a permit tied to one employer makes it No.
  if (/\bsponsor\w*/.test(c) && !/\bwithout\b[^?]{0,40}\bsponsor/.test(c)) return null
  const any = ANY_EMPLOYER.test(c)
  const one = ONE_EMPLOYER.test(c)
  if ((!any && !one) || !isYesNo(field) || !/\b(?:work\w*|employ\w*|authori[sz]\w*|permit\w*|visa)\b/.test(c)) return null
  const unreadable = needs('This asks about your work authorization in a way the app could misread. Answer it yourself.')
  const country = namedCountry(field.label) ?? jobCountry(ctx.jobLocation, ctx.jobCountry)
  const entry = country ? ctx.profile.application.authorization.find((e) => sameCountryName(e.country, country)) : undefined
  const missing = 'Add your work authorization for this country in Profile.'
  if (!entry) return needs(missing)
  if (any === one) return unreadable
  const open: boolean | null = entry.status === 'citizen' || entry.status === 'permanent_resident' ? true : entry.status === 'none' ? false : (entry.anyEmployer ?? null)
  // "...for any employer without sponsorship" is two questions. A permit tied to one employer already makes it No.
  if (EMPLOYER_GUARD.test(c)) {
    // A citizen or permanent resident of that country needs no sponsorship, so Yes.
    const withoutSponsor = /\bwithout\b[^?]{0,40}\bsponsor\w*/
    if (any && (entry.status === 'citizen' || entry.status === 'permanent_resident') && withoutSponsor.test(c) && !EMPLOYER_GUARD.test(c.replace(withoutSponsor, ' '))) return yesNo(field, true, missing, 0.9)
  }
  if (EMPLOYER_GUARD.test(c)) return any && open === false && !/\b(?:not|nt|never|except|other than|no longer|ever)\b/.test(c) ? yesNo(field, false, missing) : unreadable
  if (open === null) return needs('Add whether your permit lets you work for any employer in Profile.')
  return yesNo(field, any ? open : !open, missing, 0.9)
}

const IMMIGRATION_PENDING = /\bpending\b.{0,40}\b(?:immigration|i-?485|i-?140|i-?130|petition|green card|adjustment of status|visa application)\b/

/** Export control, immigration cases, dual citizenship, visa types and working for any employer. */
function authorizationAnswer(field: FormField, plain: string, ctx: MapContext): MappedAnswer | null {
  if (field.type === 'file' || field.type === 'textarea') return null
  const family = willingnessFamily(field.label)
  const facts = ctx.profile.application
  if (family === 'export_control') return exportControlAnswer(field, plain, facts)
  const c = squash(plain)
  // A pending immigration case stays with the person. A sponsorship question that mentions one is answered by the sponsorship rules.
  if ((family === 'immigration_case' || IMMIGRATION_PENDING.test(c)) && !/\bsponsor\w*/.test(c)) return needs(willingnessNote('immigration_case'))
  return dualCitizenshipAnswer(field, plain, facts) ?? visaAnswer(field, plain, facts) ?? anyEmployerAnswer(field, plain, ctx)
}

/** "Are you eligible to obtain a security clearance?" from the clearance eligibility fact. Null when the fact or the wording gives no answer. */
function clearanceEligibleAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  const c = squash(plain).replace(/\bobtain (?:and|or) maintain\b/g, 'obtain').replace(/[?!]+\s*$/, '')
  if (!isYesNo(field) || !/^(?:are you|can you|do you qualify)\b/.test(c)) return null
  if (!/\beligib\w*|\bable to (?:get|obtain|acquire)\b|\bqualif\w*|\bcan you (?:get|obtain)\b/.test(c)) return null
  if (/\b(?:ever|denied|revoked|suspended|previously|hold|held|active|currently|and|or|citizen\w*|authori[sz]ed|resident|polygraph|willing|drug|background|criminal|not|nt|never)\b/.test(c)) return null
  const fact = facts.clearanceEligible
  if (fact === null || fact === undefined) return null
  // Eligibility for a clearance does not say a particular level.
  if (fact && CLEARANCE_LEVELS.some((l) => levelPattern(l).test(c))) return needs('This names a clearance level, and your profile says only whether you are eligible for one. Answer it yourself.')
  return yesNo(field, fact, '', 0.85)
}

// ---------------------------------------------------------------------------

/** Answers a field from the application facts, or returns null when the field is not one of their kinds. */
export function mapApplicationField(field: FormField, ctx: MapContext): MappedAnswer | null {
  if (field.type === 'file') return null
  const facts = ctx.profile.application
  const plain = plainOf(field.label)
  return (
    addressAnswer(field, plain, facts, ctx.profile) ??
    salaryJudgmentAnswer(field, plain) ??
    salaryAnswer(field, plain, ctx) ??
    startWithinAnswer(field, plain, facts, ctx) ??
    (NOTICE.test(plain) && NOTICE_CUE.test(plain) && !NOT_NOTICE.test(plain) && !START_DATE.test(plain) ? noticeAnswer(field, plain, facts) : null) ??
    (START_DATE.test(plain) && !NOT_START.test(plain) ? startDateAnswer(field, facts, ctx) : null) ??
    yearsAnswer(field, plain, ctx.profile) ??
    educationAnswer(field, plain, ctx) ??
    certificationAnswer(field, plain, ctx.profile) ??
    shippedAnswer(field, plain, facts) ??
    authorizationAnswer(field, plain, ctx) ??
    experienceAnswer(field, plain, ctx.profile) ??
    relocationAnswer(field, plain, facts) ??
    travelAnswer(field, plain, facts) ??
    over18Answer(field, plain, facts) ??
    licenseAnswer(field, plain, facts) ??
    clearanceAnswer(field, plain, facts) ??
    spokenLanguagesAnswer(field, plain, ctx.profile) ??
    languageAnswer(field, plain, facts) ??
    relativesAnswer(field, plain, facts, ctx.company, 'known') ??
    referralAnswer(field, plain, facts, 'known') ??
    referencesAnswer(field, plain, facts) ??
    gpaAnswer(field, plain, facts)
  )
}
