import type { Job, PreferenceSuggestion, RemoteType } from '@shared/types'
import type { AppContext } from '../context'
import { normalizeCompany } from './dedupe'
import { getMeta, setMeta } from './ingest'
import { titleWords } from './filters'

const MIN_EVIDENCE = 3
const DISMISSED_KEY = 'dismissed_suggestions'

const SENIOR_KEYWORDS = ['staff', 'principal', 'lead', 'senior', 'sr', 'manager', 'director', 'head of', 'vp', 'vice president', 'chief']
const JUNIOR_KEYWORDS = ['intern', 'internship', 'junior', 'jr', 'entry level', 'graduate', 'trainee']
/** Words too common in job titles to suggest excluding. */
const GENERIC_TITLE_WORDS = new Set(['engineer', 'developer', 'software', 'senior', 'staff', 'manager', 'analyst', 'specialist', 'lead', 'full', 'stack', 'remote', 'engineering', 'data', 'product', 'design', 'designer'])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'iu').test(text)
}

function countBy<T>(items: T[], keys: (item: T) => string[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    for (const key of new Set(keys(item))) {
      const list = out.get(key) ?? []
      list.push(item)
      out.set(key, list)
    }
  }
  return out
}

function money(n: number): string {
  return n.toLocaleString('en-US')
}

export function dismissedSuggestionIds(ctx: AppContext): string[] {
  try {
    const parsed: unknown = JSON.parse(getMeta(ctx.db, DISMISSED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Hides a suggestion so it isn't offered again. */
export function dismissSuggestion(ctx: AppContext, id: string): void {
  const ids = new Set(dismissedSuggestionIds(ctx))
  ids.add(id)
  setMeta(ctx.db, DISMISSED_KEY, JSON.stringify([...ids]))
}

/**
 * Changes to the free filters that the user's own dismissals point to. A suggestion needs three or
 * more dismissed jobs behind it. Suggestions already in effect or already dismissed are left out.
 */
export function suggestPreferences(ctx: AppContext): PreferenceSuggestion[] {
  const prefs = ctx.settings.get().preferences
  const dismissed = ctx.jobs.listDismissed()
  const hidden = new Set(dismissedSuggestionIds(ctx))
  const out: PreferenceSuggestion[] = []
  const add = (s: PreferenceSuggestion) => {
    if (!hidden.has(s.id)) out.push(s)
  }
  const excluded = new Set(prefs.excludeTitleKeywords.map((w) => w.toLowerCase().trim()))
  const tagged = (tag: string) => dismissed.filter((j) => j.dismissTags.includes(tag))

  // Seniority words in the titles of jobs dismissed as too senior or too junior.
  const seniority: Array<{ tag: string; keywords: string[]; label: string }> = [
    { tag: 'too senior', keywords: SENIOR_KEYWORDS, label: 'too senior' },
    { tag: 'too junior', keywords: JUNIOR_KEYWORDS, label: 'too junior' }
  ]
  for (const { tag, keywords, label } of seniority) {
    const groups = countBy(tagged(tag), (j) => keywords.filter((k) => hasWord(j.title, k)))
    for (const [keyword, jobs] of groups) {
      if (jobs.length < MIN_EVIDENCE || excluded.has(keyword)) continue
      add({
        id: `exclude-title:${keyword}`,
        message: `You dismissed ${jobs.length} jobs with "${keyword}" in the title as ${label}. Exclude "${keyword}" from job titles?`,
        evidence: jobs.length,
        patch: { preferences: { excludeTitleKeywords: [...prefs.excludeTitleKeywords, keyword] } }
      })
    }
  }

  // Wrong tech stack: a word that keeps showing up in the titles.
  const known = new Set([...prefs.targetTitles.flatMap((t) => titleWords(t)), ...ctx.profile.get().profile.skills.map((s) => s.toLowerCase())])
  const stackGroups = countBy(tagged('wrong tech stack'), (j) => titleWords(j.title))
  for (const [word, jobs] of stackGroups) {
    if (jobs.length < MIN_EVIDENCE || word.length < 3 || GENERIC_TITLE_WORDS.has(word) || known.has(word) || excluded.has(word)) continue
    add({
      id: `exclude-title:${word}`,
      message: `You dismissed ${jobs.length} jobs with "${word}" in the title as the wrong tech stack. Exclude "${word}" from job titles?`,
      evidence: jobs.length,
      patch: { preferences: { excludeTitleKeywords: [...prefs.excludeTitleKeywords, word] } }
    })
  }

  // Not remote: stop showing the work types that keep getting dismissed.
  const notRemote = tagged('not remote')
  if (notRemote.length >= MIN_EVIDENCE) {
    const seen = new Set<RemoteType>(notRemote.map((j) => j.remote))
    const next = prefs.remote.filter((r) => !(r !== 'remote' && seen.has(r)))
    if (next.length > 0 && next.length < prefs.remote.length) {
      const dropped = prefs.remote.filter((r) => !next.includes(r)).map((r) => (r === 'onsite' ? 'on-site' : r))
      add({
        id: `remote:${next.join('+')}`,
        message: `You dismissed ${notRemote.length} jobs as not remote. Stop showing ${dropped.join(' and ')} jobs?`,
        evidence: notRemote.length,
        patch: { preferences: { remote: next } }
      })
    }
  }

  // One company again and again.
  const blocked = new Set(prefs.excludedCompanies.map(normalizeCompany))
  const companies = countBy(dismissed, (j) => [normalizeCompany(j.company)])
  for (const [norm, jobs] of companies) {
    if (jobs.length < MIN_EVIDENCE || blocked.has(norm)) continue
    const name = jobs[0].company
    add({
      id: `exclude-company:${norm}`,
      message: `You dismissed ${jobs.length} jobs from ${name}. Stop showing jobs from ${name}?`,
      evidence: jobs.length,
      patch: { preferences: { excludedCompanies: [...prefs.excludedCompanies, name] } }
    })
  }

  // Pay too low: raise the minimum above the best of the jobs you turned down.
  const lowPay = tagged('pay too low').filter((j: Job) => j.salaryMax !== null && (!j.salaryCurrency || j.salaryCurrency.toUpperCase() === prefs.salaryCurrency.toUpperCase()))
  if (lowPay.length >= MIN_EVIDENCE) {
    const highest = Math.max(...lowPay.map((j) => j.salaryMax!))
    const minimum = Math.ceil((highest + 1) / 5000) * 5000
    if (prefs.minSalary === null || minimum > prefs.minSalary) {
      add({
        id: `min-salary:${minimum}`,
        message: `You dismissed ${lowPay.length} jobs as paying too little. The best of them paid up to ${money(highest)} ${prefs.salaryCurrency} a year. Set your minimum pay to ${money(minimum)}?`,
        evidence: lowPay.length,
        patch: { preferences: { minSalary: minimum } }
      })
    }
  }

  return out.sort((a, b) => b.evidence - a.evidence || a.id.localeCompare(b.id))
}
