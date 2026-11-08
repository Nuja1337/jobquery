import type { RawJob } from '@shared/types'
import { seniorityFromLabel } from '../pipeline/filters'
import { prettifyToken } from './detect'
import { payPeriodFrom, yearlyPay } from './feeds'
import { fetchText, HttpError } from './http'
import { cleanTitle, findSalaryInText, htmlToPlain, inferRemote, toIsoDate } from './normalize'
import { xmlBlocks, xmlText, xmlTexts } from './xml'

// Personio public job feed: https://{slug}.jobs.personio.de/xml (also on .com)
// <workzag-jobs><position> with id, subcompany, office, additionalOffices, department,
// recruitingCategory, name, jobDescriptions, employmentType, seniority, schedule, yearsOfExperience,
// createdAt and, when the employer publishes it, salaryInformation. One request returns the whole board
// with descriptions. An unknown slug answers 404, an empty board answers 200 with no positions.
// Which domain a board lives on is not part of the careers URL, so .de is tried first and .com after a 404.

export type PersonioDomain = 'de' | 'com'

const SCHEDULES: Record<string, string> = { 'full-time': 'Full-time', 'part-time': 'Part-time' }
const EMPLOYMENT: Record<string, string> = {
  permanent: 'Permanent',
  intern: 'Internship',
  trainee: 'Trainee',
  freelance: 'Freelance',
  temporary: 'Temporary',
  working_student: 'Working student'
}

function employmentOf(employmentType: string | null, schedule: string | null): string | null {
  const type = employmentType?.toLowerCase() ?? ''
  if (type === 'intern' || type === 'working_student' || type === 'trainee') return EMPLOYMENT[type]
  return (schedule ? SCHEDULES[schedule.toLowerCase()] : undefined) ?? (type ? (EMPLOYMENT[type] ?? employmentType) : null)
}

/**
 * The least experience Personio's yearsOfExperience range asks for: "lt-1" is 0, "1-2" is 1, "ge-15" is 15.
 * Null when the feed gives none or something else.
 */
function minYearsOf(range: string | null): number | null {
  const text = (range ?? '').trim().toLowerCase()
  if (/^lt-?\d+$/.test(text)) return 0
  const match = /^(?:ge-?)?(\d+)(?:-\d+)?$/.exec(text)
  return match ? Number(match[1]) : null
}

/** Each description block has a heading and an HTML body. They are joined as headed sections. */
function describe(descriptions: string): string {
  const parts: string[] = []
  for (const block of xmlBlocks(descriptions, 'jobDescription')) {
    const heading = xmlText(block, 'name')
    const body = htmlToPlain(xmlText(block, 'value') ?? '')
    if (body) parts.push(heading ? `${heading}\n${body}` : body)
  }
  return parts.join('\n\n')
}

export function parsePersonio(xml: string, slug: string, companyName?: string | null, domain: PersonioDomain = 'de'): RawJob[] {
  const jobs: RawJob[] = []
  for (const block of xmlBlocks(xml, 'position')) {
    // The description sections have their own <name> tags, so the fields are read from the rest.
    const descriptions = xmlBlocks(block, 'jobDescriptions')[0] ?? ''
    const head = descriptions ? block.replace(descriptions, '') : block
    const id = xmlText(head, 'id')
    const name = xmlText(head, 'name')
    if (!id || !name) continue
    const description = describe(descriptions)
    const offices = [xmlText(head, 'office'), ...xmlTexts(xmlBlocks(head, 'additionalOffices')[0] ?? '', 'additionalOffice')].filter((o): o is string => Boolean(o))
    const location = [...new Set(offices)].join('; ') || null
    const title = cleanTitle(name)
    const payBlock = xmlBlocks(head, 'salaryInformation')[0]
    const pay = payBlock
      ? yearlyPay(Number(xmlText(payBlock, 'min')), Number(xmlText(payBlock, 'max')), payPeriodFrom(xmlText(payBlock, 'type')) ?? 'year', xmlText(payBlock, 'currencyCode'))
      : null
    const salary = pay ?? findSalaryInText(description)
    const level = seniorityFromLabel(xmlText(head, 'seniority'))
    const url = `https://${slug}.jobs.personio.${domain}/job/${id}`
    jobs.push({
      source: 'personio',
      externalId: id,
      company: companyName || xmlText(head, 'subcompany') || prettifyToken(slug),
      title,
      location,
      remote: inferRemote({ location, title, description }),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salaryCurrency: salary?.currency ?? null,
      employmentType: employmentOf(xmlText(head, 'employmentType'), xmlText(head, 'schedule')),
      seniority: level ? [level] : [],
      minYears: minYearsOf(xmlText(head, 'yearsOfExperience')),
      url,
      applyUrl: `${url}#apply`,
      ats: 'personio',
      atsToken: slug,
      atsJobId: id,
      description,
      postedAt: toIsoDate(xmlText(head, 'createdAt'))
    })
  }
  return jobs
}

/** Returns the feed text and the domain that answered. */
async function fetchFeed(slug: string, signal?: AbortSignal): Promise<{ xml: string; domain: PersonioDomain }> {
  const get = (domain: PersonioDomain): Promise<string> =>
    fetchText(`https://${encodeURIComponent(slug)}.jobs.personio.${domain}/xml`, {
      timeoutMs: 40_000,
      signal,
      headers: { Accept: 'application/xml, text/xml;q=0.9, */*;q=0.5' }
    })
  try {
    return { xml: await get('de'), domain: 'de' }
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err
    try {
      return { xml: await get('com'), domain: 'com' }
    } catch (comErr) {
      // Neither domain has it, so report the first answer.
      if (comErr instanceof HttpError && comErr.status === 404) throw err
      throw comErr
    }
  }
}

export async function fetchPersonioBoard(slug: string, companyName?: string | null, signal?: AbortSignal): Promise<RawJob[]> {
  const { xml, domain } = await fetchFeed(slug, signal)
  if (!xml.includes('<workzag-jobs')) throw new HttpError(`${slug}.jobs.personio.${domain} did not return a job feed`, null, `https://${slug}.jobs.personio.${domain}/xml`)
  return parsePersonio(xml, slug, companyName, domain)
}
