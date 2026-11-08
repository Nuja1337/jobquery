import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { payPeriodFrom, yearlyPay } from './feeds'
import { fetchJson, mapLimit } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, inferRemote, toIsoDate } from './normalize'

// Rippling ATS public board API:
//   list:   https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
//           an array of { uuid, name, department: { id, label }, url, workLocation: { label, id } }
//   detail: https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid}
//           adds description { company, role } (HTML), workLocations[], employmentType { label, id },
//           createdOn, payRangeDetails[] and board.companyName
// The list has no description and a large board has hundreds of postings (the Rippling board has 671),
// so each new posting costs one more request. Details are capped per run, like the SmartRecruiters reader.

export interface RipplingListItem {
  uuid: string
  name: string
  department?: { id?: string; label?: string } | null
  url?: string
  workLocation?: { label?: string; id?: string } | null
}

export interface RipplingDetail {
  uuid: string
  name?: string
  description?: { company?: string; role?: string } | string | null
  workLocations?: string[]
  department?: { name?: string; base_department?: string } | null
  employmentType?: { label?: string; id?: string } | null
  createdOn?: string
  payRangeDetails?: Array<{ currency?: string; frequency?: string; rangeStart?: number; rangeEnd?: number }> | null
  url?: string
  companyName?: string
  board?: { companyName?: string } | null
}

function describe(detail: RipplingDetail | null): string {
  const d = detail?.description
  if (!d) return ''
  if (typeof d === 'string') return htmlToPlain(d)
  // "company" is the same About text on every posting of the board, so the role text comes first.
  return [d.role, d.company]
    .map((html) => htmlToPlain(html ?? ''))
    .filter(Boolean)
    .join('\n\n')
}

/** Rippling labels types such as SALARIED_FT, HOURLY_PT, CONTRACT and TEMP. */
function employmentOf(detail: RipplingDetail | null): string | null {
  const label = detail?.employmentType?.label?.trim().toUpperCase()
  if (!label) return detail?.employmentType?.id?.trim() || null
  if (label.endsWith('_FT')) return 'Full-time'
  if (label.endsWith('_PT')) return 'Part-time'
  if (label === 'CONTRACT') return 'Contract'
  if (label === 'TEMP') return 'Temporary'
  return detail?.employmentType?.id?.trim() || null
}

/** `detail` is null for postings that were listed but not fetched. Their description is left empty. */
export function parseRipplingJob(item: RipplingListItem, detail: RipplingDetail | null, slug: string, company?: string | null): RawJob {
  const description = describe(detail)
  const places = detail?.workLocations?.length ? detail.workLocations : item.workLocation?.label ? [item.workLocation.label] : []
  const location = places.map((p) => p.trim()).filter(Boolean).join('; ') || null
  const title = cleanTitle(item.name)
  const pay = detail?.payRangeDetails?.find((p) => typeof p.rangeStart === 'number' || typeof p.rangeEnd === 'number')
  const salary = (pay && yearlyPay(pay.rangeStart, pay.rangeEnd, payPeriodFrom(pay.frequency) ?? 'year', pay.currency)) || findSalaryInText(description)
  const url = item.url || detail?.url || `https://ats.rippling.com/${slug}/jobs/${item.uuid}`
  return {
    source: 'rippling',
    externalId: item.uuid,
    company: company || detail?.companyName || detail?.board?.companyName || prettifyToken(slug),
    title,
    location,
    remote: inferRemote({ location, title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: employmentOf(detail),
    url,
    applyUrl: url,
    ats: 'rippling',
    atsToken: slug,
    atsJobId: item.uuid,
    description,
    postedAt: toIsoDate(detail?.createdOn)
  }
}

export interface RipplingOptions {
  /** Postings already stored. They are listed without a detail request and keep their stored text. */
  isKnown?: (externalId: string) => boolean
  /** Most detail requests per call. New postings beyond this wait for the next run. Default 40. */
  detailLimit?: number
  signal?: AbortSignal
}

/**
 * `complete` is false when new postings were left for the next run, so the caller must not close
 * stored jobs that were not returned.
 */
export async function fetchRipplingBoard(
  slug: string,
  companyName?: string | null,
  options: RipplingOptions = {}
): Promise<{ jobs: RawJob[]; complete: boolean }> {
  const base = `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`
  const list = await fetchJson<RipplingListItem[]>(base, { timeoutMs: 60_000, signal: options.signal })
  const items = (Array.isArray(list) ? list : []).filter((i) => i?.uuid && i.name)
  const known = items.filter((i) => options.isKnown?.(i.uuid))
  const fresh = items.filter((i) => !options.isKnown?.(i.uuid)).slice(0, options.detailLimit ?? 40)
  const details = await mapLimit(fresh, 3, async (item) => {
    try {
      return await fetchJson<RipplingDetail>(`${base}/${encodeURIComponent(item.uuid)}`, { signal: options.signal })
    } catch (err) {
      if (options.signal?.aborted) throw err
      return null
    }
  })
  const jobs: RawJob[] = known.map((item) => parseRipplingJob(item, null, slug, companyName))
  let fetched = 0
  fresh.forEach((item, i) => {
    if (!details[i]) return
    fetched++
    jobs.push(parseRipplingJob(item, details[i], slug, companyName))
  })
  return { jobs, complete: known.length + fetched === items.length }
}
