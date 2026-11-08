import { decodeEntities } from './normalize'
import { READABLE_ATS, detectAts } from './detect'

// Helpers the aggregator sources share (Himalayas, Jobicy, The Muse, We Work Remotely).

const URL_RE = /https?:\/\/[^\s"'<>\\)]+/gi

/**
 * The first link in some HTML or text that points at one posting on an application system jobpls can
 * read. Board pages without a posting id, such as a company's whole Greenhouse board, are skipped.
 */
export function findAtsLink(text: string): string | null {
  for (const match of decodeEntities(text).matchAll(URL_RE)) {
    const link = match[0].replace(/[.,;]+$/, '')
    const found = detectAts(link)
    if (found?.token && found.jobId && READABLE_ATS.includes(found.ats)) return link
  }
  return null
}

export type PayPeriod = 'year' | 'month' | 'week' | 'day' | 'hour'

/** Maps the words feeds use ("annual", "YEAR", "hourly", "per-month-salary") to a period, or null if unknown. */
export function payPeriodFrom(text: string | null | undefined): PayPeriod | null {
  const t = (text ?? '').toLowerCase()
  if (!t) return null
  if (/year|annual|yr/.test(t)) return 'year'
  if (/month/.test(t)) return 'month'
  if (/week/.test(t)) return 'week'
  if (/day|daily/.test(t)) return 'day'
  if (/hour|hr/.test(t)) return 'hour'
  return null
}

const PERIODS_PER_YEAR: Record<PayPeriod, number> = { year: 1, month: 12, week: 52, day: 260, hour: 2080 }

/**
 * A pay range from a feed's own fields, converted to a yearly amount. No upper limit is applied because
 * the currency can be one with large numbers. Returns null for a missing or implausible range.
 */
export function yearlyPay(
  min: number | null | undefined,
  max: number | null | undefined,
  period: PayPeriod | null,
  currency: string | null | undefined
): { min: number; max: number; currency: string | null } | null {
  const lo = typeof min === 'number' && min > 0 ? min : null
  const hi = typeof max === 'number' && max > 0 ? max : null
  const a = lo ?? hi
  const b = hi ?? lo
  if (a === null || b === null) return null
  const factor = PERIODS_PER_YEAR[period ?? 'year']
  const yearlyMin = Math.round(Math.min(a, b) * factor)
  const yearlyMax = Math.round(Math.max(a, b) * factor)
  if (yearlyMin < 1000) return null
  return { min: yearlyMin, max: yearlyMax, currency: currency?.trim().toUpperCase() || null }
}

/** "Full Time", "full_time" and "FULL_TIME" all become "Full-time". Other values come back tidied. */
export function employmentLabel(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim()
  if (!raw) return null
  const key = raw.toLowerCase().replace(/[\s_-]+/g, '')
  const known: Record<string, string> = {
    fulltime: 'Full-time',
    parttime: 'Part-time',
    contract: 'Contract',
    contractor: 'Contract',
    freelance: 'Freelance',
    temporary: 'Temporary',
    temp: 'Temporary',
    intern: 'Internship',
    internship: 'Internship',
    permanent: 'Permanent',
    other: 'Other'
  }
  return known[key] ?? raw
}
