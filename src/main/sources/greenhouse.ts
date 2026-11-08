import { createHash } from 'node:crypto'
import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { type BoardChanges, type BoardReadState, HttpError, fetchConditional, fetchJson, mapLimit } from './http'
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
    atsJobId: String(job.id),
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

/** More new postings than this are read with one full list, which costs one request instead of one each. */
const MAX_DETAIL_REQUESTS = 5

const hashList = (jobs: GreenhouseJob[]) =>
  createHash('sha1')
    .update(jobs.map((j) => `${j.id}:${j.updated_at ?? ''}`).sort().join('\n'))
    .digest('hex')

/**
 * Reads a board only when it changed. The list comes without descriptions, which makes it about 20
 * times smaller, and the board's ETag lets an unchanged board answer 304. Postings that are stored
 * already come back as seen ids. Their text is not fetched again. Postings that are new are fetched one by
 * one, or with one full list when there are many.
 */
export async function fetchGreenhouseBoardChanges(
  token: string,
  companyName: string | null | undefined,
  state: BoardReadState,
  signal?: AbortSignal
): Promise<BoardChanges> {
  const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`
  const list = await fetchConditional<{ jobs?: GreenhouseJob[] }>(base, {
    etag: state.etag,
    lastModified: state.lastModified,
    timeoutMs: 60_000,
    signal
  })
  if (list.status === 304) return { changed: false }
  const listed = list.json.jobs ?? []
  const listHash = hashList(listed)
  if (listHash === state.listHash) return { changed: false, etag: list.etag, lastModified: list.lastModified, listHash }

  const known = state.known ?? new Set<string>()
  const fresh = listed.filter((j) => !known.has(String(j.id)))
  const seen = listed.filter((j) => known.has(String(j.id))).map((j) => String(j.id))
  if (fresh.length === 0) {
    return { changed: true, jobs: [], seenExternalIds: seen, etag: list.etag, lastModified: list.lastModified, listHash }
  }
  if (fresh.length > MAX_DETAIL_REQUESTS) {
    const full = await fetchJson<{ jobs?: GreenhouseJob[] }>(`${base}?content=true`, { timeoutMs: 60_000, signal })
    return {
      changed: true,
      jobs: parseGreenhouse(full, token, companyName),
      etag: list.etag,
      lastModified: list.lastModified,
      listHash
    }
  }
  const failedIds: string[] = []
  const details = await mapLimit(fresh, 2, async (item) => {
    try {
      return await fetchJson<GreenhouseJob>(`${base}/${encodeURIComponent(String(item.id))}`, { signal })
    } catch (err) {
      // A host that is pausing us is not a posting that went away. Let the caller reschedule.
      if (signal?.aborted || (err instanceof HttpError && err.status === 429)) throw err
      failedIds.push(String(item.id))
      return null
    }
  })
  const jobs = details.filter((d): d is GreenhouseJob => d !== null).map((d) => parseGreenhouseJob(d, token, companyName))
  // A posting that could not be read still counts as listed, so it is not closed. It must be tried
  // again, so the next check reads the list again.
  const failed = failedIds.length > 0
  return {
    changed: true,
    jobs,
    seenExternalIds: [...seen, ...failedIds],
    etag: failed ? null : list.etag,
    lastModified: failed ? null : list.lastModified,
    listHash: failed ? null : listHash
  }
}
