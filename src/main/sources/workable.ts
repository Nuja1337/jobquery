import { createHash } from 'node:crypto'
import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { type BoardChanges, type BoardReadState, fetchJson, mapLimit } from './http'
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
  locations?: Array<{ country?: string; city?: string; region?: string; hidden?: boolean }>
  description?: string
}

export interface WorkableBoard {
  name?: string
  jobs?: WorkableJob[]
}

/** Every listed place, the primary one first. Falls back to the single city, state and country. */
function locationOf(job: WorkableJob): string | null {
  const place = (p: { city?: string; region?: string; state?: string; country?: string }) =>
    [p.city, p.region ?? p.state, p.country].filter(Boolean).join(', ')
  const seen = new Set<string>()
  const list: string[] = []
  for (const text of [place(job), ...(job.locations ?? []).filter((l) => !l.hidden).map(place)]) {
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    list.push(text)
  }
  return list.join('; ') || null
}

export function parseWorkableJob(job: WorkableJob, slug: string, companyName: string): RawJob {
  const description = htmlToPlain(job.description ?? '')
  const location = locationOf(job)
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
    atsJobId: job.shortcode,
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

/** More new postings than this are read with one full list instead of one request each. */
const MAX_DETAIL_REQUESTS = 5

interface WorkableDetail {
  description?: string
  requirements?: string
  benefits?: string
}

/**
 * Workable has no ETag, so every check reads the list. The list comes without descriptions, and a
 * description is fetched only for a posting that is not stored yet. Postings that are stored come back
 * as seen ids. A 429 reaches the caller as an HttpError, so it can try the board again later.
 * Workable's limit is the strictest of the supported boards, and the request pacing for its host is slower.
 */
export async function fetchWorkableBoardChanges(
  slug: string,
  companyName: string | null | undefined,
  state: BoardReadState,
  signal?: AbortSignal
): Promise<BoardChanges> {
  const account = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`
  const board = await fetchJson<WorkableBoard>(account, { timeoutMs: 60_000, signal })
  const listed = board.jobs ?? []
  const known = state.known ?? new Set<string>()
  const listHash = createHash('sha1').update(listed.map((j) => j.shortcode).sort().join('\n')).digest('hex')
  const fresh = listed.filter((j) => !known.has(j.shortcode))
  const seen = listed.filter((j) => known.has(j.shortcode)).map((j) => j.shortcode)
  if (fresh.length === 0) {
    return listHash === state.listHash
      ? { changed: false, listHash }
      : { changed: true, jobs: [], seenExternalIds: seen, etag: null, lastModified: null, listHash }
  }
  if (fresh.length > MAX_DETAIL_REQUESTS) {
    const full = await fetchJson<WorkableBoard>(`${account}?details=true`, { timeoutMs: 60_000, signal })
    return { changed: true, jobs: parseWorkable(full, slug, companyName), etag: null, lastModified: null, listHash }
  }
  const company = companyName || board.name || prettifyToken(slug)
  const failedIds: string[] = []
  const details = await mapLimit(fresh, 1, async (item) => {
    try {
      return await fetchJson<WorkableDetail>(
        `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(item.shortcode)}`,
        { signal }
      )
    } catch (err) {
      // A 429 means try the whole board later. Anything else leaves this posting for the next check.
      if (signal?.aborted || (err as { status?: number }).status === 429) throw err
      failedIds.push(item.shortcode)
      return null
    }
  })
  const jobs: RawJob[] = []
  fresh.forEach((item, i) => {
    const detail = details[i]
    if (!detail) return
    const description = [detail.description, detail.requirements, detail.benefits].filter(Boolean).join('<br><br>')
    jobs.push(parseWorkableJob({ ...item, description }, slug, company))
  })
  return { changed: true, jobs, seenExternalIds: [...seen, ...failedIds], etag: null, lastModified: null, listHash: failedIds.length ? null : listHash }
}
