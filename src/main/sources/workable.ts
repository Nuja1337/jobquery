import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { fetchJson } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, inferRemote, toIsoDate } from './normalize'

// Widget API: https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
// Without details=true the list has no descriptions.

export interface WorkableJob {
  title: string
  shortcode: string
  employment_type?: string
  telecommuting?: boolean
  url?: string
  application_url?: string
  published_on?: string
  created_at?: string
  country?: string
  city?: string
  state?: string
  description?: string
}

export interface WorkableBoard {
  name?: string
  jobs?: WorkableJob[]
}

export function parseWorkableJob(job: WorkableJob, slug: string, companyName: string): RawJob {
  const description = htmlToPlain(job.description ?? '')
  const location = [job.city, job.state, job.country].filter(Boolean).join(', ') || null
  const title = cleanTitle(job.title)
  const salary = findSalaryInText(description)
  const url = job.url || `https://apply.workable.com/j/${job.shortcode}`
  return {
    source: 'workable',
    externalId: job.shortcode,
    company: companyName,
    title,
    location,
    remote: job.telecommuting ? 'remote' : inferRemote({ location, title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: job.employment_type ?? null,
    url,
    applyUrl: job.application_url || `${url}/apply`,
    ats: 'workable',
    atsToken: slug,
    description,
    postedAt: toIsoDate(job.published_on) ?? toIsoDate(job.created_at)
  }
}

export function parseWorkable(board: WorkableBoard, slug: string, companyName?: string | null): RawJob[] {
  const company = companyName || board.name || prettifyToken(slug)
  return (board.jobs ?? []).map((j) => parseWorkableJob(j, slug, company))
}

export async function fetchWorkableBoard(slug: string, companyName?: string | null, signal?: AbortSignal): Promise<RawJob[]> {
  const board = await fetchJson<WorkableBoard>(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
    { timeoutMs: 60_000, signal }
  )
  return parseWorkable(board, slug, companyName)
}
