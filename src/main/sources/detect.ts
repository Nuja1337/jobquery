import type { AtsDetection, AtsKind } from '@shared/types'

/** "ramp" becomes "Ramp", "acme-labs" becomes "Acme Labs". Only a starting point for the user to correct. */
export function prettifyToken(token: string): string {
  return token
    .replace(/[-_]+/g, ' ')
    .replace(/\d+$/, '')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

function result(ats: AtsKind, token: string | null, jobId: string | null): AtsDetection {
  return { ats, token, jobId, companyName: token ? prettifyToken(token) || null : null }
}

/** Hosts under breezy.hr that are the vendor's own sites, not a company's board. */
const BREEZY_RESERVED = new Set(['www', 'app', 'api', 'help', 'support', 'blog', 'marketplace'])

function segments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
}

/** Which ATS a careers or posting URL belongs to, with the board token and job id when the URL has them. */
export function detectAts(input: string): AtsDetection | null {
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const parts = segments(url)

  // Greenhouse: boards.greenhouse.io/{token}[/jobs/{id}], job-boards.greenhouse.io/{token}/jobs/{id}, job-boards.eu.greenhouse.io
  if (host === 'boards.greenhouse.io' || /^job-boards(\.[a-z]+)?\.greenhouse\.io$/.test(host) || host === 'boards.eu.greenhouse.io') {
    if (parts[0] === 'embed') {
      const token = url.searchParams.get('for')
      return token ? result('greenhouse', token, url.searchParams.get('token')) : null
    }
    const token = parts[0]
    if (!token) return null
    const jobId = parts[1] === 'jobs' && /^\d+$/.test(parts[2] ?? '') ? parts[2] : null
    return result('greenhouse', token, jobId)
  }

  // Lever: jobs.lever.co/{slug}/{id}
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const token = parts[0]
    if (!token) return null
    return result('lever', token, parts[1] ?? null)
  }

  // Ashby: jobs.ashbyhq.com/{org}/{id}
  if (host === 'jobs.ashbyhq.com') {
    const token = parts[0]
    if (!token) return null
    return result('ashby', token, parts[1] ?? null)
  }

  // SmartRecruiters: jobs.smartrecruiters.com/{company}/{id}-{slug}, careers.smartrecruiters.com/{company}
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com' || host === 'api.smartrecruiters.com') {
    const rest = host === 'api.smartrecruiters.com' ? parts.slice(2) : parts
    const token = rest[0]
    if (!token) return null
    const jobId = /^\d+/.exec(rest[1] ?? rest[2] ?? '')?.[0] ?? null
    return result('smartrecruiters', token, jobId)
  }

  // Workable: apply.workable.com/{slug}/j/{id}
  if (host === 'apply.workable.com') {
    const token = parts[0]
    if (!token || token === 'j' || token === 'api') return null
    return result('workable', token, parts[1] === 'j' ? (parts[2] ?? null) : null)
  }

  // Workday: {tenant}.wd{n}.myworkdayjobs.com/[{locale}/]{site}/job/{place}/{title}_{reqId}
  if (host.endsWith('.myworkdayjobs.com')) {
    const tenant = host.split('.')[0]
    const last = parts[parts.length - 1] ?? ''
    const jobId = parts.includes('job') ? (/_([A-Za-z0-9-]+)$/.exec(last)?.[1] ?? last) : null
    return result('workday', tenant, jobId)
  }

  // Recruitee: {slug}.recruitee.com/o/{job-slug}
  if (host.endsWith('.recruitee.com') && host !== 'recruitee.com' && !host.startsWith('api.')) {
    const token = host.split('.')[0]
    return result('recruitee', token, parts[0] === 'o' ? (parts[1] ?? null) : null)
  }

  // Rippling: ats.rippling.com/[{locale}/]{slug}/jobs/{uuid}, api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid}
  if (host === 'ats.rippling.com' || host === 'api.rippling.com') {
    let rest = parts
    if (host === 'api.rippling.com') {
      const board = parts.indexOf('board')
      if (board === -1) return null
      rest = parts.slice(board + 1)
    } else if (/^[a-z]{2}-[a-z]{2}$/i.test(rest[0] ?? '') && rest.length > 1) {
      rest = rest.slice(1)
    }
    const token = rest[0]
    if (!token) return null
    return result('rippling', token, rest[1] === 'jobs' ? (rest[2] ?? null) : null)
  }

  // Breezy: {slug}.breezy.hr/p/{id}-{title}. The id is the leading run of hex digits.
  if (host.endsWith('.breezy.hr') && !BREEZY_RESERVED.has(host.split('.')[0])) {
    const token = host.split('.')[0]
    const jobId = parts[0] === 'p' ? (/^[0-9a-f]{8,}/i.exec(parts[1] ?? '')?.[0].toLowerCase() ?? null) : null
    return result('breezy', token, jobId)
  }

  // Personio: {slug}.jobs.personio.de/job/{id}, also on .com
  const personio = /^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/.exec(host)
  if (personio) {
    return result('personio', personio[1], parts[0] === 'job' && /^\d+$/.test(parts[1] ?? '') ? parts[1] : null)
  }

  return null
}

/** Board APIs the pipeline can read. Workday and Recruitee are only detected. */
export const READABLE_ATS: AtsKind[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'rippling', 'breezy', 'personio']

/**
 * Fills in the employer's application system for a posting from a job board, when its apply link or
 * posting link points at one and names the posting. The source and external id stay as they are.
 * A posting with no such link comes back unchanged.
 */
export function withAtsIdentity<T extends { url: string; applyUrl: string | null; ats: AtsKind; atsToken: string | null; atsJobId?: string | null }>(raw: T): T {
  for (const link of [raw.applyUrl, raw.url]) {
    if (!link) continue
    const found = detectAts(link)
    if (!found?.token || !found.jobId) continue
    // Workable shortcodes are upper case on the board's own API.
    const atsJobId = found.ats === 'workable' ? found.jobId.toUpperCase() : found.jobId
    return { ...raw, ats: found.ats, atsToken: found.token, atsJobId }
  }
  return raw
}
