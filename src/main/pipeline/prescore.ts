import type { JobPreferences, Profile } from '@shared/types'
import { stem, titleWords } from './filters'

/** The fields of a job the pre-score reads. */
export interface PrescoreJob {
  title: string
  description: string
}

/**
 * Words that tie a role noun to software or games. "Backend Engineer" and "Engine Programmer" share
 * the role noun with a "Software Engineer" target and have one of these, which counts as the second
 * shared word. "Mechanical Engineer" and "Sales Engineer" have none.
 */
const ENGINEER_QUALIFIERS = new Set(
  'software backend frontend fullstack web mobile ios android application applications platform systems server client network networking infrastructure tools engine gameplay game graphics rendering physics animation audio ai ui technical simulation unity unreal'
    .split(' ')
    .map((w) => stem(w))
)
const DESIGNER_QUALIFIERS = new Set('game level systems combat narrative technical ux ui economy quest mission content'.split(' ').map((w) => stem(w)))

/** Title words a target shares with a job, plus one when the role noun matches and the job has a qualifier. */
function sharedTitleWords(target: string[], words: Set<string>): number {
  const shared = target.filter((w) => words.has(w)).length
  const qualified = (noun: string, qualifiers: Set<string>): boolean =>
    target.includes(noun) && words.has(noun) && [...words].some((w) => qualifiers.has(w))
  if (qualified('engineer', ENGINEER_QUALIFIERS) || qualified('designer', DESIGNER_QUALIFIERS)) return Math.min(target.length, shared + 1)
  return shared
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whole-word match that also works for terms with symbols such as "c++", "c#" and "node.js".
 * One and two letter terms ("R", "Go") must match case, or they would hit ordinary words.
 */
export function containsTerm(text: string, term: string): boolean {
  const t = term.trim()
  if (!t) return false
  const flags = t.length <= 2 ? 'u' : 'iu'
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, flags).test(text)
}

/** Terms the profile and preferences give us to look for. */
export function profileTerms(profile: Profile, prefs: JobPreferences): { skills: string[]; keywords: string[]; titles: string[][] } {
  const skills = [...new Set(profile.skills.map((s) => s.trim()).filter(Boolean))]
  const keywords = [...new Set(prefs.includeKeywords.map((s) => s.trim()).filter(Boolean))]
  const titleSources = [...prefs.targetTitles, ...profile.experience.slice(0, 3).map((e) => e.title)]
  const titles = titleSources.map((t) => titleWords(t)).filter((w) => w.length > 0)
  return { skills, keywords, titles }
}

/**
 * Keyword overlap between the candidate and a posting, 0 to 100. Costs no tokens.
 * Title overlap counts for 40 percent and needs two shared words when the target has two or more.
 * Skills and include keywords found in the posting count for 60 percent, and a hit in the title
 * counts double. With nothing to compare it returns 50, so a new user with an empty profile still
 * gets jobs scored by the AI.
 */
export function prescore(job: PrescoreJob, profile: Profile, prefs: JobPreferences): number {
  const { skills, keywords, titles } = profileTerms(profile, prefs)
  if (skills.length === 0 && keywords.length === 0 && titles.length === 0) return 50

  const jobTitle = job.title
  const body = `${job.title}\n${job.description}`

  let titleScore: number | null = null
  if (titles.length > 0) {
    const words = new Set(titleWords(jobTitle))
    // One shared word is not a match. "Mechanical Engineer" shares "engineer" with "Software Engineer"
    // and says nothing else. A software qualifier ("Backend Engineer") makes the second word.
    // A one-word target needs only that word.
    titleScore = Math.max(
      ...titles.map((target) => {
        const t = [...new Set(target)]
        const shared = sharedTitleWords(t, words)
        return shared >= Math.min(2, t.length) ? shared / t.length : 0
      })
    )
  }

  let termScore: number | null = null
  const terms = [...skills.map((term) => ({ term, weight: 1 })), ...keywords.map((term) => ({ term, weight: 2 }))]
  if (terms.length > 0) {
    let hit = 0
    let possible = 0
    for (const { term, weight } of terms) {
      possible += weight
      if (containsTerm(jobTitle, term)) hit += weight * 2
      else if (containsTerm(body, term)) hit += weight
    }
    // A posting rarely names every skill. Matching a handful is already a strong signal.
    const target = Math.min(possible, 6)
    termScore = Math.min(1, hit / target)
  }

  const score =
    titleScore !== null && termScore !== null ? 0.4 * titleScore + 0.6 * termScore : (titleScore ?? termScore ?? 0.5)
  return Math.round(Math.max(0, Math.min(1, score)) * 100)
}
