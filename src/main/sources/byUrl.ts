import { createHash } from 'node:crypto'
import type { RawJob } from '@shared/types'
import { fetchAshbyBoard } from './ashby'
import { detectAts, prettifyToken } from './detect'
import { fetchGreenhouseJob } from './greenhouse'
import { HttpError, fetchText } from './http'
import { fetchLeverJob } from './lever'
import { cleanTitle, decodeEntities, findSalaryInText, htmlToPlain, inferRemote, parseSalary, toIsoDate } from './normalize'
import { fetchSmartRecruitersJob } from './smartrecruiters'
import { fetchWorkableBoard } from './workable'

type Json = Record<string, unknown>

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function asNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/,/g, '')) : NaN
  return Number.isFinite(n) ? n : null
}

function arrayOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]
}

/**
 * Reads one JSON-LD block as it is. Decoding entities first would turn a `&quot;` inside a string
 * into a bare quote and break valid JSON, so it only happens when the plain parse fails (a block
 * that was escaped as a whole).
 */
function parseJsonLd(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(decodeEntities(text))
  }
}

/** Finds JobPosting objects in every JSON-LD block of a page. Handles arrays and @graph. */
export function findJobPostings(html: string): Json[] {
  const found: Json[] = []
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const obj = node as Json
    const types = arrayOf(obj['@type']).map(String)
    if (types.includes('JobPosting')) found.push(obj)
    if (obj['@graph']) visit(obj['@graph'])
  }
  for (const block of blocks) {
    const text = block[1].trim()
    try {
      visit(parseJsonLd(text))
    } catch {
      // A broken block shouldn't hide a good one.
    }
  }
  return found
}

function placeText(place: unknown): string | null {
  if (typeof place === 'string') return place
  if (!place || typeof place !== 'object') return null
  const address = (place as Json).address
  if (typeof address === 'string') return address
  if (address && typeof address === 'object') {
    const a = address as Json
    return [a.addressLocality, a.addressRegion, a.addressCountry && typeof a.addressCountry === 'object' ? (a.addressCountry as Json).name : a.addressCountry]
      .map(asString)
      .filter(Boolean)
      .join(', ')
  }
  return null
}

function salaryFromJsonLd(posting: Json): { min: number; max: number; currency: string | null } | null {
  const base = posting.baseSalary as Json | undefined
  if (!base || typeof base !== 'object') return null
  const value = (base.value ?? base) as Json
  const min = asNumber(value.minValue ?? value.value)
  const max = asNumber(value.maxValue ?? value.value)
  if (min === null || max === null) return null
  const unit = String(value.unitText ?? '').toUpperCase()
  const factor = unit === 'HOUR' ? 2080 : unit === 'MONTH' ? 12 : unit === 'WEEK' ? 52 : 1
  const lo = Math.round(Math.min(min, max) * factor)
  const hi = Math.round(Math.max(min, max) * factor)
  if (lo < 10_000 || hi > 3_000_000) return null
  return { min: lo, max: hi, currency: asString(base.currency) ?? asString(value.currency) }
}

function urlKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return createHash('sha1').update(`${u.hostname}${u.pathname}${u.search}`).digest('hex').slice(0, 16)
  } catch {
    return createHash('sha1').update(url).digest('hex').slice(0, 16)
  }
}

/** Builds a RawJob from a schema.org JobPosting. */
export function rawFromJsonLd(posting: Json, url: string): RawJob {
  const detected = detectAts(url)
  const rawDescription = asString(posting.description) ?? ''
  // Some sites put escaped HTML here, some real HTML, some plain text.
  const description = htmlToPlain(/<[a-z][\s\S]*>/i.test(rawDescription) ? rawDescription : decodeEntities(rawDescription))
  const org = posting.hiringOrganization as Json | string | undefined
  const company = (typeof org === 'string' ? org : asString(org?.name)) ?? hostCompany(url)
  const location = arrayOf(posting.jobLocation).map(placeText).filter(Boolean).join('; ') || null
  const title = cleanTitle(asString(posting.title) ?? 'Untitled role')
  const salary = salaryFromJsonLd(posting) ?? findSalaryInText(description)
  const identifier = posting.identifier as Json | string | undefined
  const idValue = typeof identifier === 'string' ? identifier : asString(identifier?.value)
  const employment = arrayOf(posting.employmentType).map(String).join(', ')
  return {
    source: 'manual',
    externalId: idValue ? `${urlKey(url)}-${idValue}`.slice(0, 80) : urlKey(url),
    company,
    title,
    location,
    remote: inferRemote({ explicit: posting.jobLocationType === 'TELECOMMUTE' ? 'remote' : null, location, title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: employment || null,
    url,
    applyUrl: asString(posting.url) ?? url,
    ats: detected?.ats ?? 'unknown',
    atsToken: detected?.token ?? null,
    description,
    postedAt: toIsoDate(asString(posting.datePosted))
  }
}

function hostCompany(url: string): string {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, '').split('.')
    return prettifyToken(parts.length > 2 ? parts[parts.length - 2] : parts[0])
  } catch {
    return 'Unknown company'
  }
}

function meta(html: string, property: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i')
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, 'i')
  const value = re.exec(html)?.[1] ?? alt.exec(html)?.[1]
  return value ? decodeEntities(value).trim() : null
}

/** Last resort: the page title and the visible text. */
export function rawFromPage(html: string, url: string): RawJob {
  const title = cleanTitle(meta(html, 'og:title') ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? 'Untitled role')
  const body = /<body[\s\S]*<\/body>/i.exec(html)?.[0] ?? html
  const cleaned = body.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
  const description = htmlToPlain(cleaned).slice(0, 20_000)
  const detected = detectAts(url)
  const salary = parseSalary(description.slice(0, 12_000))
  return {
    source: 'manual',
    externalId: urlKey(url),
    company: meta(html, 'og:site_name') ?? hostCompany(url),
    title,
    location: null,
    remote: inferRemote({ title, description }),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    employmentType: null,
    url,
    applyUrl: url,
    ats: detected?.ats ?? 'unknown',
    atsToken: detected?.token ?? null,
    description,
    postedAt: null
  }
}

/** Reads a posting through its ATS API when the URL is recognised. Returns null if that doesn't work. */
async function viaAtsApi(url: string): Promise<RawJob | null> {
  const det = detectAts(url)
  if (!det?.token || !det.jobId) return null
  try {
    switch (det.ats) {
      case 'greenhouse':
        return await fetchGreenhouseJob(det.token, det.jobId)
      case 'lever':
        return await fetchLeverJob(det.token, det.jobId)
      case 'smartrecruiters':
        return await fetchSmartRecruitersJob(det.token, det.jobId)
      case 'ashby':
        return (await fetchAshbyBoard(det.token)).find((j) => j.externalId === det.jobId) ?? null
      case 'workable': {
        const wanted = det.jobId.toUpperCase()
        return (await fetchWorkableBoard(det.token)).find((j) => j.externalId.toUpperCase() === wanted) ?? null
      }
      default:
        return null
    }
  } catch (err) {
    // A removed posting or a bad token falls through to reading the page itself.
    if (err instanceof HttpError) return null
    throw err
  }
}

/**
 * Fetches one posting by URL. Order: the ATS's own API, then the page's schema.org JobPosting block,
 * then the page title and text. Company names that come from an ATS token are a guess the user can edit.
 */
export async function fetchJobByUrl(rawUrl: string): Promise<RawJob> {
  const url = rawUrl.trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a full link that starts with http:// or https://')
  const viaApi = await viaAtsApi(url)
  if (viaApi) return viaApi
  let html: string
  try {
    html = await fetchText(url)
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw new Error('That posting was not found. It may have been taken down.')
    throw err
  }
  const posting = findJobPostings(html)[0]
  if (posting) return rawFromJsonLd(posting, url)
  return rawFromPage(html, url)
}
