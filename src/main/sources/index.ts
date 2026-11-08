import type { AtsKind, RawJob, SavedSearch, SourceKind } from '@shared/types'
import type { AppContext } from '../context'
import { fetchAdzuna } from './adzuna'
import { fetchArbeitnow } from './arbeitnow'
import { fetchAshbyBoardChanges } from './ashby'
import { fetchBreezyBoard } from './breezy'
import { fetchGreenhouseBoardChanges } from './greenhouse'
import { fetchHimalayas } from './himalayas'
import { fetchHnWhoIsHiring } from './hn'
import { fetchJobicy } from './jobicy'
import { type BoardChanges, type BoardReadState } from './http'
import { fetchLeverBoardChanges } from './lever'
import { fetchPersonioBoard } from './personio'
import { fetchRemoteOk } from './remoteok'
import { fetchRemotive } from './remotive'
import { fetchRipplingBoard } from './rippling'
import { fetchSmartRecruitersBoard } from './smartrecruiters'
import { fetchTheMuse } from './themuse'
import { fetchWeWorkRemotely } from './weworkremotely'
import { fetchWorkableBoardChanges } from './workable'

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
  /** The host the task talks to. A task whose host is paused is skipped and stays due. */
  host?: string
  run(signal?: AbortSignal): Promise<TaskResult>
}

export interface TaskResult {
  jobs: RawJob[]
  complete?: boolean
  /** Board postings that are stored already and were not read again. They stay open and count as seen. */
  seenExternalIds?: string[]
  /** The board said nothing changed. No posting is stored, closed or reopened. */
  unchanged?: boolean
  /** New validators for the board. Undefined keeps the stored ones and null clears them. */
  etag?: string | null
  lastModified?: string | null
  listHash?: string | null
}

export interface TaskOptions {
  /** Read every watched board, not only the ones that are due. */
  allBoards?: boolean
  now?: number
}

export type TaskProvider = (ctx: AppContext, options?: TaskOptions) => DiscoveryTask[]

async function plain(jobs: Promise<RawJob[]>) {
  return { jobs: await jobs }
}

function fromChanges(changes: BoardChanges): TaskResult {
  if (!changes.changed) {
    return { jobs: [], unchanged: true, etag: changes.etag, lastModified: changes.lastModified, listHash: changes.listHash }
  }
  return {
    jobs: changes.jobs,
    complete: changes.complete,
    seenExternalIds: changes.seenExternalIds,
    etag: changes.etag,
    lastModified: changes.lastModified,
    listHash: changes.listHash
  }
}

type BoardReader = (token: string, name: string, state: BoardReadState, signal?: AbortSignal) => Promise<TaskResult>

/** How each application system's board is read, and which host the reads go to. */
const BOARD_READERS: Partial<Record<AtsKind, { host: string; read: BoardReader }>> = {
  greenhouse: { host: 'boards-api.greenhouse.io', read: async (t, n, st, s) => fromChanges(await fetchGreenhouseBoardChanges(t, n, st, s)) },
  lever: { host: 'api.lever.co', read: async (t, n, st, s) => fromChanges(await fetchLeverBoardChanges(t, n, st, s)) },
  ashby: { host: 'api.ashbyhq.com', read: async (t, n, st, s) => fromChanges(await fetchAshbyBoardChanges(t, n, st, s)) },
  workable: { host: 'apply.workable.com', read: async (t, n, st, s) => fromChanges(await fetchWorkableBoardChanges(t, n, st, s)) },
  // SmartRecruiters sends no ETag, so each check lists the board. Postings that are stored keep their text.
  smartrecruiters: {
    host: 'api.smartrecruiters.com',
    read: (t, n, st, s) => fetchSmartRecruitersBoard(t, n, { isKnown: (id) => st.known?.has(id) ?? false, signal: s })
  },
  // Rippling and Breezy list postings without their text, so stored postings skip the detail request.
  rippling: { host: 'api.rippling.com', read: (t, n, st, s) => fetchRipplingBoard(t, n, { isKnown: (id) => st.known?.has(id) ?? false, signal: s }) },
  breezy: { host: 'breezy.hr', read: (t, n, st, s) => fetchBreezyBoard(t, n, { isKnown: (id) => st.known?.has(id) ?? false, signal: s }) },
  personio: { host: 'jobs.personio.de', read: async (t, n, _st, s) => plain(fetchPersonioBoard(t, n, s)) }
}

/** The application systems whose boards can be read now. */
export const BOARD_ATS: AtsKind[] = Object.keys(BOARD_READERS) as AtsKind[]

/** Whether the app can read this system's board. A company on any other system is not worth watching yet. */
export const canReadBoard = (ats: AtsKind): boolean => ats in BOARD_READERS

/** Remotive asks for at most about four calls a day. HN threads change once a month. */
export const MIN_HOURS_BETWEEN_CALLS: Partial<Record<SavedSearch['source'], number>> = {
  remotive: 6,
  hn_whoishiring: 6,
  remoteok: 1,
  arbeitnow: 1,
  adzuna: 1,
  // Himalayas refreshes its feed daily and asks for few calls. Jobicy covers the last seven days and asks for hourly polling at most.
  himalayas: 6,
  jobicy: 1,
  themuse: 1,
  weworkremotely: 1
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

/**
 * The tasks for one run: the watched company boards that are due, then every enabled saved search.
 * A board is due when its next check time has passed, so a quiet board costs one small request a few times
 * a day. At most `boardsPerRun` boards are taken, the longest-waiting first.
 */
export const defaultTasks: TaskProvider = (ctx, options = {}) => {
  const tasks: DiscoveryTask[] = []
  const now = options.now ?? Date.now()
  const limit = options.allBoards ? 1_000_000 : Math.max(0, ctx.settings.get().discovery.boardsPerRun)
  const at = options.allBoards ? '9999-12-31T00:00:00.000Z' : new Date(now).toISOString()
  for (const { company, state } of ctx.boards.due(at, limit, BOARD_ATS)) {
    const token = company.atsToken!
    const ats: AtsKind = company.ats
    const reader = BOARD_READERS[ats]
    if (!reader) continue
    const board = { source: ats as SourceKind, atsToken: token, companyId: company.id }
    const name = company.name
    tasks.push({
      name,
      board,
      host: reader.host,
      run: (signal) =>
        reader.read(
          token,
          name,
          // The stored text of known postings is read when the board is, not for every due board up front.
          { etag: state.etag, lastModified: state.lastModified, listHash: state.listHash, known: ctx.jobs.knownExternalIds(board.source, token) },
          signal
        )
    })
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
      case 'himalayas':
        tasks.push({ ...base, run: call((s) => plain(fetchHimalayas(p, s))) })
        break
      case 'jobicy':
        tasks.push({ ...base, run: call((s) => plain(fetchJobicy(p, s))) })
        break
      case 'themuse': {
        // Landing pages are read only for postings not stored yet.
        const known = ctx.jobs.knownIdsForSource('themuse')
        tasks.push({ ...base, run: call((s) => plain(fetchTheMuse(p, s, { isKnown: (id) => known.has(id) }))) })
        break
      }
      case 'weworkremotely':
        tasks.push({ ...base, run: call((s) => plain(fetchWeWorkRemotely(p, s))) })
        break
    }
  }
  return tasks
}
