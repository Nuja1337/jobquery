import type { AtsKind } from './types'

/** Failures in a row after which a board is no longer watched. The main process keeps the same number. */
export const STOP_AFTER_FAILURES = 5

/** The public careers page of a board, or null for a system without a known address pattern. */
export function boardUrl(ats: AtsKind, token: string | null): string | null {
  if (!token) return null
  const t = encodeURIComponent(token)
  switch (ats) {
    case 'greenhouse':
      return `https://boards.greenhouse.io/${t}`
    case 'lever':
      return `https://jobs.lever.co/${t}`
    case 'ashby':
      return `https://jobs.ashbyhq.com/${t}`
    case 'smartrecruiters':
      return `https://careers.smartrecruiters.com/${t}`
    case 'workable':
      return `https://apply.workable.com/${t}`
    case 'rippling':
      return `https://ats.rippling.com/${t}/jobs`
    case 'breezy':
      return `https://${t}.breezy.hr`
    case 'personio':
      return `https://${t}.jobs.personio.de`
    case 'recruitee':
      return `https://${t}.recruitee.com`
    default:
      return null
  }
}
