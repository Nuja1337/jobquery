import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { employmentLabel } from './feeds'
import { fetchJson, fetchText, mapLimit } from './http'
import { cleanTitle, decodeEntities, findSalaryInText, htmlToPlain, inferRemote, parseSalary, toIsoDate } from './normalize'

// Breezy HR public job feed:
//   list:   https://{slug}.breezy.hr/json
//           an array of { id, friendly_id, name, url, published_date, type { id, name },
//           location { name, is_remote, remote_details { value } }, department, salary, company { name } }
//   detail: the posting page https://{slug}.breezy.hr/p/{friendly_id}, whose schema.org JobPosting
//           block holds the description as HTML. There is no JSON detail endpoint (/json/{id} redirects).
// The list has no description, so each new posting costs one page request. Details are capped per run.
// An unknown slug answers 404 with an HTML page.

export interface BreezyLocation {
  name?: string
  is_remote?: boolean
  remote_details?: { value?: string; label?: string } | null
}

export interface BreezyListItem {
  id: string
  friendly_id?: string
  name: string
  url?: string
  published_date?: string
  type?: { id?: string; name?: string } | null
  location?: BreezyLocation | null
  locations?: BreezyLocation[]
  department?: string
  salary?: string
  company?: { name?: string; friendly_id?: string } | null
}

/** The fields of a posting page's JobPosting block that the reader uses. */
export interface BreezyDetail {
  description?: string
  employmentType?: string
  jobLocationType?: string
  datePosted?: string
}

/** Finds the JobPosting JSON-LD block of a Breezy posting page. */
export function breezyDetailFromPage(html: string): BreezyDetail | null {
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(block[1].trim()) as Record<string, unknown>
      if (data && data['@type'] === 'JobPosting') return data as BreezyDetail
    } catch {
      // A broken block should not hide a good one.
    }
  }
  return null
}

function remoteHint(item: BreezyListItem, detail: BreezyDetail | null): string | null {
  const loc = item.location
  if (loc?.remote_details?.value === 'remote' || loc?.is_remote) return 'remote'
  if (loc?.remote_details?.value === 'hybrid') return 'hybrid'
  if (detail?.jobLocationType === 'TELECOMMUTE') return 'remote'
  return null
}

/** `detail` is null for postings that were listed but not fetched. Their description is left empty. */
export function parseBreezyJob(item: BreezyListItem, detail: BreezyDetail | null, slug: string, company?: string | null): RawJob {
  const rawDescription = detail?.description ?? ''
  const description = htmlToPlain(/<[a-z][\s\S]*>/i.test(rawDescription) ? rawDescription : decodeEntities(rawDescription))
  const places = [item.location, ...(item.locations ?? [])].map((l) => l?.name?.trim() ?? '').filter(Boolean)
  const location = [...new Set(places)].join('; ') || null
  const title = cleanTitle(item.name)
  const salary = parseSalary(item.salary, { fieldOnly: true }) ?? findSalaryInText(description)
  const url = (item.url || `https://${slug}.breezy.hr/p/${item.friendly_id ?? item.id}`).replace(/[?#].*$/, '')
  return {
    source: 'breezy',
    externalId: item.id,
    company: company || item.company?.name || prettifyToken(slug),
    title,
    location,
    remote: inferRemote({ explicit: remoteHint(item, detail), location, title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: employmentLabel(item.type?.name) ?? employmentLabel(detail?.employmentType),
    url,
    applyUrl: `${url}/apply`,
    ats: 'breezy',
    atsToken: slug,
    atsJobId: item.id,
    description,
    postedAt: toIsoDate(item.published_date) ?? toIsoDate(detail?.datePosted)
  }
}

export interface BreezyOptions {
  /** Postings already stored. They are listed without a page request and keep their stored text. */
  isKnown?: (externalId: string) => boolean
  /** Most posting pages per call. New postings beyond this wait for the next run. Default 40. */
  detailLimit?: number
  signal?: AbortSignal
}

/**
 * `complete` is false when new postings were left for the next run, so the caller must not close
 * stored jobs that were not returned.
 */
export async function fetchBreezyBoard(
  slug: string,
  companyName?: string | null,
  options: BreezyOptions = {}
): Promise<{ jobs: RawJob[]; complete: boolean }> {
  const host = `https://${encodeURIComponent(slug)}.breezy.hr`
  const list = await fetchJson<BreezyListItem[]>(`${host}/json`, { timeoutMs: 40_000, signal: options.signal })
  const items = (Array.isArray(list) ? list : []).filter((i) => i?.id && i.name)
  const known = items.filter((i) => options.isKnown?.(i.id))
  const fresh = items.filter((i) => !options.isKnown?.(i.id)).slice(0, options.detailLimit ?? 40)
  const details = await mapLimit(fresh, 3, async (item) => {
    try {
      const page = await fetchText(`${host}/p/${encodeURIComponent(item.friendly_id ?? item.id)}`, { timeoutMs: 30_000, signal: options.signal })
      return breezyDetailFromPage(page)
    } catch (err) {
      if (options.signal?.aborted) throw err
      return null
    }
  })
  const jobs: RawJob[] = known.map((item) => parseBreezyJob(item, null, slug, companyName))
  let fetched = 0
  fresh.forEach((item, i) => {
    if (!details[i]) return
    fetched++
    jobs.push(parseBreezyJob(item, details[i], slug, companyName))
  })
  return { jobs, complete: known.length + fetched === items.length }
}
