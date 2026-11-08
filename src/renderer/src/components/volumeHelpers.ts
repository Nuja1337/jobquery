import type { ProviderQuota, VolumeCounts } from '@shared/types'

export interface FunnelStep {
  key: 'found' | 'passed' | 'scored' | 'shortlisted' | 'prepared' | 'sent'
  label: string
  value: number
}

/** The six steps of the funnel row, from the counts for one window. */
export function funnelSteps(c: VolumeCounts): FunnelStep[] {
  return [
    { key: 'found', label: 'Found', value: c.discovered },
    // Jobs a free rule dropped did not pass the filters.
    { key: 'passed', label: 'Passed filters', value: Math.max(0, c.discovered - c.filteredOut) },
    { key: 'scored', label: 'Scored', value: c.scored },
    { key: 'shortlisted', label: 'Shortlisted', value: c.shortlisted },
    { key: 'prepared', label: 'Prepared', value: c.prepared },
    { key: 'sent', label: 'Sent', value: c.submitted }
  ]
}

/** "62% of found" for a step, or null for the first step and when the first step is empty. */
export function shareOfFound(steps: FunnelStep[], index: number): number | null {
  if (index === 0 || steps[0].value === 0) return null
  return steps[index].value / steps[0].value
}

/** Jobs scored at or above a threshold, from the counts by exact score (index 0 is score 50). Thresholds under 50 count from 50. */
export function scoredAtOrAbove(scoreCounts: number[], threshold: number): number {
  const first = Math.max(0, Math.ceil(threshold) - 50)
  let total = 0
  for (let i = first; i < scoreCounts.length; i++) total += scoreCounts[i]
  return total
}

/** The line shown under a threshold input. */
export function thresholdContext(scoreCounts: number[], threshold: number): string {
  const n = scoredAtOrAbove(scoreCounts, threshold)
  const base = `In the last 7 days, ${n.toLocaleString('en-US')} scored ${n === 1 ? 'job was' : 'jobs were'} at or above this line.`
  return threshold < 50 ? `${base} Jobs scored under 50 are not counted.` : base
}

/** "14:00" in the viewer's time zone for the start of an hour. */
export function hourLabel(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

/** Requests used against a daily limit as a share from 0 to 1, or null when the provider has no limit. */
export function quotaShare(q: Pick<ProviderQuota, 'requestsToday' | 'requestsPerDay'>): number | null {
  return q.requestsPerDay && q.requestsPerDay > 0 ? Math.min(1, q.requestsToday / q.requestsPerDay) : null
}

export function quotaTone(share: number | null): 'accent' | 'warn' | 'bad' {
  if (share === null) return 'accent'
  return share >= 1 ? 'bad' : share >= 0.8 ? 'warn' : 'accent'
}

export interface PageInfo {
  page: number
  pages: number
  /** 1-based position of the first row on the page, 0 when there are none. */
  from: number
  to: number
  offset: number
  hasPrev: boolean
  hasNext: boolean
}

/** Page numbers start at 1. A page past the end is moved back to the last page. */
export function pageInfo(total: number, page: number, size: number): PageInfo {
  const pages = Math.max(1, Math.ceil(total / size))
  const p = Math.min(Math.max(1, Math.floor(page)), pages)
  const offset = (p - 1) * size
  return { page: p, pages, from: total === 0 ? 0 : offset + 1, to: Math.min(total, offset + size), offset, hasPrev: p > 1, hasNext: p < pages }
}
