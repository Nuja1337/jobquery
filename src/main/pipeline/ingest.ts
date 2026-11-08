import { createHash } from 'node:crypto'
import type { AtsKind, Job, JobPreferences, JobStage, Profile, RawJob, Thresholds } from '@shared/types'
import type { AppContext } from '../context'
import type { Db } from '../db/database'
import type { FreeResult } from '../db/repos/jobs'
import { canReadBoard } from '../sources'
import { READABLE_ATS, detectAts, prettifyToken } from '../sources/detect'
import { SEARCH_SOURCES, contentHash, normalizeCompany, normalizeLocation } from './dedupe'
import { type FilterContext, applyFilters } from './filters'
import { prescore } from './prescore'

const RESTAGE_KEY = 'shortlist_score_applied'

export function getMeta(db: Db, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { key })?.value ?? null
}

export function setMeta(db: Db, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (:key, :value)', { key, value })
}

// ---------------------------------------------------------------------------
// Free evaluation: filters and keyword pre-score
// ---------------------------------------------------------------------------

/** Settings and profile as they stand when a batch starts. Built once per batch. */
export interface FreeEnv {
  prefs: JobPreferences
  thresholds: Thresholds
  profile: Profile
  profileVersion: number
  filterContext: FilterContext
}

export function buildFreeEnv(ctx: AppContext, now = Date.now()): FreeEnv {
  const { preferences, thresholds } = ctx.settings.get()
  const { profile, version } = ctx.profile.get()
  const blocked = new Set([...ctx.companies.blockedNames(), ...preferences.excludedCompanies.map(normalizeCompany)])
  return {
    prefs: preferences,
    thresholds,
    profile,
    profileVersion: version,
    filterContext: {
      now,
      blockedCompanies: blocked,
      lastAppliedAt: (norm) => ctx.applications.lastSentAt(norm),
      appliedCount: (norm, sinceMs) => ctx.applications.countSentToCompanySince(norm, new Date(sinceMs).toISOString()),
      authorization: profile.application?.authorization,
      relocation: profile.application?.relocation
    }
  }
}

/** Changes whenever a setting or profile edit could change what the free rules decide. */
export function freeFingerprint(env: FreeEnv): string {
  return createHash('sha1')
    .update(JSON.stringify({ p: env.prefs, t: env.thresholds.prescoreMin, v: env.profileVersion, b: [...env.filterContext.blockedCompanies].sort(), a: env.filterContext.authorization ?? [], r: env.filterContext.relocation ?? null }))
    .digest('hex')
}

/** What the free rules decide for a job, without saving anything. */
export function decideFree(job: Job, env: FreeEnv): FreeResult {
  const result = applyFilters(job, env.prefs, env.filterContext)
  if (!result.pass) return { stage: 'filtered_out', filterReason: result.reason, prescore: null }
  const score = prescore(job, env.profile, env.prefs)
  if (score < env.thresholds.prescoreMin) {
    return { stage: 'prescored_out', filterReason: `keyword match too low (${score})`, prescore: score }
  }
  return { stage: 'new', filterReason: null, prescore: score }
}

/**
 * Runs the free rules and saves the result. A job that passes but already has a score for the
 * current profile (for example a posting that came back after it closed) goes straight to its
 * shortlisted or scored stage, with no new AI call.
 */
export function applyFree(ctx: AppContext, job: Job, env: FreeEnv): JobStage {
  const decision = decideFree(job, env)
  if (decision.stage === 'new' && job.fit && ctx.jobs.scoredProfileVersion(job.id) === env.profileVersion) {
    decision.stage = job.fit.score >= env.thresholds.shortlistScore ? 'shortlisted' : 'scored'
  }
  const unchanged = decision.stage === job.stage && decision.filterReason === job.filterReason && decision.prescore === job.prescore
  if (!unchanged) ctx.jobs.setFree(job.id, decision)
  return decision.stage
}

// ---------------------------------------------------------------------------
// Ingest: store a posting and catch duplicates
// ---------------------------------------------------------------------------

export interface IngestResult {
  job: Job
  isNew: boolean
  /** True when this posting was marked a duplicate of another job just now. */
  duplicate: boolean
  /** Set when this posting led to a company board being watched. The company's name. */
  startedWatching?: string
}

const LINK = /https?:\/\/[^\s<>"'\][(){}]+/gi

/**
 * The first readable company board that a posting's text links to. A link that a site cut short with
 * "..." loses its last path segment, since the board name is the first one and may be cut too.
 */
export function boardLinkIn(text: string): { ats: AtsKind; token: string } | null {
  for (const match of text.matchAll(LINK)) {
    const cut = /(\.\.\.|…)$/.test(match[0])
    let link = match[0].replace(/(\.\.\.|…)$/, '').replace(/[.,;:!?]+$/, '')
    if (cut) link = link.slice(0, link.lastIndexOf('/'))
    const found = detectAts(link)
    if (found?.token && READABLE_ATS.includes(found.ats) && canReadBoard(found.ats)) return { ats: found.ats, token: found.token }
  }
  return null
}

/**
 * Starts watching a company board that a posting led us to. Nothing happens when the setting is off,
 * the company is blocked, the cap is reached, or the user already decided about this company (it is
 * watched, or it was watched once and turned off, or the board failed too often). Returns the company's
 * name when watching started.
 */
export function autoWatchBoard(ctx: AppContext, found: { ats: AtsKind; token: string; company?: string | null }): string | null {
  const { discovery, preferences } = ctx.settings.get()
  if (!discovery.autoWatchBoards) return null
  if (!READABLE_ATS.includes(found.ats) || !canReadBoard(found.ats)) return null
  const existing = ctx.companies.findByAts(found.ats, found.token)
  if (existing) {
    if (existing.watch || existing.blocked) return null
    // A company with a board state was watched before. Turning it back on is the user's call.
    if (ctx.boards.get(existing.id)) return null
  }
  const name = found.company?.trim() || existing?.name || prettifyToken(found.token)
  const normalized = normalizeCompany(name)
  const blockedByName = ctx.companies.findByName(name)?.blocked ?? false
  if (blockedByName || preferences.excludedCompanies.some((c) => normalizeCompany(c) === normalized)) return null
  if (ctx.companies.countWatched() >= discovery.maxWatchedBoards) return null
  const company = existing
    ? ctx.companies.save({ id: existing.id, watch: true, origin: 'posting_link' })
    : ctx.companies.save({ name, ats: found.ats, atsToken: found.token, watch: true, origin: 'posting_link' })
  ctx.boards.ensureState(company.id, 'posting_link')
  return company.name
}

/** The one note per run about boards that postings led us to. */
export function noteStartedWatching(ctx: AppContext, count: number): void {
  if (count <= 0) return
  ctx.events.add('discovered', `Started watching ${count} new company ${count === 1 ? 'board' : 'boards'} found in postings.`)
}

/**
 * Stores a posting. Postings from a known ATS board use the stored company's name so the same job
 * found through a watched board and through a pasted link gets the same key.
 * A new posting that has the same id on the same application system as another job (the same
 * posting found through a board and through a job site) becomes a duplicate of it. After that, one with
 * the same content hash becomes a duplicate too, unless the other job is from the same source and
 * lists a different place (one role, several offices).
 * When every match is closed, the posting was reposted under a new id. The new row stays live and
 * takes over the score of the closed one, so it needs no new AI call.
 */
export function ingestRaw(ctx: AppContext, input: RawJob): IngestResult {
  const result = storeRaw(ctx, input)
  // A posting from a job site names the employer's board in its apply link, or in its text.
  const fromSite = SEARCH_SOURCES.includes(input.source)
  let board: { ats: AtsKind; token: string } | null = null
  if (input.atsToken && READABLE_ATS.includes(input.ats)) board = { ats: input.ats, token: input.atsToken }
  else if (fromSite) board = boardLinkIn(input.description)
  if (!board) return result
  const startedWatching = autoWatchBoard(ctx, { ...board, company: fromSite ? input.company : result.job.company })
  return startedWatching ? { ...result, startedWatching } : result
}

function storeRaw(ctx: AppContext, input: RawJob): IngestResult {
  const raw = { ...input }
  let companyId: string | null = null
  // A job site's ats fields describe the employer's board. They don't make the site's company a board company.
  if (raw.ats !== 'unknown' && raw.atsToken && !SEARCH_SOURCES.includes(raw.source)) {
    const company = ctx.companies.ensureForAts(raw.company, raw.ats, raw.atsToken)
    companyId = company.id
    raw.company = company.name
  } else {
    companyId = ctx.companies.findByName(raw.company)?.id ?? null
  }
  const { job, isNew } = ctx.jobs.upsertRaw(raw, companyId)
  if (!isNew) return { job, isNew, duplicate: false }

  const mine = normalizeLocation(raw.location)
  const originals = new Map<string, Job>()
  // The same posting id on the same application system is the same posting, whatever the text says.
  if (raw.ats !== 'unknown' && raw.atsToken && raw.atsJobId) {
    for (const other of ctx.jobs.findByAtsJob(raw.ats, raw.atsToken, raw.atsJobId, job.id)) {
      const root = rootOf(ctx, other)
      if (root && root.id !== job.id) originals.set(root.id, root)
    }
    const live = [...originals.values()].find((other) => other.stage !== 'closed')
    if (live && boardReplacesSiteCopy(raw, live)) {
      // The board's own row becomes the original. It takes the site copy's score and the site copy's
      // other duplicates, so the board read can close it when the posting comes down.
      ctx.jobs.markDuplicate(live.id, job.id)
      ctx.jobs.adoptClosedOriginals(job.id, [live.id])
      return { job: ctx.jobs.get(job.id)!, isNew, duplicate: false }
    }
    if (live) {
      ctx.jobs.markDuplicate(job.id, live.id)
      return { job: ctx.jobs.get(job.id)!, isNew, duplicate: true }
    }
  }
  for (const other of ctx.jobs.findByContentHash(contentHash(raw), job.id)) {
    if (other.source === raw.source) {
      const theirs = normalizeLocation(other.location)
      if (mine && theirs && mine !== theirs) continue
    }
    const root = rootOf(ctx, other)
    if (root && root.id !== job.id) originals.set(root.id, root)
  }
  if (originals.size === 0) return { job, isNew, duplicate: false }
  const live = [...originals.values()].find((other) => other.stage !== 'closed')
  if (live) {
    ctx.jobs.markDuplicate(job.id, live.id)
    return { job: ctx.jobs.get(job.id)!, isNew, duplicate: true }
  }
  ctx.jobs.adoptClosedOriginals(job.id, [...originals.keys()])
  return { job: ctx.jobs.get(job.id)!, isNew, duplicate: false }
}

/** Stages where nobody has acted on a job yet, so another row may take its place as the original. */
const UNATTENDED_STAGES: JobStage[] = ['new', 'filtered_out', 'prescored_out', 'scored', 'shortlisted']

/**
 * True when a posting read from its own company board should become the original over a live copy
 * that a job site found first. The board is read in full and tells when a posting comes down;
 * `markClosedMissing` skips duplicates, so a job-site copy that stayed the original would stay open
 * for up to 30 days after the board dropped the posting.
 *
 * The site copy stays the original when the user acted on it: it has an application (the
 * application points at that row and the unique link to it is not moved), or it was dismissed,
 * preparing, ready or applied. Swapping would show the user's posting again as a new job.
 */
function boardReplacesSiteCopy(raw: RawJob, live: Job): boolean {
  if (raw.source !== raw.ats || !SEARCH_SOURCES.includes(live.source)) return false
  return UNATTENDED_STAGES.includes(live.stage) && !live.applicationId
}

/** The job a duplicate points back to, or the job itself when it is an original. */
function rootOf(ctx: AppContext, job: Job): Job | null {
  let current: Job | null = job
  for (let hops = 0; current?.dupOf && hops < 3; hops++) current = ctx.jobs.get(current.dupOf)
  return current
}

/**
 * Run after jobs were closed. A posting reposted under a new id is ingested before the old one is
 * seen to be gone, so it was stored as a duplicate of a job that is now closed. The copy becomes
 * the live job. Returns the ids that changed.
 */
export function reviveDuplicatesOfClosed(ctx: AppContext, closedIds: string[]): string[] {
  return ctx.jobs.reviveDuplicatesOfClosed(closedIds)
}

/**
 * Puts scored jobs on the right side of the shortlist line and refreshes their stored fit bucket.
 * Call it when the shortlist score changes. Only jobs in scored or shortlisted move.
 * Returns the ids that changed and tells the UI.
 */
export function restageForShortlist(ctx: AppContext): string[] {
  const line = ctx.settings.get().thresholds.shortlistScore
  const changed = ctx.jobs.restageForShortlistScore(line)
  setMeta(ctx.db, RESTAGE_KEY, String(line))
  if (changed.length) ctx.emit('jobs:changed', { jobIds: changed })
  return changed
}

/** True when the shortlist score is not the one the stored stages and buckets were last set for. */
export function shortlistNeedsRestage(ctx: AppContext): boolean {
  return getMeta(ctx.db, RESTAGE_KEY) !== String(ctx.settings.get().thresholds.shortlistScore)
}

/**
 * For a link the user pasted. Stores the posting, drops duplicates and runs the free filters and
 * pre-score. No AI call. A posting already stored comes back unchanged.
 */
export function ingestJob(ctx: AppContext, raw: RawJob): Job {
  const result = ingestRaw(ctx, raw)
  let job = result.job
  if (job.stage === 'new' && (result.isNew || job.prescore === null)) {
    applyFree(ctx, job, buildFreeEnv(ctx))
    job = ctx.jobs.get(job.id)!
  }
  if (result.isNew) {
    ctx.events.add('discovered', `Added ${job.title} at ${job.company} from a link.`, job.id)
    ctx.emit('jobs:changed', { jobIds: [job.id] })
  }
  return job
}
