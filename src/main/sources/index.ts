import type { AtsKind, RawJob, SourceKind } from '@shared/types'
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
  run(signal?: AbortSignal): Promise<{ jobs: RawJob[]; complete?: boolean }>
}

export type TaskProvider = (ctx: AppContext) => DiscoveryTask[]

async function plain(jobs: Promise<RawJob[]>) {
  return { jobs: await jobs }
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
  for (const search of ctx.searches.listEnabled()) {
    const label = search.label || search.source
    const p = search.params
    const base = { name: label, searchId: search.id }
    switch (search.source) {
      case 'remotive':
        tasks.push({ ...base, run: (s) => plain(fetchRemotive(p, s)) })
        break
      case 'remoteok':
        tasks.push({ ...base, run: (s) => plain(fetchRemoteOk(p, s)) })
        break
      case 'arbeitnow':
        tasks.push({ ...base, run: (s) => plain(fetchArbeitnow(p, s)) })
        break
      case 'hn_whoishiring':
        tasks.push({ ...base, run: (s) => plain(fetchHnWhoIsHiring(p, s)) })
        break
      case 'adzuna':
        tasks.push({ ...base, run: (s) => plain(fetchAdzuna(p, s)) })
        break
    }
  }
  return tasks
}
