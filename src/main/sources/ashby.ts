import { createHash } from 'node:crypto'
import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { type BoardChanges, type BoardReadState, fetchConditional, fetchJson } from './http'
import { cleanTitle, findSalaryInText, inferRemote, toIsoDate } from './normalize'

// Public job board API: https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
// It lists every posting with its plain-text description, so a single posting is found by listing the board.

interface AshbyComponent {
  compensationType?: string
  interval?: string
  currencyCode?: string | null
  minValue?: number | null
  maxValue?: number | null
}

export interface AshbyJob {
  id: string
  title: string
  location?: string
  secondaryLocations?: Array<{ location?: string }>
  employmentType?: string
  workplaceType?: string
  isRemote?: boolean
  isListed?: boolean
  publishedAt?: string
  jobUrl?: string
  applyUrl?: string
  descriptionPlain?: string
  compensation?: { summaryComponents?: AshbyComponent[] } | null
}

const EMPLOYMENT: Record<string, string> = {
  FullTime: 'Full-time',
  PartTime: 'Part-time',
  Contract: 'Contract',
  Intern: 'Internship',
  Temporary: 'Temporary'
}

function salaryOf(job: AshbyJob, description: string) {
  const salary = job.compensation?.summaryComponents?.find(
    (c) => c.compensationType === 'Salary' && typeof c.minValue === 'number' && typeof c.maxValue === 'number'
  )
  if (salary) {
    const factor = /HOUR/i.test(salary.interval ?? '') ? 2080 : /MONTH/i.test(salary.interval ?? '') ? 12 : 1
    return { min: Math.round(salary.minValue! * factor), max: Math.round(salary.maxValue! * factor), currency: salary.currencyCode ?? null }
  }
  return findSalaryInText(description)
}

/** The primary location first, then the others. Repeats are dropped. */
function joinLocations(places: Array<string | undefined>): string | null {
  const seen = new Set<string>()
  const list: string[] = []
  for (const place of places) {
    const name = place?.trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    list.push(name)
  }
  return list.join('; ') || null
}

export function parseAshbyJob(job: AshbyJob, org: string, companyName?: string | null): RawJob {
  const description = (job.descriptionPlain ?? '').trim()
  const title = cleanTitle(job.title)
  const location = joinLocations([job.location, ...(job.secondaryLocations ?? []).map((l) => l.location)])
  // The `isRemote` flag is true when any listed location is remote, so the workplace type comes first.
  const explicit = job.workplaceType && job.workplaceType !== 'Unspecified' ? job.workplaceType : job.isRemote ? 'remote' : null
  const salary = salaryOf(job, description)
  const url = job.jobUrl || `https://jobs.ashbyhq.com/${org}/${job.id}`
  return {
    source: 'ashby',
    externalId: job.id,
    company: companyName || prettifyToken(org),
    title,
    location,
    remote: inferRemote({ explicit, location, title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: job.employmentType ? (EMPLOYMENT[job.employmentType] ?? job.employmentType) : null,
    url,
    applyUrl: job.applyUrl || `${url}/application`,
    ats: 'ashby',
    atsToken: org,
    atsJobId: job.id,
    description,
    postedAt: toIsoDate(job.publishedAt)
  }
}

export function parseAshby(json: { jobs?: AshbyJob[] }, org: string, companyName?: string | null): RawJob[] {
  return (json.jobs ?? []).filter((j) => j.isListed !== false).map((j) => parseAshbyJob(j, org, companyName))
}

export async function fetchAshbyBoard(org: string, companyName?: string | null, signal?: AbortSignal): Promise<RawJob[]> {
  const json = await fetchJson<{ jobs?: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
    { timeoutMs: 60_000, signal }
  )
  return parseAshby(json, org, companyName)
}

/** Reads a board only when its ETag changed. A changed board comes back whole, since Ashby lists every posting with its text. */
export async function fetchAshbyBoardChanges(
  org: string,
  companyName: string | null | undefined,
  state: BoardReadState,
  signal?: AbortSignal
): Promise<BoardChanges> {
  const result = await fetchConditional<{ jobs?: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
    { etag: state.etag, lastModified: state.lastModified, timeoutMs: 60_000, signal }
  )
  if (result.status === 304) return { changed: false }
  const listHash = createHash('sha1').update(JSON.stringify(result.json)).digest('hex')
  if (listHash === state.listHash) return { changed: false, etag: result.etag, lastModified: result.lastModified, listHash }
  return { changed: true, jobs: parseAshby(result.json, org, companyName), etag: result.etag, lastModified: result.lastModified, listHash }
}
