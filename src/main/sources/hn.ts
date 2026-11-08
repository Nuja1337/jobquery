import type { RawJob } from '@shared/types'
import { withAtsIdentity } from './detect'
import { fetchJson } from './http'
import { decodeEntities, findSalaryInText, htmlToPlain, inferRemote, matchesQuery, toIsoDate } from './normalize'

// "Ask HN: Who is hiring?" through the Algolia HN API.
//   latest thread: https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring
//   comments:      https://hn.algolia.com/api/v1/items/{threadId}
// Top-level comments usually start "Company | Role | Location | Remote | ...". Formats vary, so the
// parser reads the first line and falls back to sensible defaults.

export interface HnComment {
  id: number
  author?: string | null
  created_at?: string
  text?: string | null
  children?: HnComment[]
}

export interface HnThread {
  id: number
  title?: string
  children?: HnComment[]
}

interface HnSearchHit {
  objectID: string
  title?: string
  author?: string
  created_at?: string
}

const FLAG = /^(remote|onsite|on-site|on site|hybrid|full[- ]?time|part[- ]?time|contract|contractor|intern(ship)?|visa|relocation|h1b|no visa|remote only)\b/i
const ROLE = /(engineer|developer|designer|manager|scientist|analyst|architect|\blead\b|director|head of|product|\bsre\b|devops|\bswe\b|researcher|founder|writer|marketing|sales|recruiter|intern|specialist|administrator|support|consultant|\bcto\b|\bml\b|programmer|technician)/i

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export interface ParsedHeader {
  company: string
  title: string
  location: string | null
  remote: string
}

/** Reads the first line of a comment. Returns null when it doesn't look like a job post. */
export function parseHnHeader(firstLine: string): ParsedHeader | null {
  const line = stripTags(firstLine)
  if (!line) return null
  let parts = line.split('|').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) parts = line.split(/\s[—–-]\s/).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const rawCompany = parts[0]
  const company = rawCompany.replace(/\s*\([^)]*\)\s*$/, '').trim() || rawCompany
  const rest = parts.slice(1)
  const flags = [rawCompany, ...rest.filter((p) => FLAG.test(p))].join(' ')
  const others = rest.filter((p) => !FLAG.test(p))
  // Some posts name no role in the first line. The full text still reaches the scorer.
  const role = others.find((p) => ROLE.test(p)) ?? null
  const location = others.find((p) => p !== role && (/,/.test(p) || /\b(remote|usa|us|uk|eu|europe|canada|germany|london|berlin|nyc|sf|worldwide)\b/i.test(p))) ?? null
  return {
    company: company.slice(0, 120),
    title: (role ?? `Open roles at ${company}`).slice(0, 160),
    location,
    remote: flags
  }
}

export function parseHnThread(thread: HnThread, query?: string): RawJob[] {
  const jobs: RawJob[] = []
  for (const c of thread.children ?? []) {
    if (!c.text) continue
    const firstLine = c.text.split(/<p>|<br\s*\/?>/i)[0]
    const header = parseHnHeader(firstLine)
    if (!header) continue
    const description = htmlToPlain(c.text)
    if (!matchesQuery(description, query)) continue
    const salary = findSalaryInText(description)
    jobs.push(withAtsIdentity({
      source: 'hn_whoishiring',
      externalId: String(c.id),
      company: header.company,
      title: header.title,
      location: header.location,
      remote: inferRemote({ explicit: header.remote, location: header.location, title: header.title, description }),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salaryCurrency: salary?.currency ?? null,
      employmentType: /part[- ]?time/i.test(header.remote) ? 'Part-time' : /contract/i.test(header.remote) ? 'Contract' : null,
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      applyUrl: `https://news.ycombinator.com/item?id=${c.id}`,
      ats: 'unknown',
      atsToken: null,
      description,
      postedAt: toIsoDate(c.created_at)
    }))
  }
  return jobs
}

/** The newest "Who is hiring?" thread by the whoishiring account. */
export function pickLatestThread(hits: HnSearchHit[]): HnSearchHit | null {
  return hits.find((h) => h.author === 'whoishiring' && /who is hiring/i.test(h.title ?? '')) ?? null
}

/** params: query (see matchesQuery). */
export async function fetchHnWhoIsHiring(params: Record<string, string>, signal?: AbortSignal): Promise<RawJob[]> {
  const search = await fetchJson<{ hits?: HnSearchHit[] }>(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10',
    { signal }
  )
  const thread = pickLatestThread(search.hits ?? [])
  if (!thread) throw new Error('Could not find the latest "Who is hiring?" thread.')
  const items = await fetchJson<HnThread>(`https://hn.algolia.com/api/v1/items/${thread.objectID}`, { timeoutMs: 60_000, signal })
  return parseHnThread(items, params.query)
}
