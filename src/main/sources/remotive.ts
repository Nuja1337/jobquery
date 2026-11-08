import type { RawJob } from '@shared/types'
import { withAtsIdentity } from './detect'
import { fetchJson } from './http'
import { cleanTitle, htmlToPlain, parseSalary, toIsoDate } from './normalize'

// https://remotive.com/api/remote-jobs?search=...&category=...&limit=...
// Remotive's terms: link back to the Remotive URL of each job and name Remotive as the source,
// and don't call the API more than about four times a day. Each job keeps Remotive's own url,
// and the job's source is shown as "remotive" in the app.

export interface RemotiveJob {
  id: number | string
  url: string
  title: string
  company_name: string
  category?: string
  job_type?: string
  publication_date?: string
  candidate_required_location?: string
  salary?: string
  description?: string
}

const JOB_TYPES: Record<string, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  freelance: 'Freelance',
  internship: 'Internship'
}

export function parseRemotive(json: { jobs?: RemotiveJob[] }): RawJob[] {
  return (json.jobs ?? []).map((j) => {
    const salary = parseSalary(j.salary, { fieldOnly: true, defaultCurrency: 'USD' })
    const location = j.candidate_required_location?.trim() || null
    return withAtsIdentity({
      source: 'remotive' as const,
      externalId: String(j.id),
      company: j.company_name.trim(),
      title: cleanTitle(j.title),
      location,
      remote: 'remote' as const,
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salaryCurrency: salary?.currency ?? null,
      employmentType: j.job_type ? (JOB_TYPES[j.job_type] ?? j.job_type) : null,
      url: j.url,
      applyUrl: j.url,
      ats: 'unknown' as const,
      atsToken: null,
      description: htmlToPlain(j.description ?? ''),
      postedAt: toIsoDate(j.publication_date)
    })
  })
}

/** params: query (search text), category, limit (default 100). */
export async function fetchRemotive(params: Record<string, string>, signal?: AbortSignal): Promise<RawJob[]> {
  const url = new URL('https://remotive.com/api/remote-jobs')
  if (params.query) url.searchParams.set('search', params.query)
  if (params.category) url.searchParams.set('category', params.category)
  url.searchParams.set('limit', params.limit || '100')
  return parseRemotive(await fetchJson<{ jobs?: RemotiveJob[] }>(url.toString(), { signal }))
}
