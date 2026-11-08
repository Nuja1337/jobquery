import { currencyInQuestion, isSalaryExpectationQuestion, skillFromYearsQuestion } from '@shared/questionTopics'
import type { ApplicationFacts, FormField, LanguageLevel, Profile } from '@shared/types'
import { countryOf, currencyOf, jobCountry, regionNames } from '../util/geo'
import { relativesAnswer, referralAnswer } from './companyQuestions'
import { answer, isChoice, type MapContext, type MappedAnswer, pickOption, words } from './fieldMap'

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

const NOT_A_SALARY_ANSWER = /\b(?:describe|explain|tell us|job description|posting|listed|posted|offer letter|benefits|equity|bonus)\b/

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
function pickSalaryOption(options: string[], amount: number, from: Period, labelPeriod: Period | null): string | null | 'unclear' {
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
  return hits.length > 0 ? hits.sort((a, b) => b.lo - a.lo)[0].option : null
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
  if (wantMin) hi = lo ?? hi
  let single = wantMin ? (entry.min ?? entry.target) : (entry.target ?? entry.min)
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
    const picked = pickSalaryOption(field.options, entered ?? single, entry.period, asked)
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

function noticeAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  const weeks = facts.noticeWeeks
  if (weeks === null) return needs('Add your notice period in Profile.')
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

function yearsAnswer(field: FormField, plain: string, profile: Profile): MappedAnswer | null {
  const skill = skillFromYearsQuestion(field.label)
  const threshold = plain.match(THRESHOLD)
  if (threshold && hasYesNoOptions(field) && (skill || /experience/.test(plain))) {
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
const NOT_RELOCATION = /\b(?:assistance|support|package|reimburse\w*|stipend|need)\b/

function relocationAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!RELOCATION.test(plain) || !RELOCATION_CUE.test(plain) || NOT_RELOCATION.test(plain)) return null
  const { willing, places } = facts.relocation
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
  // "Are you under 18?" asks the opposite of "Are you over 18?".
  return yesNo(field, facts.over18 === null || !below ? facts.over18 : !facts.over18, 'Add whether you are over 18 in Profile.')
}

function licenseAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!/\bdriv(?:er|ing)'?s?\s+licen[cs]e\b|\bdrivers?\s+licen[cs]e\b/.test(plain.replace(/['’]/g, ''))) return null
  if (/\b(?:number|no\.?|state|expir\w*|issu\w*|class|upload|photo|copy|scan)\b/.test(plain)) return null
  return yesNo(field, facts.driversLicense, "Add whether you have a driver's license in Profile.")
}

const CLEARANCE_LEVELS = ['top secret', 'ts/sci', 'ts', 'secret', 'confidential', 'public trust']

function clearanceAnswer(field: FormField, plain: string, facts: ApplicationFacts): MappedAnswer | null {
  if (!/\bclearance\b/.test(plain) || /\b(?:police|criminal|background|medical|travel|pre-?employment|work|visa)\b.{0,15}clearance/.test(plain)) return null
  const held = facts.clearance.trim()
  const missing = 'Add your security clearance in Profile. Enter "None" if you have none.'
  if (/\b(?:obtain|eligib\w*|able to (?:get|obtain)|willing to (?:undergo|obtain|get)|apply for|ability to)\b/.test(plain)) {
    return needs('Whether you could get a clearance is your call. Answer it yourself.')
  }
  const hasNone = /^(?:none|no|n\/a|no clearance|not applicable)$/i.test(held)
  const which = /^(?:what|which)\b|\bclearance (?:level|type)\b|\blevel of (?:security )?clearance\b|\bhighest\b.*clearance/.test(plain)
  if (which) {
    if (!held) return needs(missing)
    if (hasNone) return give(field, 'None', 0.9, 'Choose your clearance yourself.')
    return give(field, held, 0.9, 'None of the options match your clearance. Choose it yourself.')
  }
  if (!held) return needs(missing)
  if (hasNone) return yesNo(field, false, missing)
  const asked = CLEARANCE_LEVELS.find((l) => plain.includes(l))
  if (asked && !held.toLowerCase().includes(asked)) return needs('This names a clearance level that differs from yours. Answer it yourself.')
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

/**
 * "Are you a US citizen?" and "Are you a citizen or permanent resident of Canada?", answered from the
 * authorization entry for that country. `country` is the one the question names or the job is in.
 */
export function citizenshipAnswer(field: FormField, country: string | null, facts: ApplicationFacts): MappedAnswer | null {
  const plain = plainOf(field.label)
  // "Dual citizenship" and "a citizen of a country other than the US" ask about citizenships the
  // authorization entries do not list, so the facts cannot answer them.
  if (OTHER_CITIZENSHIP.test(plain) && /\bcitizen/.test(plain)) return needs('This asks about a second citizenship, which your profile does not record. Answer it yourself.')
  const asksCitizen = /\bcitizen(?:ship)?\b/.test(plain) && /^(?:are|is|do|have)\b/.test(plain)
  const asksPermanent = PERMANENT.test(plain)
  if ((!asksCitizen && !asksPermanent) || !country || /\b(?:sponsor\w*|visa|authori[sz]ed|work)\b/.test(plain)) return null
  const entry = facts.authorization.find((e) => countryOf(e.country) === country || e.country.trim().toLowerCase() === country.toLowerCase())
  if (!entry) return null
  const yes = (asksCitizen && entry.status === 'citizen') || (asksPermanent && entry.status === 'permanent_resident')
  return yesNo(field, yes, 'Add your work authorization for this country in Profile.', 0.9)
}

// ---------------------------------------------------------------------------

/** Answers a field from the application facts, or returns null when the field is not one of their kinds. */
export function mapApplicationField(field: FormField, ctx: MapContext): MappedAnswer | null {
  if (field.type === 'file') return null
  const facts = ctx.profile.application
  const plain = plainOf(field.label)
  return (
    addressAnswer(field, plain, facts, ctx.profile) ??
    salaryAnswer(field, plain, ctx) ??
    (NOTICE.test(plain) && NOTICE_CUE.test(plain) && !NOT_NOTICE.test(plain) && !START_DATE.test(plain) ? noticeAnswer(field, plain, facts) : null) ??
    (START_DATE.test(plain) && !NOT_START.test(plain) ? startDateAnswer(field, facts, ctx) : null) ??
    yearsAnswer(field, plain, ctx.profile) ??
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
