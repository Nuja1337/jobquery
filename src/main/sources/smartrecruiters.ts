import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { fetchJson, mapLimit } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, inferRemote, toIsoDate } from './normalize'

// Public posting API:
//   list:   https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset=0
//   detail: https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}
// The list has no description, so each new posting needs one more request. Details are capped per run.

export interface SmartRecruitersListItem {
  id: string
  name: string
  company?: { identifier?: string; name?: string }
  releasedDate?: string
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string }
  typeOfEmployment?: { label?: string }
  experienceLevel?: { label?: string }
  department?: { label?: string }
}

export interface SmartRecruitersDetail extends SmartRecruitersListItem {
  postingUrl?: string
  applyUrl?: string
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> }
}

const SECTION_ORDER = ['jobDescription', 'qualifications', 'additionalInformation']

function describe(detail: SmartRecruitersDetail | null): string {
  const sections = detail?.jobAd?.sections ?? {}
  const parts: string[] = []
  for (const key of SECTION_ORDER) {
    const s = sections[key]
    if (!s?.text) continue
    const body = htmlToPlain(s.text)
    if (body) parts.push(s.title ? `${s.title}\n${body}` : body)
  }
  return parts.join('\n\n')
}

function workplace(item: SmartRecruitersListItem): string | null {
  if (item.location?.remote) return 'remote'
  if (item.location?.hybrid) return 'hybrid'
  return null
}

/** `detail` is null for postings that were listed but not fetched. Their description is left empty. */
export function parseSmartRecruitersPosting(
  item: SmartRecruitersListItem,
  detail: SmartRecruitersDetail | null,
  company: string,
  companyId: string
): RawJob {
  const description = describe(detail)
  const location = item.location?.fullLocation || [item.location?.city, item.location?.country?.toUpperCase()].filter(Boolean).join(', ') || null
  const title = cleanTitle(item.name)
  const salary = findSalaryInText(description)
  const url = detail?.postingUrl || `https://jobs.smartrecruiters.com/${companyId}/${item.id}`
  return {
    source: 'smartrecruiters',
    externalId: item.id,
    company: company || item.company?.name || prettifyToken(companyId),
    title,
    location,
    remote: inferRemote({ explicit: workplace(item), location, title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: item.typeOfEmployment?.label ?? null,
    url,
    applyUrl: detail?.applyUrl || url,
    ats: 'smartrecruiters',
    atsToken: companyId,
    description,
    postedAt: toIsoDate(item.releasedDate)
  }
}

export interface SmartRecruitersOptions {
  /** Postings already stored. They are listed without a detail request and keep their stored text. */
  isKnown?: (externalId: string) => boolean
  /** Most detail requests per call. New postings beyond this wait for the next run. */
  detailLimit?: number
  maxPages?: number
  signal?: AbortSignal
}

/**
 * `complete` is false when the board is larger than the pages we read, so the caller
 * must not close stored jobs that were simply not listed.
 */
export async function fetchSmartRecruitersBoard(
  companyId: string,
  companyName?: string | null,
  options: SmartRecruitersOptions = {}
): Promise<{ jobs: RawJob[]; complete: boolean }> {
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyId)}/postings`
  const pageSize = 100
  const maxPages = options.maxPages ?? 3
  const items: SmartRecruitersListItem[] = []
  let total = 0
  for (let page = 0; page < maxPages; page++) {
    const json = await fetchJson<{ totalFound?: number; content?: SmartRecruitersListItem[] }>(
      `${base}?limit=${pageSize}&offset=${page * pageSize}`,
      { signal: options.signal }
    )
    total = json.totalFound ?? 0
    items.push(...(json.content ?? []))
    if (items.length >= total || (json.content ?? []).length < pageSize) break
  }
  const known = items.filter((i) => options.isKnown?.(i.id))
  const fresh = items.filter((i) => !options.isKnown?.(i.id)).slice(0, options.detailLimit ?? 40)
  const details = await mapLimit(fresh, 3, async (item) => {
    try {
      return await fetchJson<SmartRecruitersDetail>(`${base}/${encodeURIComponent(item.id)}`, { signal: options.signal })
    } catch {
      return null
    }
  })
  const jobs: RawJob[] = []
  const company = companyName ?? ''
  known.forEach((item) => jobs.push(parseSmartRecruitersPosting(item, null, company, companyId)))
  fresh.forEach((item, i) => {
    if (details[i]) jobs.push(parseSmartRecruitersPosting(item, details[i], company, companyId))
  })
  return { jobs, complete: items.length >= total }
}

export async function fetchSmartRecruitersJob(companyId: string, postingId: string, companyName?: string | null): Promise<RawJob> {
  const detail = await fetchJson<SmartRecruitersDetail>(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyId)}/postings/${encodeURIComponent(postingId)}`
  )
  return parseSmartRecruitersPosting(detail, detail, companyName ?? detail.company?.name ?? '', companyId)
}
