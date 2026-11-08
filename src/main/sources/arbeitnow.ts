import type { RawJob } from '@shared/types'
import { withAtsIdentity } from './detect'
import { fetchJson } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, inferRemote, matchesQuery, toIsoDate } from './normalize'

// https://www.arbeitnow.com/api/job-board-api
// A free public API. Arbeitnow asks for a link back, so each job keeps its arbeitnow.com url.
// The feed has no search parameter, so the query is applied here.

export interface ArbeitnowJob {
  slug: string
  company_name: string
  title: string
  description?: string
  remote?: boolean
  url: string
  tags?: string[]
  job_types?: string[]
  location?: string
  created_at?: number
}

export function parseArbeitnow(json: { data?: ArbeitnowJob[] }, params: Record<string, string> = {}): RawJob[] {
  const jobs: RawJob[] = []
  const wantedLocation = params.location?.trim().toLowerCase()
  for (const j of json.data ?? []) {
    const description = htmlToPlain(j.description ?? '')
    if (!matchesQuery(`${j.title} ${(j.tags ?? []).join(' ')} ${description}`, params.query)) continue
    if (wantedLocation && !`${j.location ?? ''}`.toLowerCase().includes(wantedLocation) && !j.remote) continue
    const location = j.location?.trim() || null
    const title = cleanTitle(j.title)
    const salary = findSalaryInText(description)
    jobs.push(withAtsIdentity({
      source: 'arbeitnow',
      externalId: j.slug,
      company: j.company_name.trim(),
      title,
      location,
      remote: j.remote ? 'remote' : inferRemote({ location, title }),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salaryCurrency: salary?.currency ?? null,
      employmentType: j.job_types?.join(', ') || null,
      url: j.url,
      applyUrl: j.url,
      ats: 'unknown',
      atsToken: null,
      description,
      postedAt: toIsoDate(j.created_at)
    }))
  }
  return jobs
}

/** params: query, location, pages (how many pages of 100 to read, default 2, at most 5). */
export async function fetchArbeitnow(params: Record<string, string>, signal?: AbortSignal): Promise<RawJob[]> {
  const pages = Math.max(1, Math.min(Number(params.pages) || 2, 5))
  const jobs: RawJob[] = []
  for (let page = 1; page <= pages; page++) {
    const json = await fetchJson<{ data?: ArbeitnowJob[]; links?: { next?: string | null } }>(
      `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
      { timeoutMs: 40_000, signal }
    )
    jobs.push(...parseArbeitnow(json, params))
    if (!json.links?.next) break
  }
  return jobs
}
