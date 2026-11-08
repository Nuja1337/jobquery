import { createHash } from 'node:crypto'
import type { RawJob } from '@shared/types'
import { prettifyToken } from './detect'
import { type BoardChanges, type BoardReadState, type ConditionalResult, fetchConditional, fetchJson, HttpError, type HttpOptions } from './http'
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

export function parseLeverPosting(p: LeverPosting, slug: string, companyName?: string | null, eu = false): RawJob {
  const description = describe(p)
  const locations = p.categories?.allLocations?.length ? p.categories.allLocations : p.categories?.location ? [p.categories.location] : []
  const location = locations.join('; ') || null
  const title = cleanTitle(p.text)
  const salary = salaryOf(p, description)
  const url = p.hostedUrl || `https://jobs${eu ? '.eu' : ''}.lever.co/${slug}/${p.id}`
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
    atsJobId: p.id,
    description,
    postedAt: toIsoDate(p.createdAt)
  }
}

export function parseLever(list: LeverPosting[], slug: string, companyName?: string | null, eu = false): RawJob[] {
  return list.map((p) => parseLeverPosting(p, slug, companyName, eu))
}

/** Lever keeps European accounts on a separate API. The global one answers 404 for them. */
async function leverGet<T>(path: string, options: HttpOptions): Promise<{ data: T; eu: boolean }> {
  try {
    return { data: await fetchJson<T>(`https://api.lever.co/v0/postings/${path}`, options), eu: false }
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err
    try {
      return { data: await fetchJson<T>(`https://api.eu.lever.co/v0/postings/${path}`, options), eu: true }
    } catch (euErr) {
      // Neither region has it, so report the first answer.
      if (euErr instanceof HttpError && euErr.status === 404) throw err
      throw euErr
    }
  }
}

export async function fetchLeverBoard(slug: string, companyName?: string | null, signal?: AbortSignal): Promise<RawJob[]> {
  const { data, eu } = await leverGet<LeverPosting[]>(`${encodeURIComponent(slug)}?mode=json`, { timeoutMs: 60_000, signal })
  return parseLever(Array.isArray(data) ? data : [], slug, companyName, eu)
}

export async function fetchLeverJob(slug: string, id: string, companyName?: string | null): Promise<RawJob> {
  const { data, eu } = await leverGet<LeverPosting>(`${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, {})
  return parseLeverPosting(data, slug, companyName, eu)
}

/** Slugs whose board answered on the European API, so later checks go there first. */
const euSlugs = new Set<string>()

async function leverConditional(slug: string, state: BoardReadState, signal?: AbortSignal): Promise<{ result: ConditionalResult<LeverPosting[]>; eu: boolean }> {
  const path = `${encodeURIComponent(slug)}?mode=json`
  const options = { etag: state.etag, lastModified: state.lastModified, timeoutMs: 60_000, signal }
  const global = `https://api.lever.co/v0/postings/${path}`
  const eu = `https://api.eu.lever.co/v0/postings/${path}`
  const first = euSlugs.has(slug) ? eu : global
  const second = euSlugs.has(slug) ? global : eu
  try {
    const result = await fetchConditional<LeverPosting[]>(first, options)
    return { result, eu: first === eu }
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err
    try {
      const result = await fetchConditional<LeverPosting[]>(second, options)
      if (second === eu) euSlugs.add(slug)
      else euSlugs.delete(slug)
      return { result, eu: second === eu }
    } catch (other) {
      // Neither region has it, so report the first answer.
      if (other instanceof HttpError && other.status === 404) throw err
      throw other
    }
  }
}

/** Reads a board only when its ETag changed. A changed board comes back whole, since Lever lists every posting with its text. */
export async function fetchLeverBoardChanges(
  slug: string,
  companyName: string | null | undefined,
  state: BoardReadState,
  signal?: AbortSignal
): Promise<BoardChanges> {
  const { result, eu } = await leverConditional(slug, state, signal)
  if (result.status === 304) return { changed: false }
  const list = Array.isArray(result.json) ? result.json : []
  const listHash = createHash('sha1').update(JSON.stringify(list)).digest('hex')
  if (listHash === state.listHash) return { changed: false, etag: result.etag, lastModified: result.lastModified, listHash }
  return { changed: true, jobs: parseLever(list, slug, companyName, eu), etag: result.etag, lastModified: result.lastModified, listHash }
}
