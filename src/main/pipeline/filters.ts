import type { AuthorizationEntry, EmploymentType, JobPreferences, RemoteType, Seniority } from '@shared/types'
import { normalizeCompany } from './dedupe'
import { countryOf, isCountryName, locationParts, regionOf } from '../util/geo'

/** The fields of a job the free filters look at. Both RawJob and Job fit. */
export interface FilterJob {
  title: string
  company: string
  location: string | null
  remote: RemoteType
  salaryMax: number | null
  salaryCurrency: string | null
  postedAt: string | null
  description: string
  /** What the source calls the job's type, such as "Full-time" or "Contract". */
  employmentType?: string | null
  /** Levels the source states, as seniority ids. */
  seniority?: Seniority[]
}

export interface FilterContext {
  /** Epoch milliseconds, passed in so tests don't depend on the clock. */
  now: number
  /** Normalized names of companies the user blocked. */
  blockedCompanies: Set<string>
  /** ISO time the user last applied to a company, or null. Takes a normalized name. */
  lastAppliedAt(companyNorm: string): string | null
  /**
   * How many applications to a company were sent, or had Submit clicked, at or after this epoch
   * millisecond time. Takes a normalized name. Without it, the last application stands for one.
   */
  appliedCount?(companyNorm: string, sinceMs: number): number
  /** Work authorization per country from the profile. When it has entries, they decide whether sponsorship is needed. */
  authorization?: AuthorizationEntry[]
  /** Places the owner would move to. They count as acceptable locations when `willing` is true. */
  relocation?: { willing: boolean | null; places: string[] }
}

export type FilterResult = { pass: true } | { pass: false; reason: string }

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Title words
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(['and', 'or', 'of', 'the', 'for', 'in', 'at', 'to', 'a', 'an', 'with', 'on', 'i', 'ii', 'iii', 'iv', 'v', 'remote', 'us', 'uk', 'eu', 'emea', 'apac', 'new', 'team'])

/** Seniority words as they appear in titles, mapped to the seniority levels in settings. */
const SENIORITY_WORDS: Array<{ pattern: RegExp; word: string; level: Seniority }> = [
  { pattern: /\b(intern|internship|trainee|working student|werkstudent|co-?op|apprentice|apprenticeship)\b/, word: 'intern', level: 'intern' },
  { pattern: /\b(junior|jr|entry[- ]level|graduate)\b/, word: 'junior', level: 'junior' },
  { pattern: /\b(senior|sr|snr)\b/, word: 'senior', level: 'senior' },
  { pattern: /\bstaff\b/, word: 'staff', level: 'staff' },
  { pattern: /\barchitect\b/, word: 'architect', level: 'staff' },
  { pattern: /\bprincipal\b/, word: 'principal', level: 'principal' },
  { pattern: /\blead\b(?!\s+gen)/, word: 'lead', level: 'staff' },
  { pattern: /\b(manager|management)\b/, word: 'manager', level: 'manager' },
  { pattern: /\b(director|head of)\b/, word: 'director', level: 'director' },
  { pattern: /\b(vp|vice president|chief|cto|ceo|cfo|coo)\b/, word: 'vp', level: 'executive' }
]

/** Levels from a number or a code. Companies number differently, so these are the common reading. */
const NUMBER_LEVELS: Seniority[] = ['junior', 'mid', 'senior', 'senior', 'staff', 'principal']
const L_LEVELS: Seniority[] = ['junior', 'junior', 'junior', 'mid', 'senior', 'staff', 'principal']
const P_LEVELS: Seniority[] = ['junior', 'junior', 'mid', 'senior', 'staff', 'principal']
const IC_LEVELS: Seniority[] = ['junior', 'junior', 'mid', 'senior', 'staff', 'principal']
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 }

/** A number or roman numeral straight after a role noun, as in "Software Engineer II" or "SDE 3". */
const NOUN_LEVEL =
  /\b(?:engineer|developer|programmer|designer|scientist|analyst|artist|animator|tester|technician|specialist|consultant|administrator|sde|swe|sdet)\s*[,(]?\s*(?:level\s*)?(i{1,3}|iv|v|[1-6])\b\)?(?=\s*(?:$|[,(|:\-–—]))/
const CODE_LEVEL = /\b(l|p|ic)([1-9]\d?)\b/

function levelAt(levels: Seniority[], n: number): Seniority {
  return levels[Math.min(Math.max(n, 1), levels.length) - 1]
}

/** Level numbers and L, P and IC codes in a title, or null. */
function numberedLevel(t: string): { word: string; level: Seniority } | null {
  const code = CODE_LEVEL.exec(t)
  if (code) {
    const n = Number(code[2])
    const levels = code[1] === 'l' ? L_LEVELS : code[1] === 'p' ? P_LEVELS : IC_LEVELS
    return { word: code[0], level: levelAt(levels, n) }
  }
  const noun = NOUN_LEVEL.exec(t)
  if (noun) {
    const n = ROMAN[noun[1]] ?? Number(noun[1])
    return { word: noun[1].toUpperCase(), level: levelAt(NUMBER_LEVELS, n) }
  }
  return null
}

/** Words that signal seniority. Ignored when matching a title against target titles. */
const SENIORITY_TOKENS = new Set(['intern', 'internship', 'trainee', 'apprentice', 'apprenticeship', 'junior', 'jr', 'senior', 'sr', 'snr', 'staff', 'principal', 'lead', 'director', 'head', 'vp', 'vice', 'president', 'chief', 'associate', 'graduate'])

/** "Product Manager" names a function, not a management level, so it doesn't count as seniority. */
const FUNCTIONAL_MANAGER =
  /\b(?:product|project|program|account|marketing|sales|brand|community|content|customer success|customer|office|operations|business|general|store|category|partner|partnerships|recruiting|talent|finance|hr)\s+manager\b/g

export function titleSeniority(title: string): { word: string; level: Seniority } | null {
  const t = title.toLowerCase().replace(FUNCTIONAL_MANAGER, ' ')
  for (const s of SENIORITY_WORDS) if (s.pattern.test(t)) return { word: s.word, level: s.level }
  return numberedLevel(t)
}

export function stem(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

/**
 * Words that mean the same thing in a title. Engineer, developer, programmer, SDE and SWE are one
 * role noun, and gameplay is a kind of game.
 */
function canonicalWord(word: string): string {
  if (/^(?:developer|programmer|programming|sde|swe)\d*$/.test(word)) return 'engineer'
  if (word === 'gameplay') return 'game'
  if (word === 'design') return 'designer'
  return word
}

/** Level markers such as "L5", "ic3", "2" and "ii" say how senior a job is, not what it is. */
const LEVEL_WORD = /^(?:(?:l|p|ic)\d{1,2}|\d+)$/

/** Meaningful words of a title: no seniority, no stop words, simple plurals folded. */
export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/\bco-?op\b/g, ' intern ')
    .replace(/\b(back|front)[- ]end\b/g, '$1end')
    .replace(/\bfull[- ]stack\b/g, 'fullstack')
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !SENIORITY_TOKENS.has(w) && !LEVEL_WORD.test(w))
    .map((w) => canonicalWord(stem(w)))
}

function hasWord(text: string, word: string): boolean {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text)
}

/**
 * A level a source states ("Entry Level", "Mid-level", "Management", "student") as one of the app's seniority
 * ids, or null when the label is missing or too vague to place ("experienced").
 */
export function seniorityFromLabel(label: string | null | undefined): Seniority | null {
  const t = (label ?? '').toLowerCase().replace(/[_-]+/g, ' ').trim()
  if (!t) return null
  if (/\b(intern|internship|student|working student|apprentice|trainee)\b/.test(t)) return 'intern'
  if (/\b(entry|junior|jr|graduate|beginner)\b/.test(t)) return 'junior'
  if (/\b(executive|c level|chief|vp|vice president)\b/.test(t)) return 'executive'
  if (/\b(director|head of)\b/.test(t)) return 'director'
  if (/\b(manager|management)\b/.test(t)) return 'manager'
  if (/\bprincipal\b/.test(t)) return 'principal'
  if (/\b(staff|lead)\b/.test(t)) return 'staff'
  if (/\b(senior|sr)\b/.test(t)) return 'senior'
  if (/\b(mid|middle|intermediate)\b/.test(t)) return 'mid'
  return null
}

/** The employment types a source's label names, such as "Full-time, Contract". Empty when it names none the app knows. */
export function employmentTypesOf(label: string | null | undefined): EmploymentType[] {
  const typeOf = (text: string): EmploymentType | null => {
    const t = text.replace(/[_()-]+/g, ' ').trim()
    if (/\b(contract|temp|temporary)\s*(to|2)\s*(hire|perm|permanent)\b/.test(t)) return 'contract_to_hire'
    if (/\b(intern|internship|trainee|working student|apprentice|apprenticeship|co ?op)\b/.test(t)) return 'internship'
    if (/\bpart ?time\b/.test(t)) return 'part_time'
    if (/\b(full ?time|permanent|regular)\b/.test(t)) return 'full_time'
    if (/\b(contract|contractor|fixed term)\b/.test(t)) return 'contract'
    if (/\b(temp|temporary|seasonal)\b/.test(t)) return 'temporary'
    if (/\b(freelance|freelancer|self employed)\b/.test(t)) return 'freelance'
    return null
  }
  const found = new Set<EmploymentType>()
  for (const part of (label ?? '').toLowerCase().split(/[,;/|&]+|\s+(?:or|and)\s+/)) {
    // "Contract (Full-time)" is a contract, since the brackets give the hours. Brackets count only when nothing else names a type.
    const type = typeOf(part.replace(/\([^)]*\)/g, ' ')) ?? typeOf(part)
    if (type) found.add(type)
  }
  return [...found]
}

const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  full_time: 'full-time',
  part_time: 'part-time',
  contract: 'contract',
  contract_to_hire: 'contract-to-hire',
  temporary: 'temporary',
  internship: 'internship',
  freelance: 'freelance'
}

/** True when the person needs sponsorship to work in this entry's country. */
export function sponsorshipNeeds(entry: AuthorizationEntry): boolean {
  return entry.status === 'none' || (entry.status === 'visa' && entry.needsSponsorship)
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

const REMOTE_LABEL: Record<RemoteType, string> = { remote: 'remote', hybrid: 'hybrid', onsite: 'on-site', unknown: 'unknown' }

// Wording that really says "we do not sponsor". A sentence that only mentions sponsorship
// ("Visa sponsorship is available", "Not sure if we sponsor? Ask.") must not match.
const SPONSOR_OBJECT = String.raw`(?:(?:any|work|employment|employer|immigration|visa|h-?1b|us|u\.s\.|company|corporate)\s+){0,3}`
const SPONSOR_WORD = String.raw`sponsor(?:ship|ing)?\b(?!\s+(?:events?|conferences?|meetups?|hackathons?|teams?|open))`
const NEGATION = String.raw`(?:(?:do|does|did|will|would|can|could|shall|are|is|am)\s+not|(?:'re|'m)\s+not|don't|doesn't|won't|wouldn't|cannot|can't|aren't|isn't|unable)`
const FILLER = String.raw`(?:\s+(?:currently|presently|generally|typically|able|to|be|in\s+a\s+position|offer|provide|support|extend|consider|do|qualify|for|eligible|open)){0,6}`
const NO_SPONSORSHIP = [
  // "we do not offer visa sponsorship", "are unable to sponsor", "cannot sponsor"
  new RegExp(String.raw`\b${NEGATION}${FILLER}\s+${SPONSOR_OBJECT}${SPONSOR_WORD}`, 'i'),
  // "we are not offering visa sponsorship", "not currently sponsoring"
  new RegExp(String.raw`\bnot\s+(?:currently\s+|presently\s+)?(?:sponsoring\b|(?:offering|providing|open\s+to|accepting)\s+(?:relocation(?:\s+assistance)?\s*(?:,|or|and|/)\s*)?${SPONSOR_OBJECT}sponsorship\b)`, 'i'),
  // "no visa sponsorship", "no relocation or visa sponsorship"
  new RegExp(String.raw`\bno\s+(?:relocation(?:\s+assistance)?\s*(?:,|or|and|/)\s*)?${SPONSOR_OBJECT}sponsorship\b`, 'i'),
  // "sponsorship is not available", "sponsorship is unavailable", "sponsorship isn't offered"
  /\bsponsorship\s+(?:(?:is|are|will be|would be|can be|may be)\s+)?(?:not|never)\s+(?:be\s+)?(?:available|offered|provided|possible|supported|considered|an option)\b/i,
  /\bsponsorship\s+(?:is\s+)?unavailable\b/i,
  // "sponsorship will not be provided"
  /\bsponsorship\s+(?:will|would|shall|does|do)\s+(?:not|never)\s+(?:be\s+)?(?:available|offered|provided|possible|supported|considered|extended|an option)\b/i,
  /\bsponsorship\s+(?:isn't|aren't|won't be|can't be|cannot be)\s+(?:available|offered|provided|possible|supported|considered)\b/i,
  // "Visa sponsorship: not available"
  /\bsponsorship\s*[:\-–]\s*(?:not\s+(?:available|offered|provided)|no\b|none\b|unavailable)/i,
  // "not eligible for sponsorship"
  new RegExp(String.raw`\b(?:not\s+(?:be\s+)?|(?:isn't|aren't)\s+|in)eligible\s+for\s+${SPONSOR_OBJECT}sponsorship\b`, 'i'),
  // "authorized to work in the US without sponsorship", not "with or without sponsorship"
  new RegExp(String.raw`(?<!\bor\s)\bwithout\s+(?:(?:the\s+)?need\s+(?:for|of)\s+|needing\s+|requiring\s+|requirement\s+(?:of|for)\s+)?(?:current\s+or\s+future\s+)?${SPONSOR_OBJECT}sponsorship\b`, 'i'),
  // "must not require sponsorship now or in the future"
  new RegExp(String.raw`\b(?:must|need to|should|will)\s+(?:not|never)\s+(?:now or in the future\s+)?require\b[^.\n]{0,25}\bsponsorship\b`, 'i'),
  new RegExp(String.raw`\bnot\s+require\s+${SPONSOR_OBJECT}sponsorship\b[^.\n]{0,40}\b(?:now or in the future|now or later|in the future)\b`, 'i'),
  // "candidates who require sponsorship will not be considered"
  new RegExp(String.raw`\b(?:not|unable to|cannot|can't)\s+(?:be\s+)?(?:consider|accept|hire|review)\w*\b[^.\n]{0,50}\b(?:requir|need|seek)\w*\s+${SPONSOR_OBJECT}sponsorship\b`, 'i'),
  new RegExp(String.raw`\b(?:requir|need|seek)\w*\s+${SPONSOR_OBJECT}sponsorship\b[^.\n]{0,30}\b(?:will not|won't|cannot|can't|are not|aren't|is not|isn't)\s+(?:be\s+)?(?:considered|eligible|accepted|able|hired|reviewed)\b`, 'i')
]

/**
 * Whether the owner needs sponsorship for this job. With work authorization listed per country, the entry for the
 * job's country decides, and a country with no entry counts as needing it. A job whose country is unknown needs
 * it only when no entry is free of it. Without entries, the preference setting decides.
 */
function needsSponsorshipFor(job: FilterJob, prefs: JobPreferences, entries: AuthorizationEntry[] | undefined): boolean {
  const listed = (entries ?? []).filter((e) => e.country.trim())
  if (listed.length === 0) return prefs.needsVisaSponsorship
  const countries = new Set<string>()
  for (const part of locationParts(job.location ?? '')) {
    const country = countryOf(part)
    if (country) countries.add(country)
  }
  if (countries.size === 0) return listed.every(sponsorshipNeeds)
  // A job in several countries is open to the owner when any one of them needs no sponsorship.
  return [...countries].every((country) => {
    const entry = listed.find((e) => countryOf(e.country) === country)
    return entry ? sponsorshipNeeds(entry) : true
  })
}

function noSponsorship(description: string): boolean {
  const text = description.replace(/[’‘]/g, "'")
  return NO_SPONSORSHIP.some((re) => re.test(text))
}

const ANYWHERE = /\b(anywhere|worldwide|global|multiple locations|various|flexible|remote)\b/i

/** Words that describe an area without naming the place, so they don't have to appear in the job's location. */
const AREA_WORDS = new Set(['area', 'greater', 'metro', 'metropolitan', 'region', 'county', 'city'])

/**
 * A short name that carries no state, country or comma ("Provo", "Kuala Lumpur"). The table of places
 * does not know it, so the filter cannot rule it out and the job goes on to scoring.
 */
function isUnplacedCity(part: string): boolean {
  if (/[,(/\-–]/.test(part) || part.split(/\s+/).length > 3) return false
  return countryOf(part) === null && regionOf(part) === null
}

function partMatches(part: string, wanted: string[]): boolean {
  if (isUnplacedCity(part)) return true
  const loc = part.toLowerCase()
  return wanted.some((w) => {
    const target = w.toLowerCase().trim()
    if (!target) return false
    if (loc.includes(target)) return true
    // A country preference ("United States") covers any city or state in that country,
    // and a state or province preference ("California") covers its cities ("San Jose, CA").
    if (isCountryName(w) && countryOf(part) !== null && countryOf(part) === countryOf(w)) return true
    const wantedRegion = regionOf(w)
    const wantedIsRegion = wantedRegion !== null && !w.includes(',')
    if (wantedIsRegion && regionOf(part) === wantedRegion) return true
    // A country, state or province is settled by the checks above. Matching on its words would let
    // "United Kingdom" pass "Austin, United States" and "North Carolina" pass "Fargo, North Dakota".
    if (isCountryName(w) || wantedIsRegion) return false
    // "San Francisco Bay Area" and "San Francisco, CA" share their place words. Every one of them
    // has to appear, so "South Africa" does not pass "Seoul, South Korea".
    const words = target.split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 4 && !AREA_WORDS.has(x))
    return words.length > 0 && words.every((x) => loc.includes(x))
  })
}

/** A job in several cities ("New York; London") passes when any one of them fits. */
function locationMatches(location: string, wanted: string[]): boolean {
  if (ANYWHERE.test(location)) return true
  return locationParts(location).some((part) => partMatches(part, wanted))
}

/**
 * Free, deterministic checks. The first rule that fails drops the job with a short reason.
 * Values the job doesn't state (unknown remote type, no pay, no date) always pass.
 */
export function applyFilters(job: FilterJob, prefs: JobPreferences, ctx: FilterContext): FilterResult {
  const fail = (reason: string): FilterResult => ({ pass: false, reason })
  const companyNorm = normalizeCompany(job.company)

  if (ctx.blockedCompanies.has(companyNorm)) return fail('company blocked')

  for (const word of prefs.excludeTitleKeywords) {
    if (word.trim() && hasWord(job.title, word.trim())) return fail(`excluded title word: ${word.trim().toLowerCase()}`)
  }
  for (const word of prefs.excludeDescriptionKeywords) {
    if (word.trim() && hasWord(job.description, word.trim())) return fail(`excluded description word: ${word.trim().toLowerCase()}`)
  }

  const targets = prefs.targetTitles.map((t) => titleWords(t)).filter((w) => w.length > 0)
  if (targets.length > 0) {
    const words = new Set(titleWords(job.title))
    if (!targets.some((t) => t.some((w) => words.has(w)))) return fail("title doesn't match your target roles")
  }

  if (prefs.seniority.length > 0) {
    const found = titleSeniority(job.title)
    if (found) {
      if (!prefs.seniority.includes(found.level)) return fail(`seniority: ${found.word}`)
    } else if (job.seniority?.length && !job.seniority.some((level) => prefs.seniority.includes(level))) {
      // The title says nothing, so the level the source states decides. Any one of its levels is enough.
      return fail(`seniority: ${job.seniority.join(' or ')}`)
    }
  }

  // An empty list means any type. A job that states no type, or one the app does not know, passes.
  if (prefs.employmentTypes?.length) {
    const types = employmentTypesOf(job.employmentType)
    if (types.length > 0 && !types.some((t) => prefs.employmentTypes.includes(t))) {
      const wanted = prefs.employmentTypes.map((t) => EMPLOYMENT_LABEL[t]).join(' or ')
      return fail(`${types.map((t) => EMPLOYMENT_LABEL[t]).join(' or ')}, you want ${wanted}`)
    }
  }

  if (prefs.remote.length > 0 && job.remote !== 'unknown' && !prefs.remote.includes(job.remote)) {
    const wanted = prefs.remote.map((r) => REMOTE_LABEL[r]).join(' or ')
    return fail(`${REMOTE_LABEL[job.remote]}, you want ${wanted}`)
  }

  if (prefs.locations.length > 0 && job.location && job.remote !== 'remote') {
    // A place the owner would move to is as good as one they live in.
    const moveTo = ctx.relocation?.willing === true ? ctx.relocation.places.map((p) => p.trim()).filter(Boolean) : []
    if (!locationMatches(job.location, [...prefs.locations, ...moveTo])) return fail("location doesn't match")
  }

  if (prefs.maxPostingAgeDays > 0 && job.postedAt) {
    const posted = Date.parse(job.postedAt)
    if (Number.isFinite(posted)) {
      const days = Math.floor((ctx.now - posted) / DAY_MS)
      if (days > prefs.maxPostingAgeDays) return fail(`posted ${days} days ago`)
    }
  }

  if (prefs.minSalary !== null && job.salaryMax !== null) {
    const sameCurrency = !job.salaryCurrency || job.salaryCurrency.toUpperCase() === prefs.salaryCurrency.toUpperCase()
    if (sameCurrency && job.salaryMax < prefs.minSalary) return fail('pay below your minimum')
  }

  if (needsSponsorshipFor(job, prefs, ctx.authorization) && noSponsorship(job.description)) return fail('says no visa sponsorship')

  if (prefs.companyCooldownDays > 0) {
    const limit = Math.max(1, Math.floor(prefs.perCompanyLimit ?? 1))
    const since = ctx.now - prefs.companyCooldownDays * DAY_MS
    const last = ctx.lastAppliedAt(companyNorm)
    const lastMs = last ? Date.parse(last) : NaN
    // A company stays open until it has had its limit of applications inside the window.
    const recent = ctx.appliedCount ? ctx.appliedCount(companyNorm, since) : Number.isFinite(lastMs) && lastMs >= since ? 1 : 0
    if (recent >= limit && Number.isFinite(lastMs)) {
      const days = Math.floor((ctx.now - lastMs) / DAY_MS)
      return fail(`applied to this company ${Math.max(days, 0)} days ago`)
    }
  }

  return { pass: true }
}

/** Groups reasons that differ only by a number or a word, for the analytics screen. */
export function groupReason(reason: string): string {
  if (/^posted \d+ days ago$/.test(reason)) return 'posted too long ago'
  if (/^applied to this company \d+ days ago$/.test(reason)) return 'applied to this company recently'
  if (reason.startsWith('keyword match too low')) return 'keyword match too low'
  if (reason.startsWith('seniority:')) return 'seniority not wanted'
  return reason
}
