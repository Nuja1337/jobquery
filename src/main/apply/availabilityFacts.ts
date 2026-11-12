import { EMPTY_APPLICATION_FACTS } from '@shared/defaults'
import { currencyInQuestion } from '@shared/questionTopics'
import type { ApplicationFacts, EmploymentType, FormField } from '@shared/types'
import { countryOf, isCountryName, locationParts, regionNames, regionOf } from '../util/geo'
import { answer, isChoice, type MapContext, type MappedAnswer, pickOption } from './fieldMap'
import { willingnessFamily, willingnessNote } from './questionFamilies'

// Answers from the work and availability facts: on site, hybrid and remote, commuting, employment type,
// hours, evenings and weekends, time zones, willingness to be screened, current job and current pay.
// A question is answered only when the fact states the answer. A fact that is not answered (null, or an
// empty list) gives a flag. Wording that flips the question, or asks for consent, goes to the person.

type Tri = boolean | null
type Group = 'arrangement' | 'commute' | 'employment' | 'shifts' | 'zone' | 'screening'

/** One fact read for one part of a question. `missing` is the flag note when the fact is not answered. */
interface Item {
  value: Tri
  missing: string
  note?: string
}

/** The part of a question that one group reads. `flag` means the group found wording it cannot read. */
interface Claim {
  group: Group
  items: Item[]
  flag?: string
}

type Verdict = { yes: boolean; note?: string } | { missing: string }

const needs = (note: string): MappedAnswer => ({ value: '', source: 'profile', confidence: 0, needsUser: true, note })

/** Flags that stand because a fact is not answered. A question in a willingness family gets that family's note. */
const GAPS = new WeakSet<MappedAnswer>()
function gap(note: string): MappedAnswer {
  const flag = needs(note)
  GAPS.add(flag)
  return flag
}

const plainOf = (label: string): string =>
  label
    .toLowerCase()
    .replace(/\(optional\)|\(required\)|\*/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const hasYesNoOptions = (field: FormField): boolean =>
  isChoice(field) && field.options.length > 0 && pickOption(field.options, 'Yes') !== null && pickOption(field.options, 'No') !== null

/** The facts with defaults under them, so a profile saved before these facts existed still reads. */
function factsOf(ctx: MapContext) {
  const base = EMPTY_APPLICATION_FACTS
  const app = ctx.profile.application as Partial<ApplicationFacts>
  return {
    workArrangement: { ...base.workArrangement, ...app.workArrangement },
    employment: { ...base.employment, ...app.employment, currentPay: { ...base.employment.currentPay, ...app.employment?.currentPay } },
    schedule: { ...base.schedule, ...app.schedule },
    screening: { ...base.screening, ...app.screening },
    relocation: { ...base.relocation, ...app.relocation }
  }
}
type Facts = ReturnType<typeof factsOf>

// ---------------------------------------------------------------------------
// Wording that is not a plain willingness question
// ---------------------------------------------------------------------------

/** Wording that turns a question around or asks about history. A stated willingness does not answer these. */
const FLIPPED =
  /\b(?:ever|previously|never|fail\w*|refus\w*|unable|unwilling|unavailable|cannot|can't|couldn't|could not|won't|wouldn't|not|any reason|prevent\w*|conflict\w*|restrict\w*|prohibit\w*|disqualif\w*|violat\w*|pass(?:ed|ing)?|clear(?:ed|ing)?|results?|negative|positive|criminal|convict\w*|felon\w*|arrest\w*|mind|object\w*|issues?|problems?|concerns?|difficult\w*|hesitat\w*|uncomfortable|reluctant|unpaid|uncompensated)\b|n't\b|\bwithout (?:any )?(?:additional|extra) (?:pay|compensation)\b/
/** Wording that asks the person to consent, authorize or confirm. Only the person gives these. */
const CONSENT = /\b(?:authori[sz]\w*|consent\w*|permission|acknowledg\w*|certif\w*|attest\w*|waive\w*|agree\w*|understand\w*|confirm\w*|disclos\w*)\b/
/** Words that ask for a check to be run on the person, not whether they will take part. */
const ALLOWS_CHECK = /\b(?:allow\w*|permit\w*|let us|release)\b/

/** Wording that asks whether the person is willing or able. A question without it is not one of these. */
const CUE =
  /\b(?:willing\w*|able|open|comfortable|available|availability|prepared|ready|happy|okay|ok|fine|interested|seeking|looking|can you|could you|will you|would you)\b/
const LOCATED_CUE = /\b(?:located|live|living|based|reside|residing)\b/
const PROSE = /\b(?:describe|tell us|explain|share|why|how (?:do|did|would))\b/

/** The question itself: the last sentence with a question mark, else the last sentence. Earlier sentences are context. */
function questionOf(plain: string): string {
  const parts = plain.split(/(?<=[.?!])\s+/).filter(Boolean)
  const asked = parts.filter((p) => p.endsWith('?'))
  return asked.length > 0 ? asked[asked.length - 1] : (parts[parts.length - 1] ?? plain)
}

/** A question that points back at the sentences before it. */
const REFERS_BACK = /\b(?:this|these|that|those|such) (?:requirements?|conditions?)\b|\bthe above\b|\bthe (?:requirements?|conditions?) above\b/
const REQUIRES = /\b(?:requires?|required|requiring|must have|must be able to|must|needs?)\b/
/** More than one thing listed in a requirement. */
const SEVERAL = /\b(?:and|or|plus|as well as)\b|[,;&]/

const OR_WORD = /\bor\b|\band\/or\b|\//

// ---------------------------------------------------------------------------
// Places, for commuting
// ---------------------------------------------------------------------------

const norm = (text: string): string => text.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()

const sameRegion = (a: string, b: string): boolean => a === b || regionNames(a).some((n) => n.toLowerCase() === b) || regionNames(b).some((n) => n.toLowerCase() === a)

/** True when `place` is the listed place, or is inside a listed state, province or country. */
export function placeMatches(place: string, listed: string): boolean {
  const p = norm(place)
  const l = norm(listed)
  if (!p || !l) return false
  if (p === l) return true
  const [pCity, ...pRest] = p.split(/\s*,\s*/)
  const [lCity, ...lRest] = l.split(/\s*,\s*/)
  const pTail = pRest.join(' ')
  const lTail = lRest.join(' ')
  if (pCity === lCity) {
    if (!pTail || !lTail) return true
    const pc = countryOf(pTail)
    const lc = countryOf(lTail)
    return sameRegion(pTail, lTail) || (pc !== null && pc === lc && !regionOf(pTail) && !regionOf(lTail))
  }
  if (!lTail) {
    const code = regionOf(place)
    if (code && sameRegion(code.toLowerCase(), l)) return true
    if (isCountryName(listed)) {
      const there = countryOf(place)
      return there !== null && there === countryOf(listed)
    }
  }
  return false
}

const GENERIC_PLACE = /^(?:office|offices|work|worksite|work site|workplace|site|location|campus|studio|headquarters|hq|area|city|there|it)$/

/**
 * The place a commuting question names: "our office in Irvine, CA" gives "irvine, ca", "our Seattle office"
 * gives "seattle". Null when it names none, 'unclear' when it names something too long to be a place.
 */
function placeAsked(plain: string): string | null | 'unclear' {
  const m = plain.match(/\bcommut\w*(?:\s+distance)?\s+(?:to|of|from)\s+(.+)$/)
  if (!m) return null
  let s = m[1].replace(/[?.!]+$/, '').trim()
  s = s.replace(/\s+(?:on a|every|each|daily|regularly|\d+\s*(?:days?|times|miles?|km|minutes?|hours?)|within|if|when|for the|as|and)\b.*$/, '')
  s = s.replace(/^(?:our|the|a|an|this|your|their)\s+/, '')
  const inPlace = s.match(/^(?:\w+\s+){0,3}(?:office|campus|studio|headquarters|hq|site|location)s?\s+(?:in|at|located in|near)\s+(.+)$/)
  s = inPlace ? inPlace[1] : s.replace(/\s+(?:office|campus|studio|headquarters|hq|site|location|area)s?$/, '')
  s = s.replace(/^(?:the|our)\s+/, '').trim()
  if (!s || GENERIC_PLACE.test(s)) return null
  return s.split(' ').length > 5 ? 'unclear' : s
}

/** True when two places match, or both name the same state, province or country. */
function sameArea(place: string, listed: string): boolean {
  if (placeMatches(place, listed)) return true
  const pTail = norm(place).split(/\s*,\s*/).slice(1).join(' ')
  const lTail = norm(listed).split(/\s*,\s*/).slice(1).join(' ')
  return pTail !== '' && lTail !== '' && sameRegion(pTail, lTail)
}

function commuteClaim(q: string, ctx: MapContext, facts: Facts): Claim | null {
  if (!/\bcommut\w*/.test(q)) return null
  const asked = placeAsked(q)
  if (asked === 'unclear') return { group: 'commute', items: [], flag: "Couldn't tell which place this asks about. Answer it yourself." }
  const job = ctx.jobLocation?.trim() ?? ''
  const places = asked ? [asked] : ctx.jobRemote === 'remote' || !job || /\bremote\b/i.test(job) ? [] : locationParts(job)
  if (places.length === 0) return { group: 'commute', items: [], flag: "Couldn't tell which place this asks about. Answer it yourself." }
  // "Currently within commuting distance" asks where the person lives now, so a move does not count.
  const now = /\b(?:currently|already|presently|now)\b/.test(q) && LOCATED_CUE.test(q)
  const { commutableCities: cities } = facts.workArrangement
  const { willing, places: moveTo } = facts.relocation
  const missing = `Your profile does not say whether you could commute to ${places[0]}. Answer it yourself.`
  const states = places.map((place): 'yes' | 'no' | 'unknown' => {
    if (cities.some((c) => placeMatches(place, c))) return 'yes'
    const moves = !now && willing === true && (moveTo.length === 0 || moveTo.some((r) => placeMatches(place, r)))
    if (moves) return 'yes'
    // A commute list holds examples, so a place off it is not ruled out. Only a question about where the person
    // lives now is answered No, and only when no listed city is in the same state or country.
    const nearListed = cities.some((c) => sameArea(place, c))
    const rulesOut = now && !nearListed
    return cities.length > 0 && rulesOut ? 'no' : 'unknown'
  })
  const viaMove = places.some((place) => !cities.some((c) => placeMatches(place, c)))
  let value: Tri = null
  if (states.every((s) => s === 'yes')) value = true
  else if (places.length === 1 && states[0] === 'no') value = false
  const note = value === true && viaMove ? 'Yes because you would relocate there.' : undefined
  return { group: 'commute', items: [{ value, missing, note }] }
}

// ---------------------------------------------------------------------------
// Work arrangement
// ---------------------------------------------------------------------------

const NUMBER_WORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 }
const DAY_COUNT = '(\\d|one|two|three|four|five)'
const toNumber = (text: string): number => NUMBER_WORD[text] ?? Number(text)

/** Days in the office a question names. A range gives its upper end. Null when it names none. */
function officeDays(text: string): number | null {
  const week = text.match(new RegExp(`\\b${DAY_COUNT}\\s*(?:(?:-|to)\\s*${DAY_COUNT}\\s*)?\\+?\\s*days?\\s*(?:a|per|each|every|/)\\s*week\\b`))
  if (week) return toNumber(week[2] ?? week[1])
  const place = text.match(new RegExp(`\\b${DAY_COUNT}\\s*days?\\s+(?:in[- ]office|on[- ]?site|in the office|at the office)`))
  if (place) return toNumber(place[1])
  // "25% of the time" is read as a share of a five-day week, rounded up.
  const share = text.match(/\b(\d{1,3})\s*%\s*of\s+(?:the |your |each )?(?:time|week|work ?week|schedule)\b/)
  if (share) return Math.ceil((Number(share[1]) * 5) / 100)
  return /\b(?:fully|completely|entirely|100%|every day|all week)\b.{0,15}(?:on[- ]?site|in[- ]office|in the office)/.test(text) ? 5 : null
}

const ONSITE = /\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b|\b(?:work|working|be|come|go)\b[^.?]{0,30}\b(?:from|in|at|into) (?:the|our|an?) (?:office|studio)\b|\bin the (?:office|studio)\b/
/** An on-site interview or visit is not an on-site job. */
const NOT_THE_JOB = /\b(?:interview\w*|assessments?|visit\w*|trips?|events?|orientation|training|meetings?|tours?)\b/
const HYBRID = /\bhybrid\b/
const REMOTE = /\bwork(?:ing)?\s+(?:fully\s+|completely\s+|entirely\s+|100%\s+|full[- ]time\s+)?(?:remote(?:ly)?|from home|from anywhere)\b|\bremote(?:ly)?\s+(?:work|working|position|role|job|setting|arrangement|basis|environment)\b|\bwork-from-home\b|\bremotely\b/

function arrangementClaim(q: string, facts: Facts): Claim | null {
  if (NOT_THE_JOB.test(q)) return null
  const wa = facts.workArrangement
  const days = officeDays(q)
  const items: Item[] = []
  if (ONSITE.test(q)) {
    let value: Tri = wa.onsite
    if (days !== null && wa.maxOfficeDaysPerWeek !== null) value = days <= wa.maxOfficeDaysPerWeek
    else if (wa.onsite === null && wa.maxOfficeDaysPerWeek === 0) value = false
    items.push({ value, missing: 'Add whether you would work on site in Profile.' })
  }
  if (HYBRID.test(q)) {
    let value: Tri = wa.hybrid
    if (value === true && days !== null && wa.maxOfficeDaysPerWeek !== null && days > wa.maxOfficeDaysPerWeek) value = false
    items.push({ value, missing: 'Add whether you would work hybrid in Profile.' })
  }
  if (REMOTE.test(q)) {
    // "Remotely from Canada" adds a place condition the facts do not cover.
    if (countryOf(q.replace(/\bus\b/g, '')) !== null) return { group: 'arrangement', items: [], flag: 'This asks about remote work from a place. Answer it yourself.' }
    items.push({ value: wa.remote, missing: 'Add whether you would work remotely in Profile.' })
  }
  return items.length > 0 ? { group: 'arrangement', items } : null
}

// ---------------------------------------------------------------------------
// Employment type and hours
// ---------------------------------------------------------------------------

const TYPE_PATTERNS: Array<[EmploymentType, RegExp]> = [
  ['contract_to_hire', /\bcontract[- ]to[- ](?:hire|perm\w*)\b|\bc2h\b|\btemp[- ]to[- ](?:hire|perm\w*)\b/],
  ['full_time', /\bfull[- ]?time\b/],
  ['part_time', /\bpart[- ]?time\b/],
  ['contract', /\bcontract(?:s|or|ors|ing)?\b/],
  ['temporary', /\btemp(?:orary)?\b/],
  ['internship', /\bintern(?:ship)?s?\b/],
  ['freelance', /\bfreelanc\w+/]
]
/** Kinds of work the facts have no value for. */
const OTHER_TYPES = /\bseasonal\b|\bcasual\b|\bapprentic\w+|\bvolunteer\w*|\bfixed[- ]term\b|\bzero[- ]hours?\b/
/** "Permanent" next to full-time or part-time adds nothing. On its own it is a kind of work the facts do not cover. */
const PERMANENT = /\bpermanent(?! resident)\b/
/** "Sign a contract" and the like are not about the kind of job. */
const CONTRACT_LEGAL = /\b(?:sign\w*|employment contract|contractual|agreement|terms)\b/
const HOURS_WEEK = /\b(\d{1,3})\s*(?:\+\s*)?[- ]?(?:hours?|hrs?)\s*(?:(?:per|a|each|\/)\s*)?(?:week|wk|workweek|work week)\b|\b(\d{1,3})[- ](?:hours?|hrs?)\s+(?:work ?weeks?)\b/
const ANY_HOURS = /\b\d{1,3}\s*(?:\+\s*)?[- ]?(?:hours?|hrs?)\b/
const UPPER_BOUND = /\b(?:up to|no more than|at most|maximum|max|under|less than|fewer than|not more than|limited to|capped)\b/

function typeValue(types: EmploymentType[], want: EmploymentType): Tri {
  if (types.length === 0) return null
  if (types.includes(want)) return true
  // "Contract" and "contract to hire" are close but not the same, so having one does not rule out the other.
  if ((want === 'contract' && types.includes('contract_to_hire')) || (want === 'contract_to_hire' && types.includes('contract'))) return null
  return false
}

function employmentClaim(q: string, facts: Facts): Claim | null {
  const { types, hoursPerWeek } = facts.employment
  const items: Item[] = []
  let rest = q
  for (const [type, pattern] of TYPE_PATTERNS) {
    if (!pattern.test(rest)) continue
    if (type === 'contract' && CONTRACT_LEGAL.test(rest)) continue
    items.push({ value: typeValue(types, type), missing: 'Add the kinds of work you would take in Profile.' })
    // "Contract-to-hire" must not also count as "contract".
    rest = rest.replace(pattern, ' ')
  }
  const regular = /\bfull[- ]?time\b/.test(q) || /\bpart[- ]?time\b/.test(q)
  const other = OTHER_TYPES.test(q) || (PERMANENT.test(q) && !regular)
  const hours = q.match(HOURS_WEEK)
  if (hours) {
    if (UPPER_BOUND.test(q)) return { group: 'employment', items: [], flag: 'This asks about a limit on hours. Answer it yourself.' }
    const n = Number(hours[1] ?? hours[2])
    items.push({ value: hoursPerWeek === null ? null : n <= hoursPerWeek, missing: 'Add the hours per week you can work in Profile.' })
  } else if (ANY_HOURS.test(q) && !q.includes('overlap')) {
    return { group: 'employment', items: [], flag: "This names hours without saying per week. Answer it yourself." }
  }
  if (other) return { group: 'employment', items: [], flag: 'This names a kind of work your profile has no answer for. Answer it yourself.' }
  return items.length > 0 ? { group: 'employment', items } : null
}

// ---------------------------------------------------------------------------
// Evenings, weekends, nights, on-call and overtime
// ---------------------------------------------------------------------------

const SHIFT_ITEMS: Array<[keyof Facts['schedule'], RegExp, string]> = [
  ['evenings', /\bevenings?\b/, 'evenings'],
  ['weekends', /\bweekends?\b|\bsaturdays?\b|\bsundays?\b/, 'weekends'],
  ['nights', /\bnights?\b|\bovernight\b|\bgraveyard\b/, 'nights'],
  ['onCall', /\bon[- ]?call\b|\bpager\b/, 'on call'],
  ['overtime', /\bovertime\b|\bcrunch\b|\bextra hours\b|\blong hours\b/, 'overtime']
]
/** Shift wording the facts have no value for. */
const OTHER_SHIFTS = /\bholidays?\b|\brotat\w+|\bsplit\b|\bflexible\b|\b(?:early|late) (?:mornings?|hours|starts?)\b|\bmornings?\b|\bswing\b|\bafter[- ]hours\b/

function shiftsClaim(q: string, facts: Facts): Claim | null {
  const items: Item[] = []
  for (const [key, pattern, name] of SHIFT_ITEMS) {
    if (!pattern.test(q)) continue
    items.push({ value: facts.schedule[key] as Tri, missing: `Add whether you would work ${name} in Profile.` })
  }
  if (items.length === 0) return null
  if (OTHER_SHIFTS.test(q)) return { group: 'shifts', items: [], flag: 'This names a schedule your profile has no answer for. Answer it yourself.' }
  return { group: 'shifts', items }
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

// Two-letter abbreviations are read in capitals only, so "et" and "pt" inside words never count.
const ZONES: Array<{ key: string; long: RegExp; short?: RegExp }> = [
  { key: 'pt', long: /\b(?:pacific|pst|pdt|america\/los_angeles|america\/vancouver|us\/pacific)\b/i, short: /\bPT\b/ },
  { key: 'mt', long: /\b(?:mountain|mst|mdt|america\/denver|america\/phoenix|us\/mountain)\b/i, short: /\bMT\b/ },
  { key: 'ct', long: /\b(?:central (?:standard |daylight )?time|cst|cdt|america\/chicago|us\/central)\b/i, short: /\bCT\b/ },
  { key: 'et', long: /\b(?:eastern|est|edt|america\/new_york|america\/toronto|us\/eastern)\b/i, short: /\bET\b/ },
  { key: 'utc+0', long: /\b(?:utc|gmt)\b(?!\s*[+-]\s*\d)|\beurope\/london\b|\buk time\b/i },
  { key: 'cet', long: /\b(?:cet|cest|central european|europe\/berlin|europe\/paris|europe\/amsterdam|europe\/madrid|europe\/stockholm)\b/i }
]

function zoneKeys(text: string, mode: 'label' | 'strong-label' | 'entry'): Set<string> {
  const found = new Set<string>()
  for (const z of ZONES) {
    const short = z.short && (mode === 'strong-label' ? z.short.test(text) : mode === 'entry' ? new RegExp(z.short.source, 'i').test(text) : false)
    if (z.long.test(text) || short) found.add(z.key)
  }
  for (const m of text.matchAll(/\b(?:utc|gmt)\s*([+-])\s*(\d{1,2})\b/gi)) found.add(`utc${m[1]}${Number(m[2])}`)
  return found
}

function zoneClaim(label: string, q: string, facts: Facts): Claim | null {
  // "MT" and "CT" are also state codes, so two-letter zones count only when the question is plainly about time zones or hours.
  const strong = /\btime ?zones?\b|\boverlap\w*\b|\b(?:working|business|core|office) hours\b/.test(q)
  const asked = zoneKeys(label.replace(/\s+/g, ' '), strong ? 'strong-label' : 'label')
  if (asked.size === 0 || !(strong || /\bhours\b|\bavailable\b/.test(q))) return null
  const listed = new Set<string>()
  for (const entry of facts.schedule.timeZones) for (const k of zoneKeys(entry, 'entry')) listed.add(k)
  const all = [...asked].every((k) => listed.has(k))
  // A zone that is not on the list is not a plain No, since hours can overlap across zones.
  return { group: 'zone', items: [{ value: facts.schedule.timeZones.length === 0 ? null : all ? true : null, missing: facts.schedule.timeZones.length === 0 ? 'Add the time zones you can work in Profile.' : 'This names a time zone that is not on your list. Answer it yourself.' }] }
}

// ---------------------------------------------------------------------------
// Background, drug and credit checks
// ---------------------------------------------------------------------------

const SCREENS: Array<[keyof Facts['screening'], RegExp, string]> = [
  ['drugTest', /\bdrug[- ](?:test|screen|panel|free)\w*|\bdrug and alcohol\b|\bsubstance (?:abuse )?(?:test|screen)\w*|\btoxicolog\w*/, 'a drug test'],
  ['backgroundCheck', /\bbackground[- ]?(?:check|screen|investigation|verification)\w*/, 'a background check'],
  ['creditCheck', /\bcredit[- ](?:check|history|report|screen)\w*/, 'a credit check']
]
/** Willingness to take part. "Able to pass" and "agree to" are not this. */
const SCREEN_WILLING =
  /\b(?:willing\w*|open to|ok(?:ay)? with|comfortable (?:with|undergoing|taking)|prepared to|ready to|(?:able|happy) to (?:undergo|submit|take|complete|go through|participate|sit|have)|(?:will|would|can|could) you (?:be )?(?:undergo|submit|take|complete|go through|participate|subject))\b/

function screeningClaim(q: string, facts: Facts): Claim | null {
  const hits = SCREENS.filter(([, pattern]) => pattern.test(q))
  if (hits.length === 0) return null
  if (!SCREEN_WILLING.test(q)) return { group: 'screening', items: [], flag: 'This asks about a check in a way that is not plain willingness. Answer it yourself.' }
  if (hits.length > 1 && OR_WORD.test(q)) return { group: 'screening', items: [], flag: 'This asks about more than one check. Answer it yourself.' }
  return { group: 'screening', items: hits.map(([key, , name]) => ({ value: facts.screening[key], missing: `Add whether you would undergo ${name} in Profile.` })) }
}

// ---------------------------------------------------------------------------
// Putting the claims together
// ---------------------------------------------------------------------------

/** All parts must hold. With "or", one part is enough. */
function verdictOf(items: Item[], either: boolean): Verdict {
  const notes = items.map((i) => i.note).filter((n): n is string => !!n)
  const note = notes[0]
  if (either) {
    if (items.some((i) => i.value === true)) return { yes: true, note }
    if (items.every((i) => i.value === false)) return { yes: false }
    return { missing: (items.find((i) => i.value === null) ?? items[0]).missing }
  }
  if (items.some((i) => i.value === false)) return { yes: false }
  const gap = items.find((i) => i.value === null)
  return gap ? { missing: gap.missing } : { yes: true, note }
}

function reply(field: FormField, yes: boolean, note: string | undefined): MappedAnswer {
  return answer(field, yes ? 'Yes' : 'No', 'profile', 0.9, note ?? null) ?? needs('The options on this question have no Yes or No. Answer it yourself.')
}

// ---------------------------------------------------------------------------
// Short fields: hours, current job, desired title, current pay
// ---------------------------------------------------------------------------

const CURRENTLY_EMPLOYED =
  /^(?:are you|do you)\s+(?:currently\s+|presently\s+|now\s+)?(?:employed|working|have a job|have employment)(?:\s+(?:right now|at the moment|at present|currently|today|now))?\s*[?.:]*$/
const DESIRED_TITLE =
  /^(?:what is your |what's your |your )?(?:desired|preferred|target|ideal)\s+(?:job\s+|position\s+|role\s+)?(?:title|position|role|job)\s*[?:.]*$|^(?:what )?(?:job )?title (?:are you|do you) (?:seeking|looking for|targeting|want)\s*[?:.]*$/
const CURRENT_PAY =
  /\bcurrent(?:ly)?\s+(?:(?:annual|base|total|hourly|monthly|gross|yearly)\s+)*(?:salary|compensation|pay|wage|wages|earnings|ctc)\b|\bwhat (?:are you|do you) (?:currently )?(?:making|earning|paid)\b|\bhow much (?:are you|do you) (?:currently )?(?:making|earn|paid)\b/
const NOT_CURRENT_PAY = /\b(?:expect\w*|desired|target|require\w*|looking for|seeking|range|history|previous|last|prior|bonus|equity|benefits|comfortable|disclos\w*)\b/
const HOURS_NUMBER = /\bhow many hours\b|\bhours (?:per|a|each) week\b|\bhours\/week\b|\bweekly hours\b|\bnumber of hours\b/
const YES_NO_OPENER = /^(?:are|is|can|could|will|would|do|does|did|have|has)\b/

type PayPeriod = 'hour' | 'month' | 'year'
const PER_YEAR: Record<PayPeriod, number> = { year: 1, month: 12, hour: 2080 }
const PERIOD_WORDS: Array<[PayPeriod, RegExp]> = [
  ['hour', /\bper hour\b|\bhourly\b|\ban hour\b|\/ ?h(?:ou)?rs?\b/],
  ['month', /\bper month\b|\bmonthly\b|\ba month\b|\/ ?(?:mo|mth|month)s?\b/],
  ['year', /\bper (?:year|annum|yr)\b|\bannual(?:ly)?\b|\byearly\b|\ba year\b|\bannum\b|\/ ?(?:yr|year)s?\b/]
]

function currentPayAnswer(field: FormField, plain: string, ctx: MapContext, facts: Facts): MappedAnswer {
  const pay = facts.employment.currentPay
  if (pay.stance === '') return gap('Add whether you share your current pay in Profile.')
  if (pay.stance === 'decline') {
    if (field.type === 'number') return needs('This field needs a number, and you chose not to share your current pay. Answer it yourself.')
    return answer(field, 'Prefer not to say', 'profile', 0.85) ?? needs('Add how you answer current pay in Profile.')
  }
  if (pay.amount === null) return gap('Add your current pay amount in Profile.')
  const askedCurrency = currencyInQuestion(field.label)
  const own = pay.currency.trim().toUpperCase()
  if (askedCurrency && own && askedCurrency !== own) return needs(`Your current pay is entered in ${own}, and this asks for ${askedCurrency}. Answer it yourself.`)
  const named = PERIOD_WORDS.filter(([, re]) => re.test(plain)).map(([p]) => p)
  const asked = named.length === 1 ? named[0] : null
  let amount = pay.amount
  let period: PayPeriod = pay.period
  if (asked && asked !== pay.period) {
    amount = (pay.amount * PER_YEAR[pay.period]) / PER_YEAR[asked]
    amount = asked === 'hour' ? Math.round(amount * 100) / 100 : Math.round(amount)
    period = asked
  } else if (!asked && pay.period !== 'year' && field.type === 'number') {
    return needs(`Your current pay is entered per ${pay.period}. This form does not say which period it wants, so answer it yourself.`)
  }
  const jobCurrency = ctx.jobCurrency?.trim().toUpperCase() || null
  if (field.type === 'number') {
    if (!askedCurrency && own && jobCurrency && jobCurrency !== own) return needs(`Your current pay is in ${own}, and this job pays in ${jobCurrency}. Answer it yourself.`)
    return answer(field, String(amount), 'profile', 0.85) ?? needs('Answer this yourself.')
  }
  const perPeriod = period === 'year' ? '' : ` per ${period}`
  return answer(field, `${Math.round(amount).toLocaleString('en-US')}${own ? ` ${own}` : ''}${perPeriod}`, 'profile', 0.85) ?? needs('Answer this yourself.')
}

/** A choice between remote, hybrid and on site, answered with the way the job works when the facts allow it. */
function arrangementChoice(field: FormField, ctx: MapContext, facts: Facts): MappedAnswer | null {
  if (!/\b(?:work(?:ing)? (?:arrangement|style|model|setup|preference|environment|location type)|preferred (?:work )?(?:arrangement|setting))\b/.test(plainOf(field.label))) return null
  const kinds: Array<['remote' | 'hybrid' | 'onsite', RegExp]> = [
    ['hybrid', /hybrid/i],
    ['remote', /^(?!.*hybrid).*remote/i],
    ['onsite', /on[- ]?site|in[- ]office|in[- ]person/i]
  ]
  const optionFor = new Map<string, string>()
  for (const [kind, re] of kinds) {
    const hits = field.options.filter((o) => re.test(o))
    if (hits.length === 1) optionFor.set(kind, hits[0])
  }
  if (optionFor.size < 2) return null
  const wa = facts.workArrangement
  const willing = (['remote', 'hybrid', 'onsite'] as const).filter((k) => wa[k] === true)
  const job = ctx.jobRemote && ctx.jobRemote !== 'unknown' ? ctx.jobRemote : null
  const pick = job && willing.includes(job) ? job : !job && willing.length === 1 ? willing[0] : null
  const option = pick ? optionFor.get(pick) : undefined
  if (!option) return needs('Your profile does not settle which way of working to choose here. Choose one yourself.')
  return answer(field, option, 'profile', 0.85)
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Answers a field from the work and availability facts, or returns null when the field is not one of their
 * kinds. A fact that is not answered gives a flag with a note. Wording that flips the question or asks for
 * consent gives a flag too.
 */
function mapField(field: FormField, ctx: MapContext): MappedAnswer | null {
  if (field.type === 'file' || field.type === 'checkbox') return null
  const plain = plainOf(field.label)
  if (!plain) return null
  const facts = factsOf(ctx)

  // Short fields that take a value.
  if (field.type === 'text' || field.type === 'number') {
    if (DESIRED_TITLE.test(plain)) {
      const title = facts.employment.desiredTitle.trim()
      return title ? answer(field, title, 'profile', 0.9) : gap('Add your desired job title in Profile.')
    }
    if (CURRENT_PAY.test(plain) && !NOT_CURRENT_PAY.test(plain) && plain.split(' ').length <= 14) return currentPayAnswer(field, plain, ctx, facts)
    if (HOURS_NUMBER.test(plain) && !YES_NO_OPENER.test(plain) && !/\d/.test(plain) && !PROSE.test(plain)) {
      const hours = facts.employment.hoursPerWeek
      return hours === null ? gap('Add the hours per week you can work in Profile.') : answer(field, String(hours), 'profile', 0.85)
    }
  }
  if (isChoice(field) && !hasYesNoOptions(field)) return arrangementChoice(field, ctx, facts)

  // Yes/no questions.
  if (!hasYesNoOptions(field) && field.type !== 'text') return null
  if (field.type === 'text' && PROSE.test(plain)) return null
  if (CURRENTLY_EMPLOYED.test(plain)) {
    const employed = facts.employment.currentlyEmployed
    return employed === null ? gap('Add whether you are currently employed in Profile.') : reply(field, employed, undefined)
  }

  const q = questionOf(plain)
  const claimsIn = (text: string): Claim[] =>
    [commuteClaim(text, ctx, facts), arrangementClaim(text, facts), employmentClaim(text, facts), shiftsClaim(text, facts), zoneClaim(field.label, text, facts), screeningClaim(text, facts)].filter(
      (c): c is Claim => c !== null
    )
  // A question like "Are you able to meet this requirement?" leans on the sentences before it.
  let scope = q
  let claims = claimsIn(q)
  if (claims.length === 0 && q !== plain) {
    scope = plain
    claims = claimsIn(plain)
  }
  // "Are you able to meet this requirement?" answers for one requirement the facts cover. Several, or one they do not cover, are the person's.
  if (q !== plain && REFERS_BACK.test(q)) {
    const before = plain.slice(0, plain.lastIndexOf(q))
    const verb = [...before.matchAll(new RegExp(REQUIRES.source, 'g'))].pop()
    if (verb) {
      const several = SEVERAL.test(before.slice((verb.index ?? 0) + verb[0].length))
      if (several || claims.length === 0) return needs('This refers back to a requirement that has more than one part or that your profile does not cover. Answer it yourself.')
    }
  }
  if (claims.length === 0) return null

  const commuting = claims.some((c) => c.group === 'commute')
  // Turned-around and consent wording is the person's to answer, whether or not it reads like a willingness question.
  // Kinds of work are the exception, since "contractor" and "full-time" turn up in questions about past jobs.
  const onlyEmployment = claims.every((c) => c.group === 'employment')
  const cued = CUE.test(q) || (commuting && LOCATED_CUE.test(q))
  if (onlyEmployment && !cued) return null
  if (FLIPPED.test(q)) return needs('This is worded as a history question or in a way the app could misread. Answer it yourself.')
  if (CONSENT.test(q) || (claims.some((c) => c.group === 'screening') && ALLOWS_CHECK.test(q))) return needs('This asks you to consent or authorize something. Answer it yourself.')
  if (!cued) return null
  const flagged = claims.find((c) => c.flag)
  if (flagged) return needs(flagged.flag as string)
  if (new Set(claims.map((c) => c.group)).size > 1) return needs('This asks about more than one thing. Answer it yourself.')

  const verdict = verdictOf(claims.flatMap((c) => c.items), OR_WORD.test(scope))
  if ('missing' in verdict) return gap(verdict.missing)
  return reply(field, verdict.yes, verdict.note)
}

/**
 * Answers a field from the work and availability facts, or returns null when the field is not one of their
 * kinds. A fact that is not answered gives a flag. Wording that flips the question or asks for consent gives
 * a flag too. An optional question that cannot be answered is left blank without a flag.
 */
export function mapAvailabilityField(field: FormField, ctx: MapContext): MappedAnswer | null {
  const got = mapField(field, ctx)
  if (!got || !got.needsUser) return got
  if (!field.required) return { value: '', source: 'profile', confidence: 0, needsUser: false, note: 'Optional, so JobQuery leaves it blank.' }
  const family = GAPS.has(got) ? willingnessFamily(field.label) : null
  return family ? { ...got, note: willingnessNote(family) } : got
}
