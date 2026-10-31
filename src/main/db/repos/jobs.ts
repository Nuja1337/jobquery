import type {
  AtsKind,
  FitAssessment,
  FitBucket,
  Job,
  JobQuery,
  JobStage,
  JobSummary,
  RawJob,
  RemoteType,
  SourceKind
} from '@shared/types'
import { canonicalKey, contentHash, normalizeCompany } from '../../pipeline/dedupe'
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
  url: string
  apply_url: string | null
  ats: AtsKind
  ats_token: string | null
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
    description: row.description,
    employmentType: row.employment_type,
    fit: parseJson<FitAssessment | null>(row.fit_json, null),
    dismissReason: row.dismiss_reason,
    dismissTags: parseJson<string[]>(row.dismiss_tags, []),
    dupOf: row.dup_of,
    updatedAt: row.updated_at
  }
}

/** Stages where the posting is gone and nothing more should happen to the job. */
const KEEP_OPEN_STAGES: JobStage[] = ['applied', 'closed', 'dismissed', 'duplicate']

export interface FreeResult {
  stage: JobStage
  filterReason: string | null
  prescore: number | null
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  /** Inserts a posting or refreshes one already stored. A reappearing closed posting goes back to `new`. */
  upsertRaw(raw: RawJob, companyId: string | null): { job: Job; isNew: boolean } {
    const key = canonicalKey(raw)
    const hash = contentHash(raw)
    const existing = this.db.get<{ id: string; stage: JobStage }>('SELECT id, stage FROM jobs WHERE canonical_key = :key', { key })
    const at = now()
    if (existing) {
      this.db.run(
        `UPDATE jobs SET title = :title, location = :location, remote = :remote, salary_min = :salaryMin,
           salary_max = :salaryMax, salary_currency = :salaryCurrency, employment_type = :employmentType,
           url = :url, apply_url = :applyUrl, description = CASE WHEN :description = '' THEN description ELSE :description END, posted_at = COALESCE(:postedAt, posted_at),
           content_hash = CASE WHEN :description = '' THEN content_hash ELSE :hash END, company_id = COALESCE(:companyId, company_id), updated_at = :at
         WHERE id = :id`,
        { ...rawParams(raw), hash, companyId, at, id: existing.id }
      )
      if (existing.stage === 'closed') {
        this.db.run("UPDATE jobs SET stage = 'new', closed_at = NULL, filter_reason = NULL WHERE id = :id", { id: existing.id })
      }
      return { job: this.get(existing.id)!, isNew: false }
    }
    const id = newId()
    this.db.run(
      `INSERT INTO jobs (id, source, external_id, canonical_key, content_hash, company, company_norm, company_id, title,
         location, remote, salary_min, salary_max, salary_currency, employment_type, url, apply_url, ats, ats_token,
         description, posted_at, discovered_at, stage, updated_at)
       VALUES (:id, :source, :externalId, :key, :hash, :company, :companyNorm, :companyId, :title, :location, :remote,
         :salaryMin, :salaryMax, :salaryCurrency, :employmentType, :url, :applyUrl, :ats, :atsToken, :description,
         :postedAt, :at, 'new', :at)`,
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
  listByStage(stages: JobStage | JobStage[], options: { orderBy?: 'prescore' | 'fit' | 'discovered'; limit?: number } = {}): Job[] {
    const list = Array.isArray(stages) ? stages : [stages]
    const params: Record<string, string> = {}
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
    return this.db.all<JobRow>(`${SELECT_JOB} WHERE j.stage IN (${names.join(', ')}) ORDER BY ${order} ${limit}`, params).map(toJob)
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

  /** Stores an AI fit assessment. Pass a stage to move the job, or leave it out to keep the current stage. */
  saveFit(id: string, fit: FitAssessment, profileVersion: number, stage?: JobStage): void {
    this.db.run(
      `UPDATE jobs SET fit_score = :score, fit_bucket = :bucket, fit_summary = :summary, fit_json = :json,
         scored_profile_version = :version, stage = COALESCE(:stage, stage), updated_at = :at WHERE id = :id`,
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
  }

  /** Profile version the stored fit was computed against, or null when the job was never scored. */
  scoredProfileVersion(id: string): number | null {
    return this.db.get<{ v: number | null }>('SELECT scored_profile_version AS v FROM jobs WHERE id = :id', { id })?.v ?? null
  }

  dismiss(id: string, reason: string | null, tags: string[]): void {
    this.db.run(
      "UPDATE jobs SET stage = 'dismissed', dismiss_reason = :reason, dismiss_tags = :tags, updated_at = :at WHERE id = :id AND stage != 'applied'",
      { id, reason, tags: JSON.stringify(tags), at: now() }
    )
  }

  /** Undoes a dismissal. Jobs with a score go back to shortlisted or scored, the rest back to new. */
  restore(id: string, shortlistScore: number): void {
    const row = this.db.get<{ fit_score: number | null; stage: JobStage }>('SELECT fit_score, stage FROM jobs WHERE id = :id', { id })
    if (!row || ['applied', 'preparing', 'ready'].includes(row.stage)) return
    const stage: JobStage = row.fit_score === null ? 'new' : row.fit_score >= shortlistScore ? 'shortlisted' : 'scored'
    this.db.run(
      "UPDATE jobs SET stage = :stage, dismiss_reason = NULL, dismiss_tags = '[]', filter_reason = NULL, updated_at = :at WHERE id = :id",
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

  /** External ids already stored for a board, so a source can skip fetching details for them. */
  knownExternalIds(source: SourceKind, atsToken: string): Set<string> {
    const rows = this.db.all<{ external_id: string }>('SELECT external_id FROM jobs WHERE source = :source AND ats_token = :token', { source, token: atsToken })
    return new Set(rows.map((r) => r.external_id))
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
    url: raw.url,
    applyUrl: raw.applyUrl,
    description: raw.description,
    postedAt: raw.postedAt
  }
}
