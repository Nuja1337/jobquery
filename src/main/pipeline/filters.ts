import type { JobPreferences, RemoteType, Seniority } from '@shared/types'
import { normalizeCompany } from './dedupe'
import { countryOf, isCountryName, regionOf } from '../util/geo'

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
}

export interface FilterContext {
  /** Epoch milliseconds, passed in so tests don't depend on the clock. */
  now: number
  /** Normalized names of companies the user blocked. */
  blockedCompanies: Set<string>
  /** ISO time the user last applied to a company, or null. Takes a normalized name. */
  lastAppliedAt(companyNorm: string): string | null
}

export type FilterResult = { pass: true } | { pass: false; reason: string }

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Title words
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(['and', 'or', 'of', 'the', 'for', 'in', 'at', 'to', 'a', 'an', 'with', 'on', 'i', 'ii', 'iii', 'iv', 'remote', 'us', 'uk', 'eu', 'emea', 'apac', 'new', 'team'])

/** Seniority words as they appear in titles, mapped to the seniority levels in settings. */
const SENIORITY_WORDS: Array<{ pattern: RegExp; word: string; level: Seniority }> = [
  { pattern: /\b(intern|internship|trainee|working student|werkstudent)\b/, word: 'intern', level: 'intern' },
  { pattern: /\b(junior|jr|entry[- ]level|graduate)\b/, word: 'junior', level: 'junior' },
  { pattern: /\b(senior|sr)\b/, word: 'senior', level: 'senior' },
  { pattern: /\bstaff\b/, word: 'staff', level: 'staff' },
  { pattern: /\bprincipal\b/, word: 'principal', level: 'principal' },
  { pattern: /\blead\b(?!\s+gen)/, word: 'lead', level: 'staff' },
  { pattern: /\b(manager|management)\b/, word: 'manager', level: 'manager' },
  { pattern: /\b(director|head of)\b/, word: 'director', level: 'director' },
  { pattern: /\b(vp|vice president|chief|cto|ceo|cfo|coo)\b/, word: 'vp', level: 'executive' }
]

/** Words that signal seniority. Ignored when matching a title against target titles. */
const SENIORITY_TOKENS = new Set(['intern', 'internship', 'trainee', 'junior', 'jr', 'senior', 'sr', 'staff', 'principal', 'lead', 'director', 'head', 'vp', 'vice', 'president', 'chief', 'associate', 'graduate'])

/** "Product Manager" names a function, not a management level, so it doesn't count as seniority. */
const FUNCTIONAL_MANAGER =
  /\b(?:product|project|program|account|marketing|sales|brand|community|content|customer success|customer|office|operations|business|general|store|category|partner|partnerships|recruiting|talent|finance|hr)\s+manager\b/g

export function titleSeniority(title: string): { word: string; level: Seniority } | null {
  const t = title.toLowerCase().replace(FUNCTIONAL_MANAGER, ' ')
  for (const s of SENIORITY_WORDS) if (s.pattern.test(t)) return { word: s.word, level: s.level }
  return null
}

function stem(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

/** Meaningful words of a title: no seniority, no stop words, simple plurals folded. */
export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !SENIORITY_TOKENS.has(w))
    .map(stem)
}

function hasWord(text: string, word: string): boolean {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text)
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

const REMOTE_LABEL: Record<RemoteType, string> = { remote: 'remote', hybrid: 'hybrid', onsite: 'on-site', unknown: 'unknown' }

function noSponsorship(description: string): boolean {
  return (
    /\b(?:no|not|unable to|cannot|can't|can not|do not|does not|don't|doesn't|won't|will not|without)\b[^.\n]{0,50}\b(?:visa\s+)?sponsor/i.test(description) ||
    /\bsponsorship\b[^.\n]{0,30}\b(?:is |are )?(?:not|unavailable)\b/i.test(description) ||
    /\bmust\b[^.\n]{0,40}\b(?:authorized|authorised|eligible)\b[^.\n]{0,60}\bwithout\b[^.\n]{0,30}\bsponsor/i.test(description)
  )
}

const ANYWHERE = /\b(anywhere|worldwide|global|multiple locations|various|flexible|remote)\b/i

/** Words that describe an area without naming the place, so they don't have to appear in the job's location. */
const AREA_WORDS = new Set(['area', 'greater', 'metro', 'metropolitan', 'region', 'county', 'city'])

function locationMatches(location: string, wanted: string[]): boolean {
  if (ANYWHERE.test(location)) return true
  const loc = location.toLowerCase()
  return wanted.some((w) => {
    const target = w.toLowerCase().trim()
    if (!target) return false
    if (loc.includes(target)) return true
    // A country preference ("United States") covers any city or state in that country,
    // and a state or province preference ("California") covers its cities ("San Jose, CA").
    if (isCountryName(w) && countryOf(location) !== null && countryOf(location) === countryOf(w)) return true
    const wantedRegion = regionOf(w)
    const wantedIsRegion = wantedRegion !== null && !w.includes(',')
    if (wantedIsRegion && regionOf(location) === wantedRegion) return true
    // A country, state or province is settled by the checks above. Matching on its words would let
    // "United Kingdom" pass "Austin, United States" and "North Carolina" pass "Fargo, North Dakota".
    if (isCountryName(w) || wantedIsRegion) return false
    // "San Francisco Bay Area" and "San Francisco, CA" share their place words. Every one of them
    // has to appear, so "South Africa" does not pass "Seoul, South Korea".
    const words = target.split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 4 && !AREA_WORDS.has(x))
    return words.length > 0 && words.every((x) => loc.includes(x))
  })
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
    if (found && !prefs.seniority.includes(found.level)) return fail(`seniority: ${found.word}`)
  }

  if (prefs.remote.length > 0 && job.remote !== 'unknown' && !prefs.remote.includes(job.remote)) {
    const wanted = prefs.remote.map((r) => REMOTE_LABEL[r]).join(' or ')
    return fail(`${REMOTE_LABEL[job.remote]}, you want ${wanted}`)
  }

  if (prefs.locations.length > 0 && job.location && job.remote !== 'remote' && !locationMatches(job.location, prefs.locations)) {
    return fail("location doesn't match")
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

  if (prefs.needsVisaSponsorship && noSponsorship(job.description)) return fail('says no visa sponsorship')

  if (prefs.companyCooldownDays > 0) {
    const last = ctx.lastAppliedAt(companyNorm)
    if (last) {
      const days = Math.floor((ctx.now - Date.parse(last)) / DAY_MS)
      if (days < prefs.companyCooldownDays) return fail(`applied to this company ${Math.max(days, 0)} days ago`)
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
