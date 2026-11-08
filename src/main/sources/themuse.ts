import type { RawJob } from '@shared/types'
import { withAtsIdentity } from './detect'
import { findAtsLink } from './feeds'
import { fetchJson, fetchText, HttpError, mapLimit } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, inferRemote, matchesQuery, toIsoDate } from './normalize'

// The Muse public API:
//   https://www.themuse.com/api/public/jobs?page=N&category=...&level=...&location=...
// 20 jobs a page, `page_count` pages, and about 500 requests an hour without a key. Pages above 99 are
// refused, so the fetcher stops at 99. A 403 or 429 after the first page ends the run with the pages
// already read, because the limit has been reached. The shared HTTP helper does not expose response
// headers, so the X-RateLimit-Remaining value cannot be read here.
// Each job's landing page on themuse.com carries the employer's real application link. The page is
// fetched only for jobs that are new, at most 20 per call.

export interface MuseJob {
  id: number | string
  name: string
  contents?: string
  publication_date?: string
  locations?: Array<{ name?: string }>
  categories?: Array<{ name?: string }>
  levels?: Array<{ name?: string }>
  company?: { name?: string }
  refs?: { landing_page?: string }
}

export interface MuseResponse {
  page?: number
  page_count?: number
  results?: MuseJob[]
}

/** The jobs from one page, with the landing page as the apply link until the page itself is read. */
export function parseTheMuse(json: MuseResponse, params: Record<string, string> = {}): RawJob[] {
  const jobs: RawJob[] = []
  for (const j of json.results ?? []) {
    const landing = j.refs?.landing_page
    if (!j.name || !j.company?.name || !landing) continue
    const description = htmlToPlain(j.contents ?? '')
    const categories = (j.categories ?? []).map((c) => c.name ?? '').join(' ')
    if (!matchesQuery(`${j.name} ${categories} ${description}`, params.query)) continue
    const places = (j.locations ?? []).map((l) => l.name?.trim() ?? '').filter(Boolean)
    const location = places.join('; ') || null
    const title = cleanTitle(j.name)
    const salary = findSalaryInText(description)
    jobs.push({
      source: 'themuse',
      externalId: String(j.id),
      company: j.company.name.trim(),
      title,
      location,
      remote: inferRemote({ location, title, description }),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salaryCurrency: salary?.currency ?? null,
      employmentType: null,
      url: landing,
      applyUrl: landing,
      ats: 'unknown',
      atsToken: null,
      description,
      postedAt: toIsoDate(j.publication_date)
    })
  }
  return jobs
}

function isMuseHost(link: string): boolean {
  try {
    return /(^|\.)themuse\.com$/i.test(new URL(link).hostname)
  } catch {
    return true
  }
}

/**
 * The employer's application link on a Muse landing page. The page is a Next.js document and states it as
 * "applyLink" in its embedded data, escaped inside a script string. Links to other sites in the page
 * body are used only when that field is missing. Returns null when the link points back at themuse.com.
 */
export function museApplyLink(html: string): string | null {
  const field = /applyLink\\*"\s*:\s*\\*"((?:[^"\\]|\\u0026|\\\/)+)/.exec(html)
  const cleaned = field?.[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  if (cleaned) return /^https?:\/\//i.test(cleaned) && !isMuseHost(cleaned) ? cleaned : null
  const anchors = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'))
  return findAtsLink(anchors.join('\n'))
}

/** Returns the job with the employer's link applied. A page without a usable link leaves the job as it was. */
export function applyMuseLanding(job: RawJob, html: string): RawJob {
  const link = museApplyLink(html)
  if (!link) return job
  return withAtsIdentity({ ...job, applyUrl: link })
}

export interface MuseOptions {
  /** Postings already stored. Their landing pages are not fetched again. */
  isKnown?: (externalId: string) => boolean
  /** Most pages per call. Default 5, at most 99. */
  maxPages?: number
  /** Most landing pages per call. Default 20. */
  landingLimit?: number
}

function addAll(search: URLSearchParams, key: string, value: string | undefined, separator: string): void {
  for (const part of (value ?? '').split(separator)) {
    const text = part.trim()
    if (text) search.append(key, text)
  }
}

/**
 * params: category, level, location (each may list several values separated by "|"), query (extra
 * filter on title and text), maxPages. `location` takes a value such as "Flexible / Remote".
 */
export async function fetchTheMuse(params: Record<string, string>, signal?: AbortSignal, options: MuseOptions = {}): Promise<RawJob[]> {
  const search = new URLSearchParams()
  addAll(search, 'category', params.category, '|')
  addAll(search, 'level', params.level, '|')
  addAll(search, 'location', params.location, '|')
  const base = [...search.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const maxPages = Math.max(1, Math.min(options.maxPages ?? (Number(params.maxPages) || 5), 99))

  const jobs: RawJob[] = []
  const seen = new Set<string>()
  let pageCount = Infinity
  for (let page = 1; page <= Math.min(maxPages, pageCount); page++) {
    let json: MuseResponse
    try {
      json = await fetchJson<MuseResponse>(`https://www.themuse.com/api/public/jobs?page=${page}${base ? `&${base}` : ''}`, { timeoutMs: 40_000, signal })
    } catch (err) {
      // A refusal after the first page means the hourly limit is used up. Keep what was read.
      if (page > 1 && err instanceof HttpError && (err.status === 403 || err.status === 429)) break
      throw err
    }
    pageCount = json.page_count ?? 1
    for (const job of parseTheMuse(json, params)) {
      if (seen.has(job.externalId)) continue
      seen.add(job.externalId)
      jobs.push(job)
    }
  }

  const fresh = jobs.filter((j) => !options.isKnown?.(j.externalId)).slice(0, options.landingLimit ?? 20)
  const pages = await mapLimit(fresh, 2, async (job) => {
    try {
      return await fetchText(job.url, { timeoutMs: 25_000, signal })
    } catch (err) {
      if (signal?.aborted) throw err
      return null
    }
  })
  const resolved = new Map<string, RawJob>()
  fresh.forEach((job, i) => {
    if (pages[i]) resolved.set(job.externalId, applyMuseLanding(job, pages[i]!))
  })
  return jobs.map((j) => resolved.get(j.externalId) ?? j)
}
