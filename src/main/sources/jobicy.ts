import type { RawJob } from '@shared/types'
import { withAtsIdentity } from './detect'
import { employmentLabel, findAtsLink, payPeriodFrom, yearlyPay } from './feeds'
import { fetchJson } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, matchesQuery, toIsoDate } from './normalize'

// https://jobicy.com/api/v2/remote-jobs?count=50&tag=...&geo=...&industry=...
// The response asks that Jobicy is credited and that apply buttons lead to the job URL in the feed, so
// each job keeps its jobicy.com page as `url`. The feed covers the last seven days.
// Politeness: one request per call and at most one call an hour. The source registration should set MIN_HOURS_BETWEEN_CALLS
// to 1 for this source.

export interface JobicyJob {
  id: number | string
  url: string
  jobTitle: string
  companyName: string
  jobIndustry?: string[]
  jobType?: string[]
  jobGeo?: string
  jobLevel?: string
  jobExcerpt?: string
  jobDescription?: string
  /** ISO with an offset, or "YYYY-MM-DD HH:mm:ss" in UTC. */
  pubDate?: string
  salaryMin?: number | null
  salaryMax?: number | null
  salaryCurrency?: string | null
  salaryPeriod?: string | null
}

/** Reads both date styles the API has used. The older one carries no zone and means UTC. */
function parseDate(value: string | undefined): string | null {
  if (!value) return null
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) return toIsoDate(`${text.replace(' ', 'T')}Z`)
  return toIsoDate(text)
}

/** `params.query` is applied here on top of the API's own tag filter. */
export function parseJobicy(json: { jobs?: JobicyJob[] }, params: Record<string, string> = {}): RawJob[] {
  const jobs: RawJob[] = []
  for (const j of json.jobs ?? []) {
    if (!j.jobTitle || !j.companyName || !j.url) continue
    const description = htmlToPlain(j.jobDescription ?? '') || htmlToPlain(j.jobExcerpt ?? '')
    if (!matchesQuery(`${j.jobTitle} ${(j.jobIndustry ?? []).join(' ')} ${description}`, params.query)) continue
    const salary = yearlyPay(j.salaryMin, j.salaryMax, payPeriodFrom(j.salaryPeriod) ?? 'year', j.salaryCurrency) ?? findSalaryInText(description)
    const location = (j.jobGeo ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .join(', ')
    const types = (j.jobType ?? []).map((t) => employmentLabel(t)).filter((t): t is string => Boolean(t))
    const employerLink = findAtsLink(j.jobDescription ?? '')
    jobs.push(
      withAtsIdentity({
        source: 'jobicy' as const,
        externalId: String(j.id),
        company: j.companyName.trim(),
        title: cleanTitle(j.jobTitle),
        location: location || null,
        remote: 'remote' as const,
        salaryMin: salary?.min ?? null,
        salaryMax: salary?.max ?? null,
        salaryCurrency: salary?.currency ?? null,
        employmentType: types.join(', ') || null,
        url: j.url,
        applyUrl: employerLink ?? j.url,
        ats: 'unknown' as const,
        atsToken: null,
        description,
        postedAt: parseDate(j.pubDate)
      })
    )
  }
  return jobs
}

/** params: tag (search word), geo (region such as "usa"), industry, query (extra filter), count (default 50, at most 100). */
export async function fetchJobicy(params: Record<string, string>, signal?: AbortSignal): Promise<RawJob[]> {
  const url = new URL('https://jobicy.com/api/v2/remote-jobs')
  url.searchParams.set('count', String(Math.max(1, Math.min(Number(params.count) || 50, 100))))
  for (const key of ['tag', 'geo', 'industry'] as const) {
    const value = params[key]?.trim()
    if (value) url.searchParams.set(key, value)
  }
  return parseJobicy(await fetchJson<{ jobs?: JobicyJob[] }>(url.toString(), { timeoutMs: 40_000, signal }), params)
}
