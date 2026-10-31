import type { RawJob } from '@shared/types'
import { fetchJson } from './http'
import { cleanTitle, htmlToPlain, inferRemote, toIsoDate } from './normalize'

// https://api.adzuna.com/v1/api/jobs/{country}/search/1?app_id=&app_key=&what=&where=
// Needs the user's own free app id and key, which live in the saved search params.
// Adzuna returns a short snippet of each description, not the full text.

export interface AdzunaResult {
  id: string | number
  title: string
  description?: string
  created?: string
  redirect_url: string
  company?: { display_name?: string }
  location?: { display_name?: string }
  salary_min?: number
  salary_max?: number
  salary_is_predicted?: string | number
  contract_time?: string
  contract_type?: string
}

const COUNTRY_CURRENCY: Record<string, string> = {
  us: 'USD',
  gb: 'GBP',
  ca: 'CAD',
  au: 'AUD',
  nz: 'NZD',
  de: 'EUR',
  fr: 'EUR',
  nl: 'EUR',
  at: 'EUR',
  be: 'EUR',
  it: 'EUR',
  es: 'EUR',
  pl: 'PLN',
  in: 'INR',
  sg: 'SGD',
  br: 'BRL',
  mx: 'MXN',
  ch: 'CHF'
}

const CONTRACT_TIME: Record<string, string> = { full_time: 'Full-time', part_time: 'Part-time' }

export function parseAdzuna(json: { results?: AdzunaResult[] }, country = 'us'): RawJob[] {
  return (json.results ?? []).map((r) => {
    // Adzuna fills in estimates when a posting has no pay. Those are guesses, so they are dropped.
    const predicted = String(r.salary_is_predicted ?? '0') === '1'
    const hasPay = !predicted && (r.salary_min ?? 0) > 0 && (r.salary_max ?? 0) > 0
    const title = cleanTitle(htmlToPlain(r.title))
    const location = r.location?.display_name?.trim() || null
    const description = htmlToPlain(r.description ?? '')
    return {
      source: 'adzuna' as const,
      externalId: String(r.id),
      company: r.company?.display_name?.trim() || 'Unknown company',
      title,
      location,
      remote: inferRemote({ location, title, description }),
      salaryMin: hasPay ? Math.round(r.salary_min!) : null,
      salaryMax: hasPay ? Math.round(r.salary_max!) : null,
      salaryCurrency: hasPay ? (COUNTRY_CURRENCY[country] ?? null) : null,
      employmentType: r.contract_time ? (CONTRACT_TIME[r.contract_time] ?? r.contract_time) : null,
      url: r.redirect_url,
      applyUrl: r.redirect_url,
      ats: 'unknown' as const,
      atsToken: null,
      description,
      postedAt: toIsoDate(r.created)
    }
  })
}

/** params: app_id, app_key, country (default "us"), query (what), location (where), results (per page, default 50), max_days_old. */
export async function fetchAdzuna(params: Record<string, string>, signal?: AbortSignal): Promise<RawJob[]> {
  const appId = params.app_id?.trim()
  const appKey = params.app_key?.trim()
  if (!appId || !appKey) throw new Error('Adzuna needs an app id and an app key. Add them to the search.')
  const country = (params.country || 'us').trim().toLowerCase()
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1`)
  url.searchParams.set('app_id', appId)
  url.searchParams.set('app_key', appKey)
  url.searchParams.set('results_per_page', params.results || '50')
  if (params.query) url.searchParams.set('what', params.query)
  if (params.location) url.searchParams.set('where', params.location)
  if (params.max_days_old) url.searchParams.set('max_days_old', params.max_days_old)
  url.searchParams.set('sort_by', 'date')
  const json = await fetchJson<{ results?: AdzunaResult[] }>(url.toString(), { signal })
  return parseAdzuna(json, country)
}
