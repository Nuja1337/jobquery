import type { RawJob } from '@shared/types'
import { withAtsIdentity } from './detect'
import { employmentLabel, findAtsLink } from './feeds'
import { fetchText } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, matchesQuery, toIsoDate } from './normalize'
import { xmlBlocks, xmlText } from './xml'

// RSS 2.0 feeds: https://weworkremotely.com/categories/{category}.rss
// Each feed lists the 25 newest jobs of its category. Titles read "Company: Title", `description` is
// entity-escaped HTML, and `link` is the We Work Remotely page (posting pages answer 403 to plain HTTP,
// so the apply link stays that page unless the description links to an employer posting).
// Politeness: one request per category, at most three categories, no more than a few calls a day.

export const WWR_DEFAULT_CATEGORY = 'remote-programming-jobs'

/** Splits "Company: Title" at the first colon. The company side can have a stray space before the colon. */
export function splitWwrTitle(raw: string): { company: string; title: string } | null {
  const at = raw.indexOf(':')
  if (at <= 0) return null
  const company = raw.slice(0, at).trim()
  const title = raw.slice(at + 1).trim()
  return company && title ? { company, title } : null
}

/**
 * Every feed item ends with a "To apply" line that repeats the We Work Remotely link. The line is
 * removed from the text.
 */
function dropApplyLine(text: string): string {
  const at = text.lastIndexOf('To apply:')
  if (at === -1) return text
  const tail = text.slice(at)
  return tail.length < 300 && !tail.includes('\n\n') ? text.slice(0, at).trim() : text
}

/** `params.query` filters by title, category and description, since the feeds have no search. */
export function parseWeWorkRemotely(xml: string, params: Record<string, string> = {}): RawJob[] {
  const jobs: RawJob[] = []
  for (const item of xmlBlocks(xml, 'item')) {
    const link = xmlText(item, 'link') ?? xmlText(item, 'guid')
    const parts = splitWwrTitle(xmlText(item, 'title') ?? '')
    if (!link || !parts) continue
    const html = xmlText(item, 'description') ?? ''
    const description = dropApplyLine(htmlToPlain(html))
    const category = xmlText(item, 'category') ?? ''
    if (!matchesQuery(`${parts.title} ${category} ${description}`, params.query)) continue
    const salary = findSalaryInText(description)
    const employerLink = findAtsLink(html)
    jobs.push(
      withAtsIdentity({
        source: 'weworkremotely' as const,
        externalId: link,
        company: parts.company,
        title: cleanTitle(parts.title),
        location: xmlText(item, 'region'),
        remote: 'remote' as const,
        salaryMin: salary?.min ?? null,
        salaryMax: salary?.max ?? null,
        salaryCurrency: salary?.currency ?? null,
        employmentType: employmentLabel(xmlText(item, 'type')),
        url: link,
        applyUrl: employerLink ?? link,
        ats: 'unknown' as const,
        atsToken: null,
        description,
        postedAt: toIsoDate(xmlText(item, 'pubDate'))
      })
    )
  }
  return jobs
}

/** The feed name from a category such as "remote-programming-jobs" or "remote-programming-jobs.rss". */
function categorySlug(value: string): string | null {
  const slug = value.trim().toLowerCase().replace(/\.rss$/, '')
  return /^[a-z0-9-]+$/.test(slug) ? slug : null
}

/** params: category (default remote-programming-jobs, several separated by commas, at most three), query. */
export async function fetchWeWorkRemotely(params: Record<string, string>, signal?: AbortSignal): Promise<RawJob[]> {
  const wanted = (params.category ?? '')
    .split(',')
    .map(categorySlug)
    .filter((c): c is string => Boolean(c))
    .slice(0, 3)
  const categories = wanted.length ? wanted : [WWR_DEFAULT_CATEGORY]
  const byLink = new Map<string, RawJob>()
  for (const category of categories) {
    const xml = await fetchText(`https://weworkremotely.com/categories/${category}.rss`, {
      timeoutMs: 40_000,
      signal,
      headers: { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' }
    })
    for (const job of parseWeWorkRemotely(xml, params)) if (!byLink.has(job.externalId)) byLink.set(job.externalId, job)
  }
  return [...byLink.values()]
}
