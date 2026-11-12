// The companies part of the demo API: paging, filters, bulk actions, the starter pack and board import.

import type { Api, BoardImportLine, BoardProbe, CompanyCounts, CompanyWithBoard, PushChannel, PushEvents } from '@shared/api'
import { boardUrl } from '@shared/sources'
import type { AtsDetection, AtsKind, Company } from '@shared/types'
import { starterPack } from '../../../main/sources/starterPack'
import { iso } from './mockData'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MAX_FAILURES = 5
const READABLE: AtsKind[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'rippling', 'breezy', 'personio']

interface BoardState {
  lastCheckedAt: string | null
  nextCheckAt: string
  intervalMinutes: number
  failures: number
  lastError: string | null
  liveJobs: number
  relevantJobs: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const titleCase = (s: string): string => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** What the demo makes of a careers address. */
export function detectMock(url: string): AtsDetection | null {
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`)
  } catch {
    return null
  }
  const parts = u.pathname.split('/').filter(Boolean)
  if (/greenhouse\.io$/.test(u.hostname) && parts[0]) return { ats: 'greenhouse', token: parts[0], jobId: parts[2] ?? null, companyName: titleCase(parts[0]) }
  if (u.hostname === 'jobs.lever.co' && parts[0]) return { ats: 'lever', token: parts[0], jobId: parts[1] ?? null, companyName: titleCase(parts[0]) }
  if (u.hostname === 'jobs.ashbyhq.com' && parts[0]) return { ats: 'ashby', token: parts[0], jobId: parts[1] ?? null, companyName: titleCase(parts[0]) }
  if (/smartrecruiters\.com$/.test(u.hostname) && parts[0]) return { ats: 'smartrecruiters', token: parts[0], jobId: null, companyName: titleCase(parts[0]) }
  if (/myworkdayjobs\.com$/.test(u.hostname)) return { ats: 'workday', token: u.hostname.split('.')[0], jobId: null, companyName: titleCase(u.hostname.split('.')[0]) }
  return { ats: 'unknown', token: null, jobId: null, companyName: titleCase(u.hostname.replace(/^(www|careers|jobs)\./, '').split('.')[0]) }
}

export function initialBoardStates(companies: Company[]): Map<string, BoardState> {
  const states = new Map<string, BoardState>()
  const seeds: Record<string, Partial<BoardState>> = {
    co_northwindlabs: { liveJobs: 14, relevantJobs: 3, lastCheckedAt: iso(2 * HOUR), nextCheckAt: iso(-4 * HOUR) },
    co_fieldnote: { liveJobs: 6, relevantJobs: 1, lastCheckedAt: iso(HOUR), nextCheckAt: iso(-5 * HOUR) },
    co_kestreldata: { liveJobs: 9, relevantJobs: 0, failures: 2, lastError: 'Lever answered with HTTP 503.', lastCheckedAt: iso(30 * MINUTE), nextCheckAt: iso(-3 * HOUR) },
    co_lumenrobotics: { liveJobs: 4, relevantJobs: 0, failures: MAX_FAILURES, lastError: 'Greenhouse has no board named "lumenrobotics".', lastCheckedAt: iso(2 * DAY), nextCheckAt: iso(-1 * DAY) }
  }
  for (const c of companies) {
    if (!c.atsToken) continue
    states.set(c.id, { lastCheckedAt: null, nextCheckAt: iso(0), intervalMinutes: 360, failures: 0, lastError: null, liveJobs: 0, relevantJobs: 0, ...seeds[c.id] })
  }
  return states
}

type Emit = <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void

export function createMockCompanies(initial: Company[], emit: Emit, uid: (prefix: string) => string) {
  let companies = initial
  const states = initialBoardStates(initial)

  const stateOf = (id: string): BoardState | undefined => states.get(id)
  const withBoard = (c: Company): CompanyWithBoard => {
    const s = stateOf(c.id)
    return {
      ...c,
      lastCheckedAt: s?.lastCheckedAt ?? null,
      nextCheckAt: s?.nextCheckAt ?? null,
      intervalMinutes: s?.intervalMinutes ?? null,
      failures: s?.failures ?? 0,
      lastError: s?.lastError ?? null,
      liveJobs: s?.liveJobs ?? 0,
      relevantJobs: s?.relevantJobs ?? 0
    }
  }
  const startWatching = (c: Company): void => {
    if (!c.atsToken || c.ats === 'unknown') return
    const s = stateOf(c.id)
    if (s) Object.assign(s, { failures: 0, lastError: null, nextCheckAt: iso(0) })
    else states.set(c.id, { lastCheckedAt: null, nextCheckAt: iso(0), intervalMinutes: 360, failures: 0, lastError: null, liveJobs: 0, relevantJobs: 0 })
  }
  const counts = (): CompanyCounts => {
    const all = companies.map(withBoard)
    const watched = all.filter((c) => c.watch && !c.blocked)
    const due = watched.filter((c) => c.atsToken && c.ats !== 'unknown' && c.nextCheckAt).map((c) => c.nextCheckAt as string).sort()
    return {
      total: all.length,
      watched: watched.length,
      blocked: all.filter((c) => c.blocked).length,
      fromPostings: all.filter((c) => c.origin === 'posting_link').length,
      stopped: all.filter((c) => !c.watch && !c.blocked && c.failures >= MAX_FAILURES).length,
      failing: watched.filter((c) => c.failures >= 1 && c.failures < MAX_FAILURES).length,
      liveJobs: watched.reduce((n, c) => n + c.liveJobs, 0),
      relevantJobs: watched.reduce((n, c) => n + c.relevantJobs, 0),
      nextCheckAt: due[0] ?? null
    }
  }
  const addBoards = (boards: Array<{ ats: AtsKind; token: string; name: string | null }>, origin: Company['origin']): { added: number; skipped: number } => {
    let added = 0
    let skipped = 0
    for (const b of boards) {
      if (!READABLE.includes(b.ats) || companies.some((c) => c.ats === b.ats && c.atsToken === b.token)) {
        skipped += 1
        continue
      }
      const company: Company = {
        id: uid('co'),
        name: b.name?.trim() || titleCase(b.token),
        ats: b.ats,
        atsToken: b.token,
        careersUrl: boardUrl(b.ats, b.token),
        watch: true,
        blocked: false,
        notes: '',
        origin,
        createdAt: iso(0)
      }
      companies = [...companies, company]
      startWatching(company)
      added += 1
    }
    return { added, skipped }
  }

  const api: Pick<Api, 'listCompanies' | 'saveCompany' | 'deleteCompany' | 'bulkCompanies' | 'addStarterPack' | 'parseBoardImport' | 'probeBoards' | 'importBoards'> = {
    async listCompanies(query = {}) {
      const size = Math.min(200, Math.max(1, query.pageSize ?? 50))
      const page = Math.max(1, query.page ?? 1)
      const text = query.search?.trim().toLowerCase()
      const matches = companies
        .map(withBoard)
        .filter((c) => !text || c.name.toLowerCase().includes(text) || (c.atsToken ?? '').toLowerCase().includes(text))
        .filter((c) => !query.ats || query.ats === 'all' || c.ats === query.ats)
        .filter((c) => !query.origin || query.origin === 'all' || c.origin === query.origin)
        .filter((c) => {
          switch (query.state) {
            case 'watched':
              return c.watch && !c.blocked
            case 'unwatched':
              return !c.watch && !c.blocked
            case 'blocked':
              return c.blocked
            case 'stopped':
              return !c.watch && !c.blocked && c.failures >= MAX_FAILURES
            case 'failing':
              return c.watch && !c.blocked && c.failures >= 1 && c.failures < MAX_FAILURES
            default:
              return true
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
      return structuredClone({ items: matches.slice((page - 1) * size, page * size), total: matches.length, counts: counts() })
    },
    async saveCompany(input) {
      const existing = input.id ? companies.find((c) => c.id === input.id) : undefined
      const next: Company = {
        id: existing?.id ?? uid('co'),
        name: input.name ?? existing?.name ?? 'Unnamed company',
        ats: input.ats ?? existing?.ats ?? 'unknown',
        atsToken: input.atsToken ?? existing?.atsToken ?? null,
        careersUrl: input.careersUrl ?? existing?.careersUrl ?? null,
        watch: input.watch ?? existing?.watch ?? true,
        blocked: input.blocked ?? existing?.blocked ?? false,
        notes: input.notes ?? existing?.notes ?? '',
        origin: input.origin ?? existing?.origin ?? 'manual',
        createdAt: existing?.createdAt ?? iso(0)
      }
      companies = existing ? companies.map((c) => (c.id === next.id ? next : c)) : [...companies, next]
      if (next.watch && !existing?.watch) startWatching(next)
      return next
    },
    async deleteCompany(id) {
      companies = companies.filter((c) => c.id !== id)
      states.delete(id)
    },
    async bulkCompanies({ ids, action }) {
      let changed = 0
      for (const id of new Set(ids)) {
        const c = companies.find((x) => x.id === id)
        if (!c) continue
        if (action === 'delete') {
          companies = companies.filter((x) => x.id !== id)
          states.delete(id)
          changed += 1
          continue
        }
        const patch: Partial<Company> | null =
          action === 'watch' ? (c.blocked || c.watch ? null : { watch: true })
          : action === 'unwatch' ? (c.watch ? { watch: false } : null)
          : action === 'block' ? (c.blocked ? null : { blocked: true, watch: false })
          : c.blocked ? { blocked: false } : null
        if (action === 'watch' && c.watch && !c.blocked) startWatching(c)
        if (!patch) continue
        const next = { ...c, ...patch }
        companies = companies.map((x) => (x.id === id ? next : x))
        if (patch.watch) startWatching(next)
        changed += 1
      }
      return { changed }
    },
    async addStarterPack(group) {
      await sleep(250)
      return addBoards(starterPack(group === 'all' ? undefined : group), 'starter')
    },
    async parseBoardImport(text) {
      const out: BoardImportLine[] = []
      const seen = new Set<string>()
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const pair = /^([a-z]+):([A-Za-z0-9._-]+)$/i.exec(line)
        const found: AtsDetection | null = pair ? { ats: pair[1].toLowerCase() as AtsKind, token: pair[2], jobId: null, companyName: titleCase(pair[2]) } : /\s/.test(line) ? null : detectMock(line)
        if (!found?.token) {
          out.push({ line, error: /\s/.test(line) ? 'Put one address or ats:token on each line.' : 'JobQuery could not tell which application system this address uses.' })
        } else if (!READABLE.includes(found.ats)) {
          out.push({ line, error: `This is a ${found.ats} careers page. JobQuery can detect it but cannot read its jobs yet.` })
        } else if (!seen.has(`${found.ats}:${found.token}`)) {
          seen.add(`${found.ats}:${found.token}`)
          out.push({ ats: found.ats, token: found.token, name: found.companyName, line })
        }
      }
      return out
    },
    async probeBoards(entries, token) {
      if (entries.length > 500) throw new Error('Check at most 500 boards at a time.')
      const results: BoardProbe[] = []
      for (const e of entries) {
        await sleep(160)
        const bad = /gone|missing|nope/i.test(e.token)
        const result: BoardProbe = bad
          ? { ...e, ok: false, error: `${titleCase(e.ats)} has no board named "${e.token}".` }
          : { ...e, ok: true, name: titleCase(e.token), jobs: (e.token.length * 7) % 31 }
        results.push(result)
        emit('boards:probe', { token, done: results.length, total: entries.length, result })
      }
      return results
    },
    async importBoards(entries) {
      await sleep(250)
      return addBoards(entries, 'import')
    }
  }
  return api
}
