import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { fetchJson } from './http'
import { cleanTitle, escapedHtmlToPlain, findSalaryInText, inferRemote, toIsoDate } from './normalize'

// Public board API: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
// `content` is HTML that has been entity-escaped, so it is decoded before it is converted to text.

export interface GreenhouseJob {
  id: number | string
  title: string
  absolute_url?: string
  location?: { name?: string } | null
  company_name?: string
  content?: string
  first_published?: string | null
  updated_at?: string | null
}

export function parseGreenhouseJob(job: GreenhouseJob, token: string, companyName?: string | null): RawJob {
  const description = escapedHtmlToPlain(job.content ?? '')
  const location = job.location?.name?.trim() || null
  const title = cleanTitle(job.title)
  const salary = findSalaryInText(description)
  const url = job.absolute_url || `https://job-boards.greenhouse.io/${token}/jobs/${job.id}`
  return {
    source: 'greenhouse',
    externalId: String(job.id),
    company: companyName || job.company_name || prettifyToken(token),
    title,
    location,
    remote: inferRemote({ location, title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: null,
    url,
    applyUrl: /greenhouse\.io/.test(url) ? url : `https://job-boards.greenhouse.io/${token}/jobs/${job.id}`,
    ats: 'greenhouse',
    atsToken: token,
    description,
    postedAt: toIsoDate(job.first_published) ?? toIsoDate(job.updated_at)
  }
}

export function parseGreenhouse(json: { jobs?: GreenhouseJob[] }, token: string, companyName?: string | null): RawJob[] {
  return (json.jobs ?? []).map((j) => parseGreenhouseJob(j, token, companyName))
}

export async function fetchGreenhouseBoard(token: string, companyName?: string | null, signal?: AbortSignal): Promise<RawJob[]> {
  const json = await fetchJson<{ jobs?: GreenhouseJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
    { timeoutMs: 60_000, signal }
  )
  return parseGreenhouse(json, token, companyName)
}

export async function fetchGreenhouseJob(token: string, jobId: string, companyName?: string | null): Promise<RawJob> {
  const job = await fetchJson<GreenhouseJob>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}`
  )
  return parseGreenhouseJob(job, token, companyName)
}
