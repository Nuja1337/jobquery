import type { RawJob } from '@shared/types'
import { withAtsIdentity } from './detect'
import { fetchJson } from './http'
import { cleanTitle, htmlToPlain, matchesQuery, toIsoDate } from './normalize'

// https://remoteok.com/api
//
// Remote OK API terms, from the legal notice in the first element of the response:
// link back to the job's Remote OK URL (with follow, without nofollow) and mention Remote OK as the
// source. Don't use the Remote OK logo without written permission, the name is fine.
// So every job here keeps its remoteok.com link as `url` and shows "remoteok" as its source.

export interface RemoteOkJob {
  id?: string | number
  slug?: string
  epoch?: number
  date?: string
  company?: string
  position?: string
  tags?: string[]
  description?: string
  location?: string
  apply_url?: string
  url?: string
  salary_min?: number
  salary_max?: number
  legal?: string
}

export function parseRemoteOk(list: RemoteOkJob[], query?: string): RawJob[] {
  const jobs: RawJob[] = []
  // The first element is the legal notice, so skip anything without a position.
  for (const j of list) {
    if (!j.position || !j.company || (j.id === undefined && !j.slug)) continue
    const description = htmlToPlain(j.description ?? '')
    if (!matchesQuery(`${j.position} ${(j.tags ?? []).join(' ')} ${description}`, query)) continue
    const link = j.url || j.apply_url || `https://remoteok.com/remote-jobs/${j.slug}`
    const hasPay = (j.salary_min ?? 0) > 0 && (j.salary_max ?? 0) > 0
    jobs.push(withAtsIdentity({
      source: 'remoteok',
      externalId: String(j.id ?? j.slug),
      company: j.company.trim(),
      title: cleanTitle(j.position),
      location: j.location?.trim() || null,
      remote: 'remote',
      salaryMin: hasPay ? j.salary_min! : null,
      salaryMax: hasPay ? j.salary_max! : null,
      salaryCurrency: hasPay ? 'USD' : null,
      employmentType: null,
      url: link,
      applyUrl: j.apply_url || link,
      ats: 'unknown',
      atsToken: null,
      description,
      postedAt: toIsoDate(j.epoch) ?? toIsoDate(j.date)
    }))
  }
  return jobs
}

/** params: query (words to match), tag (server-side tag filter such as "python"). */
export async function fetchRemoteOk(params: Record<string, string>, signal?: AbortSignal): Promise<RawJob[]> {
  const url = new URL('https://remoteok.com/api')
  if (params.tag) url.searchParams.set('tag', params.tag)
  const list = await fetchJson<RemoteOkJob[]>(url.toString(), { signal })
  return parseRemoteOk(Array.isArray(list) ? list : [], params.query)
}
