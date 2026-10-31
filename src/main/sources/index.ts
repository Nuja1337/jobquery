import type { AtsKind, RawJob, SavedSearch, SourceKind } from '@shared/types'
import type { AppContext } from '../context'
import { fetchAdzuna } from './adzuna'
import { fetchArbeitnow } from './arbeitnow'
import { fetchAshbyBoard } from './ashby'
import { fetchGreenhouseBoard } from './greenhouse'
import { fetchHnWhoIsHiring } from './hn'
import { fetchLeverBoard } from './lever'
import { fetchRemoteOk } from './remoteok'
import { fetchRemotive } from './remotive'
import { fetchSmartRecruitersBoard } from './smartrecruiters'
import { fetchWorkableBoard } from './workable'

export { fetchJobByUrl } from './byUrl'
export { detectAts } from './detect'

/** One unit of discovery: a watched company's board or a saved search. */
export interface DiscoveryTask {
  /** Shown in progress messages and error events. */
  name: string
  /** Set for company boards. Used to close jobs that left the board. */
  board?: { source: SourceKind; atsToken: string; companyId: string }
  searchId?: string
  /** Set for saved searches. Which source answered tells the pipeline which jobs it may close. */
  searchSource?: SourceKind
  run(signal?: AbortSignal): Promise<{ jobs: RawJob[]; complete?: boolean }>
}

export type TaskProvider = (ctx: AppContext) => DiscoveryTask[]

async function plain(jobs: Promise<RawJob[]>) {
  return { jobs: await jobs }
}

/** Remotive asks for at most about four calls a day. HN threads change once a month. */
export const MIN_HOURS_BETWEEN_CALLS: Partial<Record<SavedSearch['source'], number>> = {
  remotive: 6,
  hn_whoishiring: 6,
  remoteok: 1,
  arbeitnow: 1,
  adzuna: 1
}

const callKey = (source: string) => `source_last_call:${source}`

interface LastCall {
  at: string
  searchId: string
}

function readLastCall(ctx: AppContext, source: string): LastCall | null {
  const row = ctx.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { key: callKey(source) })
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Partial<LastCall>
    return typeof parsed.at === 'string' && typeof parsed.searchId === 'string' ? { at: parsed.at, searchId: parsed.searchId } : null
  } catch {
    return null
  }
}

function writeLastCall(ctx: AppContext, source: string, searchId: string): void {
  ctx.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (:key, :value)', {
    key: callKey(source),
    value: JSON.stringify({ at: new Date().toISOString(), searchId })
  })
}

/**
 * The saved searches to run now. A source's request limit belongs to the source, not to each
 * search, so at most one search per source runs, and only when the source's minimum gap since its
 * last call has passed. The attempt counts even when it failed. Searches of one source take turns.
 */
export function searchesDue(ctx: AppContext, now = Date.now()): SavedSearch[] {
  const bySource = new Map<SavedSearch['source'], SavedSearch[]>()
  for (const search of ctx.searches.listEnabled()) {
    const list = bySource.get(search.source) ?? []
    list.push(search)
    bySource.set(search.source, list)
  }
  const due: SavedSearch[] = []
  for (const [source, searches] of bySource) {
    const last = readLastCall(ctx, source)
    // Runs recorded before the per-source limit existed still count.
    const newest = Math.max(last ? Date.parse(last.at) : 0, ...searches.map((s) => (s.lastRunAt ? Date.parse(s.lastRunAt) : 0)))
    const minHours = MIN_HOURS_BETWEEN_CALLS[source] ?? 1
    if (Number.isFinite(newest) && now - newest < minHours * 3_600_000) continue
    const ordered = [...searches].sort((a, b) => a.id.localeCompare(b.id))
    const after = last ? ordered.findIndex((s) => s.id === last.searchId) : -1
    due.push(ordered[(after + 1) % ordered.length])
  }
  return due
}

/** The tasks for one run: every watched company with a readable ATS board, then every enabled saved search. */
export const defaultTasks: TaskProvider = (ctx) => {
  const tasks: DiscoveryTask[] = []
  for (const company of ctx.companies.listWatched()) {
    const token = company.atsToken!
    const ats: AtsKind = company.ats
    const board = { source: ats as SourceKind, atsToken: token, companyId: company.id }
    const name = company.name
    switch (ats) {
      case 'greenhouse':
        tasks.push({ name, board, run: (s) => plain(fetchGreenhouseBoard(token, name, s)) })
        break
      case 'lever':
        tasks.push({ name, board, run: (s) => plain(fetchLeverBoard(token, name, s)) })
        break
      case 'ashby':
        tasks.push({ name, board, run: (s) => plain(fetchAshbyBoard(token, name, s)) })
        break
      case 'workable':
        tasks.push({ name, board, run: (s) => plain(fetchWorkableBoard(token, name, s)) })
        break
      case 'smartrecruiters': {
        const known = ctx.jobs.knownExternalIds('smartrecruiters', token)
        tasks.push({ name, board, run: (s) => fetchSmartRecruitersBoard(token, name, { isKnown: (id) => known.has(id), signal: s }) })
        break
      }
      default:
        break
    }
  }
  // Respect each source's request limits even when the user presses Run now often.
  for (const search of searchesDue(ctx)) {
    const label = search.label || search.source
    const p = search.params
    const call = <T>(fetch: (signal?: AbortSignal) => Promise<T>) => (signal?: AbortSignal) => {
      writeLastCall(ctx, search.source, search.id)
      return fetch(signal)
    }
    const base = { name: label, searchId: search.id, searchSource: search.source as SourceKind }
    switch (search.source) {
      case 'remotive':
        tasks.push({ ...base, run: call((s) => plain(fetchRemotive(p, s))) })
        break
      case 'remoteok':
        tasks.push({ ...base, run: call((s) => plain(fetchRemoteOk(p, s))) })
        break
      case 'arbeitnow':
        tasks.push({ ...base, run: call((s) => plain(fetchArbeitnow(p, s))) })
        break
      case 'hn_whoishiring':
        tasks.push({ ...base, run: call((s) => plain(fetchHnWhoIsHiring(p, s))) })
        break
      case 'adzuna':
        tasks.push({ ...base, run: call((s) => plain(fetchAdzuna(p, s))) })
        break
    }
  }
  return tasks
}
