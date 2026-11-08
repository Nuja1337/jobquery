import { bucketFor } from '@shared/defaults'
import type {
  ApplicationStatus,
  AtsKind,
  FitAssessment,
  FitBucket,
  Job,
  JobQuery,
  JobStage,
  JobSummary,
  RawJob,
  RemoteType,
  Seniority,
  SourceKind
} from '@shared/types'
import { isJobBoardUrl } from '../../apply/jobBoards'
import { SEARCH_SOURCES, canonicalKey, contentHash, normalizeCompany } from '../../pipeline/dedupe'
import { type Db, type Params, newId, now, parseJson } from '../database'

interface JobRow {
  id: string
  source: SourceKind
  external_id: string
  canonical_key: string
  content_hash: string
  dup_of: string | null
  company: string
  company_norm: string
  company_id: string | null
  title: string
  location: string | null
  remote: RemoteType
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
  employment_type: string | null
  seniority: string
  min_years: number | null
  rescore_pending: number
  url: string
  apply_url: string | null
  ats: AtsKind
  ats_token: string | null
  ats_job_id: string | null
  description: string
  posted_at: string | null
  discovered_at: string
  closed_at: string | null
  stage: JobStage
  filter_reason: string | null
  prescore: number | null
  fit_score: number | null
  fit_bucket: FitBucket | null
  fit_summary: string | null
  fit_json: string | null
  scored_profile_version: number | null
  dismiss_reason: string | null
  dismiss_tags: string
  starred: number
  updated_at: string
  last_seen_at: string | null
  dismissed_at: string | null
  triage_failures: number
  prepare_failures: number
  application_id: string | null
}

const SELECT_JOB = 'SELECT j.*, a.id AS application_id FROM jobs j LEFT JOIN applications a ON a.job_id = j.id'

function toSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    source: row.source,
    company: row.company,
    title: row.title,
    location: row.location,
    remote: row.remote,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryCurrency: row.salary_currency,
    url: row.url,
    ats: row.ats,
    postedAt: row.posted_at,
    discoveredAt: row.discovered_at,
    stage: row.stage,
    filterReason: row.filter_reason,
    prescore: row.prescore,
    fitScore: row.fit_score,
    fitBucket: row.fit_bucket,
    fitSummary: row.fit_summary,
    starred: row.starred === 1,
    applicationId: row.application_id
  }
}

function toJob(row: JobRow): Job {
  return {
    ...toSummary(row),
    externalId: row.external_id,
    applyUrl: row.apply_url,
    atsToken: row.ats_token,
    atsJobId: row.ats_job_id,
    description: row.description,
    employmentType: row.employment_type,
    seniority: parseJson<Seniority[]>(row.seniority, []),
    minYears: row.min_years ?? null,
    fit: parseJson<FitAssessment | null>(row.fit_json, null),
    dismissReason: row.dismiss_reason,
    dismissTags: parseJson<string[]>(row.dismiss_tags, []),
    dupOf: row.dup_of,
    triageFailures: row.triage_failures ?? 0,
    updatedAt: row.updated_at
  }
}

/** Stages where the posting is gone and nothing more should happen to the job. */
const KEEP_OPEN_STAGES: JobStage[] = ['applied', 'closed', 'dismissed', 'duplicate']

/** Stages a fit score may move a job out of. Later stages (preparing, ready, applied, dismissed, closed) keep theirs. */
export const SCORE_MOVABLE_STAGES: JobStage[] = ['new', 'filtered_out', 'prescored_out', 'duplicate', 'scored', 'shortlisted']

/** A job whose AI scoring failed this many times with the current profile is skipped by runs. */
export const MAX_TRIAGE_FAILURES = 3

/** A job whose application failed to prepare this many times is skipped by runs. The Prepare button still works. */
export const MAX_PREPARE_FAILURES = 2

/** A job that no source has listed for this many days is treated as gone. */
export const STALE_JOB_DAYS = 30
/** Sources that come from saved searches. They have no board, so nothing tells us when a posting is removed. */
export { SEARCH_SOURCES }
/** Stages where a search job that went unseen is closed. Later stages belong to the user. */
const STALE_CLOSE_STAGES: JobStage[] = ['new', 'filtered_out', 'prescored_out', 'scored', 'shortlisted']

/**
 * The stage a closed job returns to when its posting comes back. A job without an application
 * starts over at 'new'. One with an application goes back to the stage its application needs, so
 * a ready application is not left behind a shortlisted job.
 */
export function stageForReopened(status: ApplicationStatus | null): JobStage {
  switch (status) {
    case null:
      return 'new'
    case 'draft':
      return 'preparing'
    case 'ready':
    case 'needs_attention':
    case 'submitting':
    case 'failed':
      return 'ready'
    case 'submitted':
      return 'applied'
    case 'withdrawn':
      return 'dismissed'
  }
}

const sqlList = (stages: JobStage[]) => stages.map((s) => `'${s}'`).join(', ')

export interface FreeResult {
  stage: JobStage
  filterReason: string | null
  prescore: number | null
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Inserts a posting or refreshes one already stored, and notes that a source saw it just now.
   * A reappearing closed posting goes back to `new`, or to the stage its application needs.
   * A record without a description comes from a list that has no detail page (SmartRecruiters
   * after the first run). It keeps the stored description, pay, work type and links.
   */
  upsertRaw(raw: RawJob, companyId: string | null): { job: Job; isNew: boolean } {
    const key = canonicalKey(raw)
    const hash = contentHash(raw)
    const existing = this.db.get<{ id: string; stage: JobStage; apply_url: string | null }>('SELECT id, stage, apply_url FROM jobs WHERE canonical_key = :key', { key })
    const at = now()
    if (existing) {
      // A job-board posting resolved to the employer's form (setApplyTarget) keeps that link when the board lists it again.
      const keepResolved = Boolean(existing.apply_url) && !isJobBoardUrl(existing.apply_url!) && (!raw.applyUrl || isJobBoardUrl(raw.applyUrl))
      this.db.run(
        `UPDATE jobs SET title = :title, location = :location, employment_type = :employmentType,
           company = :company, company_norm = :companyNorm,
           remote = CASE WHEN :description = '' AND remote != 'unknown' THEN remote ELSE :remote END,
           salary_min = CASE WHEN :description = '' THEN COALESCE(salary_min, :salaryMin) ELSE :salaryMin END,
           salary_max = CASE WHEN :description = '' THEN COALESCE(salary_max, :salaryMax) ELSE :salaryMax END,
           salary_currency = CASE WHEN :description = '' THEN COALESCE(salary_currency, :salaryCurrency) ELSE :salaryCurrency END,
           url = CASE WHEN :description = '' THEN url ELSE :url END,
           apply_url = CASE WHEN :description = '' OR :keepResolved = 1 THEN COALESCE(apply_url, :applyUrl) ELSE :applyUrl END,
           ats_job_id = CASE WHEN :atsJobId IS NOT NULL AND :ats != 'unknown' AND (ats = 'unknown' OR (ats = :ats AND ats_token IS :atsToken)) THEN :atsJobId ELSE ats_job_id END,
           ats_token = CASE WHEN ats = 'unknown' AND :ats != 'unknown' THEN :atsToken ELSE ats_token END,
           ats = CASE WHEN ats = 'unknown' THEN :ats ELSE ats END,
           seniority = CASE WHEN :seniority = '[]' THEN seniority ELSE :seniority END, min_years = COALESCE(:minYears, min_years),
           description = CASE WHEN :description = '' THEN description ELSE :description END, posted_at = COALESCE(:postedAt, posted_at),
           content_hash = CASE WHEN :description = '' THEN content_hash ELSE :hash END, company_id = COALESCE(:companyId, company_id),
           last_seen_at = :at, updated_at = :at
         WHERE id = :id`,
        { ...rawParams(raw), company: raw.company, companyNorm: normalizeCompany(raw.company), ats: raw.ats, atsToken: raw.atsToken, hash, companyId, at, id: existing.id, keepResolved: keepResolved ? 1 : 0 }
      )
      if (existing.stage === 'closed') {
        const status = this.db.get<{ status: ApplicationStatus }>('SELECT status FROM applications WHERE job_id = :id', { id: existing.id })?.status ?? null
        this.db.run('UPDATE jobs SET stage = :stage, closed_at = NULL, filter_reason = NULL WHERE id = :id', {
          id: existing.id,
          stage: stageForReopened(status)
        })
      }
      return { job: this.get(existing.id)!, isNew: false }
    }
    const id = newId()
    this.db.run(
      `INSERT INTO jobs (id, source, external_id, canonical_key, content_hash, company, company_norm, company_id, title,
         location, remote, salary_min, salary_max, salary_currency, employment_type, seniority, min_years, url, apply_url, ats, ats_token, ats_job_id,
         description, posted_at, discovered_at, last_seen_at, stage, updated_at)
       VALUES (:id, :source, :externalId, :key, :hash, :company, :companyNorm, :companyId, :title, :location, :remote,
         :salaryMin, :salaryMax, :salaryCurrency, :employmentType, :seniority, :minYears, :url, :applyUrl, :ats, :atsToken, :atsJobId, :description,
         :postedAt, :at, :at, 'new', :at)`,
      {
        ...rawParams(raw),
        id,
        key,
        hash,
        source: raw.source,
        externalId: raw.externalId,
        company: raw.company,
        companyNorm: normalizeCompany(raw.company),
        companyId,
        ats: raw.ats,
        atsToken: raw.atsToken,
        at
      }
    )
    return { job: this.get(id)!, isNew: true }
  }

  get(id: string): Job | null {
    const row = this.db.get<JobRow>(`${SELECT_JOB} WHERE j.id = :id`, { id })
    return row ? toJob(row) : null
  }

  list(query: JobQuery): { items: JobSummary[]; total: number } {
    const where: string[] = []
    const params: Record<string, string | number> = {}
    const addIn = (column: string, values: string[] | undefined, prefix: string) => {
      if (!values || values.length === 0) return
      const names = values.map((v, i) => {
        params[`${prefix}${i}`] = v
        return `:${prefix}${i}`
      })
      where.push(`${column} IN (${names.join(', ')})`)
    }
    addIn('j.stage', query.stages, 'stage')
    addIn('j.fit_bucket', query.buckets, 'bucket')
    addIn('j.source', query.sources, 'source')
    if (query.starredOnly) where.push('j.starred = 1')
    const term = query.search?.replace(/[%_\\]/g, ' ').trim().toLowerCase()
    if (term) {
      params.search = `%${term}%`
      where.push('(LOWER(j.title) LIKE :search OR LOWER(j.company) LIKE :search OR LOWER(COALESCE(j.location, \'\')) LIKE :search)')
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const order = {
      score: 'j.fit_score IS NULL, j.fit_score DESC, j.prescore DESC, j.discovered_at DESC',
      newest: 'j.discovered_at DESC',
      posted: 'j.posted_at IS NULL, j.posted_at DESC, j.discovered_at DESC',
      company: 'j.company_norm ASC, j.title ASC'
    }[query.sort ?? 'newest']
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500))
    const offset = Math.max(0, query.offset ?? 0)
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs j ${whereSql}`, params as Params)?.n ?? 0
    const rows = this.db.all<JobRow>(`${SELECT_JOB} ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params as Params)
    return { items: rows.map(toSummary), total }
  }

  /** Full jobs in the given stages. orderBy 'prescore' and 'fit' both sort best first. */
  listByStage(stages: JobStage | JobStage[], options: { orderBy?: 'prescore' | 'fit' | 'discovered'; limit?: number; skipRepeatedTriageFailures?: boolean; skipRepeatedPrepareFailures?: boolean } = {}): Job[] {
    const list = Array.isArray(stages) ? stages : [stages]
    const params: Record<string, string | number> = {}
    const names = list.map((s, i) => {
      params[`s${i}`] = s
      return `:s${i}`
    })
    const order = {
      prescore: 'j.prescore DESC, j.discovered_at DESC',
      fit: 'j.fit_score DESC, j.discovered_at DESC',
      discovered: 'j.discovered_at DESC'
    }[options.orderBy ?? 'discovered']
    const limit = options.limit ? `LIMIT ${Math.floor(options.limit)}` : ''
    let failures = ''
    if (options.skipRepeatedTriageFailures) {
      params.maxFailures = MAX_TRIAGE_FAILURES
      failures = 'AND j.triage_failures < :maxFailures'
    }
    if (options.skipRepeatedPrepareFailures) {
      params.maxPrepareFailures = MAX_PREPARE_FAILURES
      failures += ' AND j.prepare_failures < :maxPrepareFailures'
    }
    return this.db.all<JobRow>(`${SELECT_JOB} WHERE j.stage IN (${names.join(', ')}) ${failures} ORDER BY ${order} ${limit}`, params).map(toJob)
  }

  /**
   * Jobs marked for a one-time rescore (migration 11), best score first. Only shortlisted jobs and jobs with a
   * ready application that was not sent. A mark on a job that has moved on, or whose application was sent
   * or started, is ignored.
   */
  listRescorePending(limit: number): Job[] {
    if (limit <= 0) return []
    return this.db
      .all<JobRow>(
        `${SELECT_JOB} WHERE j.rescore_pending = 1 AND j.triage_failures < :maxFailures AND (
           j.stage = 'shortlisted'
           OR (j.stage = 'ready' AND a.status = 'ready' AND a.submit_clicked_at IS NULL AND a.submit_mode IS NULL AND a.submitted_at IS NULL)
         ) ORDER BY j.fit_score DESC, j.discovered_at DESC LIMIT ${Math.floor(limit)}`,
        { maxFailures: MAX_TRIAGE_FAILURES }
      )
      .map(toJob)
  }

  /** True while the job is marked for the one-time rescore. A scored job with the mark is sent to the model again. */
  needsRescore(id: string): boolean {
    return this.db.get<{ n: number }>('SELECT rescore_pending AS n FROM jobs WHERE id = :id', { id })?.n === 1
  }

  /**
   * The jobs one score step should send to the model, at most `limit`: new jobs best pre-score first, plus jobs
   * marked for rescoring. A quarter of the step is kept for the marked jobs, so they finish in time, and new jobs
   * take every slot they leave free. The step's daily and per-run limits count both kinds.
   */
  listToScore(limit: number): Job[] {
    if (limit <= 0) return []
    const marked = this.listRescorePending(limit)
    const reserved = Math.min(marked.length, Math.floor(limit / 4))
    const room = limit - reserved
    const fresh = room > 0 ? this.listByStage('new', { orderBy: 'prescore', limit: room, skipRepeatedTriageFailures: true }) : []
    return [...fresh, ...marked.slice(0, limit - fresh.length)]
  }

  /** Same posting stored under another job id. The oldest original comes first. */
  findByContentHash(hash: string, excludeId?: string): Job[] {
    return this.db
      .all<JobRow>(`${SELECT_JOB} WHERE j.content_hash = :hash AND j.id != :excludeId ORDER BY (j.dup_of IS NOT NULL), j.discovered_at`, {
        hash,
        excludeId: excludeId ?? ''
      })
      .map(toJob)
  }

  /**
   * Jobs for the same posting on an application system, found through another source or a pasted link.
   * Originals come before duplicates, then the oldest first. Needs ats, token and id to all be known.
   */
  findByAtsJob(ats: AtsKind, atsToken: string, atsJobId: string, excludeId?: string): Job[] {
    if (ats === 'unknown' || !atsToken || !atsJobId) return []
    return this.db
      .all<JobRow>(
        `${SELECT_JOB} WHERE j.ats = :ats AND j.ats_token = :atsToken AND j.ats_job_id = :atsJobId AND j.id != :excludeId
         ORDER BY (j.dup_of IS NOT NULL), j.discovered_at`,
        { ats, atsToken, atsJobId, excludeId: excludeId ?? '' }
      )
      .map(toJob)
  }

  /** Dismissed jobs, newest first. Used to learn what the user doesn't want. */
  listDismissed(): Job[] {
    return this.listByStage('dismissed')
  }

  /** Saves the outcome of the free filters and the keyword pre-score. */
  setFree(id: string, result: FreeResult): void {
    this.db.run('UPDATE jobs SET stage = :stage, filter_reason = :reason, prescore = :prescore, updated_at = :at WHERE id = :id', {
      id,
      stage: result.stage,
      reason: result.filterReason,
      prescore: result.prescore,
      at: now()
    })
  }

  markDuplicate(id: string, dupOf: string): void {
    this.db.run("UPDATE jobs SET stage = 'duplicate', dup_of = :dupOf, updated_at = :at WHERE id = :id", { id, dupOf, at: now() })
  }

  setStage(id: string, stage: JobStage): void {
    this.db.run('UPDATE jobs SET stage = :stage, updated_at = :at WHERE id = :id', { id, stage, at: now() })
  }

  /**
   * Moves a job only if it is still in one of the `from` stages. Background work reads a job,
   * waits on the AI or a browser, then writes. The user may have dismissed it in between.
   */
  moveStage(id: string, stage: JobStage, from: JobStage[]): boolean {
    if (from.length === 0) return false
    this.db.run(`UPDATE jobs SET stage = :stage, updated_at = :at WHERE id = :id AND stage IN (${sqlList(from)})`, { id, stage, at: now() })
    return this.db.get<{ n: number }>('SELECT changes() AS n')?.n === 1
  }

  /**
   * Stores an AI fit assessment. Pass a stage to move the job. The move only happens while the job is
   * still in an early stage, so a score that lands after the user dismissed the job leaves it dismissed.
   */
  saveFit(id: string, fit: FitAssessment, profileVersion: number, stage?: JobStage): void {
    this.db.run(
      `UPDATE jobs SET fit_score = :score, fit_bucket = :bucket, fit_summary = :summary, fit_json = :json,
         scored_profile_version = :version, rescore_pending = 0,
         stage = CASE WHEN :stage IS NOT NULL AND stage IN (${sqlList(SCORE_MOVABLE_STAGES)}) THEN :stage ELSE stage END,
         updated_at = :at WHERE id = :id`,
      {
        id,
        score: fit.score,
        bucket: fit.bucket,
        summary: fit.summary,
        json: JSON.stringify(fit),
        version: profileVersion,
        stage: stage ?? null,
        at: now()
      }
    )
    this.db.run('UPDATE jobs SET triage_failures = 0 WHERE id = :id AND triage_failures != 0', { id })
  }

  /** Clears every job's failed-scoring count, for example after the scoring model or provider changed. */
  resetAllTriageFailures(): void {
    this.db.run('UPDATE jobs SET triage_failures = 0 WHERE triage_failures != 0')
  }

  /** Counts one failed AI scoring attempt. Runs skip the job once it reaches MAX_TRIAGE_FAILURES. */
  recordTriageFailure(id: string): void {
    this.db.run('UPDATE jobs SET triage_failures = triage_failures + 1 WHERE id = :id', { id })
  }

  /** Clears every job's failed-prepare count, for example after the AI provider or its models changed. */
  resetAllPrepareFailures(): void {
    this.db.run('UPDATE jobs SET prepare_failures = 0 WHERE prepare_failures != 0')
  }

  /** Counts one failed attempt to prepare an application. Runs skip the job once it reaches MAX_PREPARE_FAILURES. */
  recordPrepareFailure(id: string): void {
    this.db.run('UPDATE jobs SET prepare_failures = prepare_failures + 1 WHERE id = :id', { id })
  }

  /** Clears the failed-prepare count after an application was prepared. */
  resetPrepareFailures(id: string): void {
    this.db.run('UPDATE jobs SET prepare_failures = 0 WHERE id = :id AND prepare_failures != 0', { id })
  }

  /**
   * Points a job at the page where it really applies, for a posting found on a job board.
   * When another live job already has the same posting on that system, this job becomes its
   * duplicate, so two jobs don't lead to one form. A job that has an application keeps its stage.
   * Returns the id of the job it became a duplicate of, or null.
   */
  setApplyTarget(id: string, target: { applyUrl: string; ats: AtsKind; atsToken: string | null; atsJobId?: string | null }): string | null {
    this.db.run(
      'UPDATE jobs SET apply_url = :applyUrl, ats = :ats, ats_token = :atsToken, ats_job_id = :atsJobId, updated_at = :at WHERE id = :id',
      { id, applyUrl: target.applyUrl, ats: target.ats, atsToken: target.atsToken, atsJobId: target.atsJobId ?? null, at: now() }
    )
    if (!target.atsToken || !target.atsJobId) return null
    const mine = this.db.get<{ stage: JobStage; has_application: number }>(
      'SELECT stage, EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id) AS has_application FROM jobs WHERE id = :id',
      { id }
    )
    if (!mine || mine.has_application || ['applied', 'dismissed', 'duplicate', 'closed'].includes(mine.stage)) return null
    const original = this.findByAtsJob(target.ats, target.atsToken, target.atsJobId, id).find((j) => !j.dupOf && j.stage !== 'closed' && j.stage !== 'duplicate')
    if (!original) return null
    this.markDuplicate(id, original.id)
    return original.id
  }

  /** Profile version the stored fit was computed against, or null when the job was never scored. */
  scoredProfileVersion(id: string): number | null {
    return this.db.get<{ v: number | null }>('SELECT scored_profile_version AS v FROM jobs WHERE id = :id', { id })?.v ?? null
  }

  dismiss(id: string, reason: string | null, tags: string[]): void {
    this.db.run(
      "UPDATE jobs SET stage = 'dismissed', dismiss_reason = :reason, dismiss_tags = :tags, dismissed_at = :at, updated_at = :at WHERE id = :id AND stage != 'applied'",
      { id, reason, tags: JSON.stringify(tags), at: now() }
    )
  }

  /** Undoes a dismissal. Jobs with a score go back to shortlisted or scored, the rest back to new. */
  restore(id: string, shortlistScore: number): void {
    const row = this.db.get<{ fit_score: number | null; stage: JobStage }>('SELECT fit_score, stage FROM jobs WHERE id = :id', { id })
    if (!row || ['applied', 'preparing', 'ready'].includes(row.stage)) return
    const stage: JobStage = row.fit_score === null ? 'new' : row.fit_score >= shortlistScore ? 'shortlisted' : 'scored'
    this.db.run(
      "UPDATE jobs SET stage = :stage, dismiss_reason = NULL, dismiss_tags = '[]', dismissed_at = NULL, filter_reason = NULL, updated_at = :at WHERE id = :id",
      { id, stage, at: now() }
    )
  }

  star(id: string, starred: boolean): void {
    this.db.run('UPDATE jobs SET starred = :starred WHERE id = :id', { id, starred })
  }

  /**
   * After a good read of a company's board, jobs it no longer lists become `closed`.
   * Applied, dismissed and duplicate jobs are left alone. An empty list changes nothing,
   * because an empty answer more often means a broken response than a board with no jobs.
   */
  markClosedMissing(source: SourceKind, atsToken: string, seenExternalIds: string[]): string[] {
    if (seenExternalIds.length === 0) return []
    const seen = new Set(seenExternalIds)
    const rows = this.db.all<{ id: string; external_id: string; stage: JobStage }>(
      'SELECT id, external_id, stage FROM jobs WHERE source = :source AND ats_token = :token',
      { source, token: atsToken }
    )
    const closed: string[] = []
    this.db.transaction(() => {
      for (const row of rows) {
        if (seen.has(row.external_id) || KEEP_OPEN_STAGES.includes(row.stage)) continue
        this.db.run("UPDATE jobs SET stage = 'closed', closed_at = :at, updated_at = :at WHERE id = :id", { id: row.id, at: now() })
        closed.push(row.id)
      }
    })
    return closed
  }

  /**
   * Notes that a board's postings were seen just now, without reading them again. With no ids, every
   * posting of the board counts. Closed postings are not reopened, since only a read of the posting can say it is back.
   */
  touchSeen(source: SourceKind, atsToken: string, externalIds?: string[]): void {
    const at = now()
    if (!externalIds) {
      this.db.run("UPDATE jobs SET last_seen_at = :at WHERE source = :source AND ats_token = :token AND stage != 'closed'", { at, source, token: atsToken })
      return
    }
    this.db.transaction(() => {
      for (let i = 0; i < externalIds.length; i += 300) {
        const chunk = externalIds.slice(i, i + 300)
        const names = chunk.map((_, k) => `:id${k}`)
        const params: Record<string, string> = { at, source, token: atsToken }
        chunk.forEach((id, k) => (params[`id${k}`] = id))
        this.db.run(
          `UPDATE jobs SET last_seen_at = :at WHERE source = :source AND ats_token = :token AND stage != 'closed' AND external_id IN (${names.join(', ')})`,
          params
        )
      }
    })
  }

  /**
   * External ids already stored for a board with a description, so a source can skip fetching details
   * for them. A stored posting that has no description yet is not known, so its detail is fetched again.
   */
  /** External ids stored for a job site, so a search can skip the detail pages of postings it already has. */
  knownIdsForSource(source: SourceKind): Set<string> {
    const rows = this.db.all<{ external_id: string }>("SELECT external_id FROM jobs WHERE source = :source AND description != ''", { source })
    return new Set(rows.map((r) => r.external_id))
  }

  knownExternalIds(source: SourceKind, atsToken: string): Set<string> {
    const rows = this.db.all<{ external_id: string }>(
      "SELECT external_id FROM jobs WHERE source = :source AND ats_token = :token AND description != ''",
      { source, token: atsToken }
    )
    return new Set(rows.map((r) => r.external_id))
  }

  /**
   * Closes jobs from the given search sources that no search has returned for `days` days.
   * Only early stages are touched. A job the user is working on stays open.
   *
   * A source runs one saved search per run, so a job may simply belong to a search that has not run
   * lately (the app was off for weeks, or the search was paused). A job closes only when every enabled
   * search of its source has run since the job was last seen. A search that never ran blocks it.
   */
  closeUnseenSearchJobs(sources: SourceKind[], days = STALE_JOB_DAYS): string[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    const closed: string[] = []
    for (const source of sources) {
      const runs = this.db.all<{ last_run_at: string | null }>('SELECT last_run_at FROM searches WHERE source = :source AND enabled = 1', { source })
      if (runs.some((r) => !r.last_run_at)) continue
      const oldestRun = runs.reduce<string | null>((oldest, r) => (oldest === null || r.last_run_at! < oldest ? r.last_run_at : oldest), null)
      // The job must have been last seen before the 30-day line and before the oldest search ran.
      const rows = this.db.all<{ id: string }>(
        `SELECT id FROM jobs WHERE source = :source AND stage IN (${sqlList(STALE_CLOSE_STAGES)})
           AND COALESCE(last_seen_at, discovered_at) < :cutoff
           AND (:oldestRun IS NULL OR COALESCE(last_seen_at, discovered_at) < :oldestRun)`,
        { source, cutoff, oldestRun }
      )
      closed.push(...rows.map((r) => r.id))
    }
    if (closed.length === 0) return []
    const at = now()
    this.db.transaction(() => {
      for (const id of closed) this.db.run("UPDATE jobs SET stage = 'closed', closed_at = :at, updated_at = :at WHERE id = :id", { id, at })
    })
    return closed
  }

  /** True when no source has listed the job for more than `days` days. */
  isUnseen(id: string, days = STALE_JOB_DAYS): boolean {
    const row = this.db.get<{ seen: string | null }>('SELECT COALESCE(last_seen_at, discovered_at) AS seen FROM jobs WHERE id = :id', { id })
    if (!row?.seen) return false
    return Date.parse(row.seen) < Date.now() - days * 86_400_000
  }

  /** Jobs filtered out because the user applied to the company recently. Their reason can expire. */
  listCooldownFiltered(): Job[] {
    return this.db
      .all<JobRow>(`${SELECT_JOB} WHERE j.stage = 'filtered_out' AND j.filter_reason LIKE 'applied to this company%'`)
      .map(toJob)
  }

  /**
   * Hands a closed posting over to the live row that replaces it. Copies the score onto the new
   * row, so it needs no new AI call, and points the closed originals and anything that was a
   * duplicate of them at the new row.
   */
  adoptClosedOriginals(newId: string, closedIds: string[]): void {
    if (closedIds.length === 0) return
    const withFit = closedIds
      .map((id) => this.db.get<{ id: string; fit_score: number | null }>('SELECT id, fit_score FROM jobs WHERE id = :id', { id }))
      .find((row) => row?.fit_score !== null && row?.fit_score !== undefined)
    const at = now()
    this.db.transaction(() => {
      if (withFit) {
        this.db.run(
          `UPDATE jobs SET
             fit_score = (SELECT fit_score FROM jobs WHERE id = :from), fit_bucket = (SELECT fit_bucket FROM jobs WHERE id = :from),
             fit_summary = (SELECT fit_summary FROM jobs WHERE id = :from), fit_json = (SELECT fit_json FROM jobs WHERE id = :from),
             scored_profile_version = (SELECT scored_profile_version FROM jobs WHERE id = :from), updated_at = :at
           WHERE id = :id AND fit_score IS NULL`,
          { id: newId, from: withFit.id, at }
        )
      }
      for (const id of closedIds) {
        this.db.run('UPDATE jobs SET dup_of = :newId WHERE dup_of = :id AND id != :newId', { id, newId })
        this.db.run('UPDATE jobs SET dup_of = :newId WHERE id = :id', { id, newId })
      }
    })
  }

  /**
   * Duplicates whose original has just closed. The first one becomes the live job and takes over the
   * original's score, and the rest follow it. Returns the ids that changed.
   */
  reviveDuplicatesOfClosed(closedIds: string[]): string[] {
    const changed: string[] = []
    for (const closedId of closedIds) {
      const copies = this.db.all<{ id: string }>(
        // Only a repost on the same board under a new id. A copy of the same posting (an older row
        // for it) or one from a job site that aggregated it would lead to the same closed page.
        `SELECT c.id FROM jobs c JOIN jobs o ON o.id = :id
         WHERE c.dup_of = :id AND c.stage = 'duplicate' AND c.source = o.source AND c.external_id != o.external_id
         ORDER BY c.discovered_at, c.id`,
        { id: closedId }
      )
      if (copies.length === 0) continue
      const [live, ...rest] = copies
      this.db.transaction(() => {
        this.db.run("UPDATE jobs SET stage = 'new', dup_of = NULL, filter_reason = NULL, updated_at = :at WHERE id = :id", { id: live.id, at: now() })
        for (const other of rest) this.db.run('UPDATE jobs SET dup_of = :live WHERE id = :id', { id: other.id, live: live.id })
        this.adoptClosedOriginals(live.id, [closedId])
      })
      changed.push(live.id, ...rest.map((r) => r.id))
    }
    return changed
  }

  /**
   * Puts scored jobs on the right side of the shortlist line and refreshes their stored bucket.
   * Only jobs in `scored` or `shortlisted` move. Returns the ids that changed.
   */
  restageForShortlistScore(shortlistScore: number): string[] {
    const rows = this.db.all<{ id: string; stage: JobStage; fit_score: number; fit_bucket: FitBucket | null; fit_json: string | null }>(
      "SELECT id, stage, fit_score, fit_bucket, fit_json FROM jobs WHERE stage IN ('scored', 'shortlisted') AND fit_score IS NOT NULL"
    )
    const changed: string[] = []
    const at = now()
    this.db.transaction(() => {
      for (const row of rows) {
        const stage: JobStage = row.fit_score >= shortlistScore ? 'shortlisted' : 'scored'
        const bucket = bucketFor(row.fit_score, shortlistScore)
        if (stage === row.stage && bucket === row.fit_bucket) continue
        const fit = parseJson<FitAssessment | null>(row.fit_json, null)
        const json = fit ? JSON.stringify({ ...fit, bucket }) : row.fit_json
        this.db.run(
          `UPDATE jobs SET stage = :stage, fit_bucket = :bucket, fit_json = :json, updated_at = :at
           WHERE id = :id AND stage IN ('scored', 'shortlisted')`,
          { id: row.id, stage, bucket, json, at }
        )
        changed.push(row.id)
      }
    })
    return changed
  }

  countByStage(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const row of this.db.all<{ stage: string; n: number }>('SELECT stage, COUNT(*) AS n FROM jobs GROUP BY stage')) out[row.stage] = row.n
    return out
  }
}

function rawParams(raw: RawJob) {
  return {
    title: raw.title,
    location: raw.location,
    remote: raw.remote,
    salaryMin: raw.salaryMin,
    salaryMax: raw.salaryMax,
    salaryCurrency: raw.salaryCurrency,
    employmentType: raw.employmentType,
    seniority: JSON.stringify(raw.seniority ?? []),
    minYears: raw.minYears ?? null,
    url: raw.url,
    applyUrl: raw.applyUrl,
    description: raw.description,
    postedAt: raw.postedAt,
    atsJobId: raw.atsJobId ?? null
  }
}
