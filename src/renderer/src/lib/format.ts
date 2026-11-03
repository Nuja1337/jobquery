import type { JobSummary, RemoteType, SourceKind } from '@shared/types'

export const REMOTE_LABELS: Record<RemoteType, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On site', unknown: 'Not listed' }

export function formatUsd(n: number | null | undefined): string {
  if (n == null) return '-'
  if (n === 0) return '$0'
  const abs = Math.abs(n)
  if (abs < 0.1) return `$${n.toFixed(3)}`
  if (abs < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '-'
  if (n < 1000) return `${Math.round(n)} tokens`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tokens`
  return `${(n / 1_000_000).toFixed(1)}M tokens`
}

/** Compact number for axes and tiles: 1.2k, 3.4M. */
export function compact(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n * 10) / 10)
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function formatPercent(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return '-'
  return `${(n * 100).toFixed(digits)}%`
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "5m ago", "3h ago", "2d ago". Future times read "in 3h". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '-'
  const diff = now - t
  const abs = Math.abs(diff)
  let text: string
  if (abs < MINUTE) text = 'under a minute'
  else if (abs < HOUR) text = `${Math.round(abs / MINUTE)}m`
  else if (abs < DAY) text = `${Math.round(abs / HOUR)}h`
  else if (abs < 60 * DAY) text = `${Math.round(abs / DAY)}d`
  else text = `${Math.round(abs / (30 * DAY))}mo`
  return diff >= 0 ? `${text} ago` : `in ${text}`
}

/** Short age for table rows: 3h, 2d, 5w. */
export function shortAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '-'
  const diff = Math.max(0, now - t)
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))}m`
  if (diff < DAY) return `${Math.round(diff / HOUR)}h`
  if (diff < 14 * DAY) return `${Math.round(diff / DAY)}d`
  if (diff < 60 * DAY) return `${Math.round(diff / (7 * DAY))}w`
  return `${Math.round(diff / (30 * DAY))}mo`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function formatShortDay(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function money(n: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : `${currency} `
  if (n >= 1000) return `${symbol}${Math.round(n / 1000)}k`
  return `${symbol}${n}`
}

export function formatSalary(job: Pick<JobSummary, 'salaryMin' | 'salaryMax' | 'salaryCurrency'>): string {
  const { salaryMin: min, salaryMax: max } = job
  const cur = job.salaryCurrency ?? 'USD'
  if (min == null && max == null) return ''
  if (min != null && max != null && min !== max) return `${money(min, cur)} to ${money(max, cur)}`
  return money((min ?? max) as number, cur)
}

export const SOURCE_LABELS: Record<SourceKind, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  remotive: 'Remotive',
  remoteok: 'RemoteOK',
  arbeitnow: 'Arbeitnow',
  hn_whoishiring: 'HN Who is Hiring',
  adzuna: 'Adzuna',
  manual: 'Added by URL'
}

/** Multi-pick answers are stored as JSON array strings. */
export function parseMulti(value: string): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // fall through: treat as a single value
  }
  return value ? [value] : []
}

export function stringifyMulti(values: string[]): string {
  return JSON.stringify(values)
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return 'Something went wrong.'
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
