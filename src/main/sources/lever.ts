import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { fetchJson } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, inferRemote, toIsoDate } from './normalize'

// Public postings API: https://api.lever.co/v0/postings/{slug}?mode=json

export interface LeverPosting {
  id: string
  text: string
  hostedUrl?: string
  applyUrl?: string
  createdAt?: number
  workplaceType?: string
  descriptionPlain?: string
  additionalPlain?: string
  lists?: Array<{ text: string; content: string }>
  categories?: { commitment?: string; location?: string; allLocations?: string[]; team?: string; department?: string }
  salaryRange?: { currency?: string; interval?: string; min?: number; max?: number }
}

function describe(p: LeverPosting): string {
  const parts: string[] = []
  if (p.descriptionPlain?.trim()) parts.push(p.descriptionPlain.trim())
  for (const list of p.lists ?? []) {
    const body = htmlToPlain(list.content)
    if (body) parts.push(`${list.text}\n${body}`)
  }
  const extra = p.additionalPlain?.trim()
  if (extra && extra !== '-') parts.push(extra)
  return parts.join('\n\n')
}

function salaryOf(p: LeverPosting, description: string) {
  const range = p.salaryRange
  if (range && typeof range.min === 'number' && typeof range.max === 'number') {
    const factor = range.interval === 'per-hour-wage' ? 2080 : range.interval === 'per-month-salary' ? 12 : 1
    return { min: Math.round(range.min * factor), max: Math.round(range.max * factor), currency: range.currency ?? null }
  }
  return findSalaryInText(description)
}

export function parseLeverPosting(p: LeverPosting, slug: string, companyName?: string | null): RawJob {
  const description = describe(p)
  const locations = p.categories?.allLocations?.length ? p.categories.allLocations : p.categories?.location ? [p.categories.location] : []
  const location = locations.join('; ') || null
  const title = cleanTitle(p.text)
  const salary = salaryOf(p, description)
  const url = p.hostedUrl || `https://jobs.lever.co/${slug}/${p.id}`
  return {
    source: 'lever',
    externalId: p.id,
    company: companyName || prettifyToken(slug),
    title,
    location,
    remote: inferRemote({ explicit: p.workplaceType === 'unspecified' ? null : p.workplaceType, location, title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: p.categories?.commitment ?? null,
    url,
    applyUrl: p.applyUrl || `${url}/apply`,
    ats: 'lever',
    atsToken: slug,
    description,
    postedAt: toIsoDate(p.createdAt)
  }
}

export function parseLever(list: LeverPosting[], slug: string, companyName?: string | null): RawJob[] {
  return list.map((p) => parseLeverPosting(p, slug, companyName))
}

export async function fetchLeverBoard(slug: string, companyName?: string | null, signal?: AbortSignal): Promise<RawJob[]> {
  const list = await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, {
    timeoutMs: 60_000,
    signal
  })
  return parseLever(Array.isArray(list) ? list : [], slug, companyName)
}

export async function fetchLeverJob(slug: string, id: string, companyName?: string | null): Promise<RawJob> {
  const posting = await fetchJson<LeverPosting>(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`)
  return parseLeverPosting(posting, slug, companyName)
}
