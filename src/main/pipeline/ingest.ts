import { createHash } from 'node:crypto'
import type { Job, JobPreferences, JobStage, Profile, RawJob, Thresholds } from '@shared/types'
import type { AppContext } from '../context'
import type { Db } from '../db/database'
import type { FreeResult } from '../db/repos/jobs'
import { contentHash, normalizeCompany, normalizeLocation } from './dedupe'
import { type FilterContext, applyFilters } from './filters'
import { prescore } from './prescore'

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
    filterContext: { now, blockedCompanies: blocked, lastAppliedAt: (norm) => ctx.applications.lastSubmittedAt(norm) }
  }
}

/** Changes whenever a setting or profile edit could change what the free rules decide. */
export function freeFingerprint(env: FreeEnv): string {
  return createHash('sha1')
    .update(JSON.stringify({ p: env.prefs, t: env.thresholds.prescoreMin, v: env.profileVersion, b: [...env.filterContext.blockedCompanies].sort() }))
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
}

/**
 * Stores a posting. Postings from a known ATS board use the stored company's name so the same job
 * found through a watched board and through a pasted link gets the same key.
 * A new posting with the same content hash as another job becomes a duplicate of it, unless the
 * other job is from the same source and lists a different place (one role, several offices).
 */
export function ingestRaw(ctx: AppContext, input: RawJob): IngestResult {
  const raw = { ...input }
  let companyId: string | null = null
  if (raw.ats !== 'unknown' && raw.atsToken) {
    const company = ctx.companies.ensureForAts(raw.company, raw.ats, raw.atsToken)
    companyId = company.id
    raw.company = company.name
  } else {
    companyId = ctx.companies.findByName(raw.company)?.id ?? null
  }
  const { job, isNew } = ctx.jobs.upsertRaw(raw, companyId)
  if (!isNew) return { job, isNew, duplicate: false }

  const mine = normalizeLocation(raw.location)
  const original = ctx.jobs.findByContentHash(contentHash(raw), job.id).find((other) => {
    if (other.source !== raw.source) return true
    const theirs = normalizeLocation(other.location)
    return !mine || !theirs || mine === theirs
  })
  if (!original) return { job, isNew, duplicate: false }
  ctx.jobs.markDuplicate(job.id, original.dupOf ?? original.id)
  return { job: ctx.jobs.get(job.id)!, isNew, duplicate: true }
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
