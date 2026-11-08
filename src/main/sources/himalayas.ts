import type { RawJob } from '@shared/types'
import { withAtsIdentity } from './detect'
import { employmentLabel, findAtsLink, payPeriodFrom, yearlyPay } from './feeds'
import { fetchJson } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, matchesQuery, toIsoDate } from './normalize'

// Himalayas job feed.
//   browse: https://himalayas.app/jobs/api?limit=20&cursor=...   (cursor paging, 20 jobs a page)
//   search: https://himalayas.app/jobs/api/search?q=...&page=N   (20 jobs a page, no cursor)
// Himalayas' terms ask for attribution. Each job keeps its himalayas.app page as `url` and the text
// "Originally posted on Himalayas" that the feed puts at the end of the description. The site's own
// pages answer 403 to plain HTTP, so the apply link stays the Himalayas page unless the description
// links to an employer posting on an application system JobPilot can read.
// Politeness: the feed changes slowly. The source registration should set MIN_HOURS_BETWEEN_CALLS to 6, so a saved search
// calls it at most four times a day. One call reads at most `pages` pages (default 3, at most 10).
// The browse feed covers every kind of job, so a query switches the fetcher to the search endpoint,
// which does its own matching.

export interface HimalayasJob {
  title: string
  excerpt?: string
  companyName: string
  companySlug?: string
  employmentType?: string
  minSalary?: number | null
  maxSalary?: number | null
  salaryPeriod?: string | null
  currency?: string | null
  seniority?: string[]
  locationRestrictions?: string[]
  description?: string
  /** Unix seconds. */
  pubDate?: number
  /** Unix seconds. */
  expiryDate?: number
  applicationLink?: string
  guid?: string
}

export interface HimalayasResponse {
  jobs?: HimalayasJob[]
  totalCount?: number
  nextCursor?: string | null
}

/** The page address without the tracking parameter the API adds to `applicationLink`. */
function pageUrl(j: HimalayasJob): string {
  if (j.guid) return j.guid
  return (j.applicationLink ?? '').replace(/[?#].*$/, '')
}

/**
 * `params.query` filters by title, categories and description. Leave it out for results that the
 * search endpoint already matched. Jobs whose expiry date has passed at `now` are dropped.
 */
export function parseHimalayas(json: HimalayasResponse, params: Record<string, string> = {}, now: number = Date.now()): RawJob[] {
  const jobs: RawJob[] = []
  for (const j of json.jobs ?? []) {
    if (!j.title || !j.companyName) continue
    if (typeof j.expiryDate === 'number' && j.expiryDate * 1000 < now) continue
    const url = pageUrl(j)
    if (!url) continue
    const description = htmlToPlain(j.description ?? '') || (j.excerpt ?? '').trim()
    if (!matchesQuery(`${j.title} ${description}`, params.query)) continue
    const salary =
      yearlyPay(j.minSalary, j.maxSalary, payPeriodFrom(j.salaryPeriod), j.currency) ?? findSalaryInText(description)
    const places = (j.locationRestrictions ?? []).map((p) => p.trim()).filter(Boolean)
    const employerLink = findAtsLink(j.description ?? '')
    jobs.push(
      withAtsIdentity({
        source: 'himalayas' as const,
        externalId: url,
        company: j.companyName.trim(),
        title: cleanTitle(j.title),
        location: places.length ? places.join('; ') : 'Worldwide',
        remote: 'remote' as const,
        salaryMin: salary?.min ?? null,
        salaryMax: salary?.max ?? null,
        salaryCurrency: salary?.currency ?? null,
        employmentType: employmentLabel(j.employmentType),
        url,
        applyUrl: employerLink ?? url,
        ats: 'unknown' as const,
        atsToken: null,
        description,
        postedAt: toIsoDate(j.pubDate)
      })
    )
  }
  return jobs
}

const PAGE_SIZE = 20

/** params: query (comma separates alternatives, at most three), pages (default 3, at most 10). */
export async function fetchHimalayas(params: Record<string, string>, signal?: AbortSignal): Promise<RawJob[]> {
  const pages = Math.max(1, Math.min(Number(params.pages) || 3, 10))
  const byId = new Map<string, RawJob>()
  const add = (list: RawJob[]): void => {
    for (const job of list) if (!byId.has(job.externalId)) byId.set(job.externalId, job)
  }
  const alternatives = (params.query ?? '')
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 3)

  if (alternatives.length === 0) {
    let cursor: string | null = null
    for (let page = 0; page < pages; page++) {
      const url: string = `https://himalayas.app/jobs/api?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const json: HimalayasResponse = await fetchJson<HimalayasResponse>(url, { timeoutMs: 40_000, signal })
      add(parseHimalayas(json))
      cursor = json.nextCursor ?? null
      if (!cursor || (json.jobs ?? []).length < PAGE_SIZE) break
    }
    return [...byId.values()]
  }

  for (const query of alternatives) {
    for (let page = 1; page <= pages; page++) {
      const json = await fetchJson<HimalayasResponse>(
        `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&page=${page}`,
        { timeoutMs: 40_000, signal }
      )
      add(parseHimalayas(json))
      if ((json.jobs ?? []).length < PAGE_SIZE || page * PAGE_SIZE >= (json.totalCount ?? 0)) break
    }
  }
  return [...byId.values()]
}
