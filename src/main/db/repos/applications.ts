import { answerNeedsUser, isGuess } from '@shared/answers'
import type {
  Application,
  ApplicationOutcome,
  ApplicationPatch,
  ApplicationQuery,
  ApplicationStatus,
  ApplicationSummary,
  FitBucket,
  FormField,
  JobStage,
  LintReport,
  PreparedAnswer,
  SubmitMode
} from '@shared/types'
import { type Db, type Params, newId, now, parseJson } from '../database'

interface ApplicationRow {
  id: string
  job_id: string
  status: ApplicationStatus
  outcome: ApplicationOutcome
  outcome_at: string | null
  cover_letter: string | null
  cover_letter_lint: string | null
  answers: string
  form_fields: string
  resume_doc_id: string | null
  submit_mode: SubmitMode | null
  submitted_at: string | null
  submit_clicked_at: string | null
  confirmation: string | null
  screenshot_path: string | null
  error: string | null
  notes: string
  created_at: string
  updated_at: string
  company: string
  title: string
  fit_score: number | null
  fit_bucket: FitBucket | null
}

/** Everything a caller may change. The preparer and the submitter use the fields beyond ApplicationPatch. */
export interface ApplicationUpdate extends ApplicationPatch {
  coverLetterLint?: LintReport | null
  formFields?: FormField[]
  submitMode?: SubmitMode | null
  submittedAt?: string | null
  submitClickedAt?: string | null
  confirmation?: string | null
  screenshotPath?: string | null
  error?: string | null
}

const SELECT_APP = `SELECT a.*, j.company AS company, j.title AS title, j.fit_score AS fit_score, j.fit_bucket AS fit_bucket
  FROM applications a JOIN jobs j ON j.id = a.job_id`

/** Outcomes that count as the employer answering. */
export const RESPONSE_OUTCOMES: ApplicationOutcome[] = ['screen', 'interview', 'offer', 'accepted', 'declined', 'rejected']

/** The job stage that matches an application status. */
const JOB_STAGE_FOR_STATUS: Record<ApplicationStatus, JobStage> = {
  draft: 'preparing',
  ready: 'ready',
  needs_attention: 'ready',
  submitting: 'ready',
  failed: 'ready',
  submitted: 'applied',
  withdrawn: 'shortlisted'
}

function flagged(answers: PreparedAnswer[]): number {
  return answers.filter(answerNeedsUser).length
}

function toSummary(row: ApplicationRow): ApplicationSummary {
  return {
    id: row.id,
    jobId: row.job_id,
    company: row.company,
    title: row.title,
    fitScore: row.fit_score,
    fitBucket: row.fit_bucket,
    status: row.status,
    outcome: row.outcome,
    submitMode: row.submit_mode,
    flaggedCount: flagged(parseJson<PreparedAnswer[]>(row.answers, [])),
    guessCount: parseJson<PreparedAnswer[]>(row.answers, []).filter(isGuess).length,
    submittedAt: row.submitted_at,
    outcomeAt: row.outcome_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toApplication(row: ApplicationRow): Application {
  return {
    ...toSummary(row),
    coverLetter: row.cover_letter,
    coverLetterLint: parseJson<LintReport | null>(row.cover_letter_lint, null),
    answers: parseJson<PreparedAnswer[]>(row.answers, []),
    formFields: parseJson<FormField[]>(row.form_fields, []),
    resumeDocId: row.resume_doc_id,
    confirmation: row.confirmation,
    screenshotPath: row.screenshot_path,
    submitClickedAt: row.submit_clicked_at,
    error: row.error,
    notes: row.notes
  }
}

export class ApplicationsRepo {
  constructor(private readonly db: Db) {}

  /** Starts a draft for a job. Returns the existing application if the job already has one. */
  create(jobId: string): Application {
    const existing = this.getByJob(jobId)
    if (existing) return existing
    const id = newId()
    const at = now()
    this.db.run(
      "INSERT INTO applications (id, job_id, status, created_at, updated_at) VALUES (:id, :jobId, 'draft', :at, :at)",
      { id, jobId, at }
    )
    this.syncJobStage(jobId, 'draft')
    return this.get(id)!
  }

  get(id: string): Application | null {
    const row = this.db.get<ApplicationRow>(`${SELECT_APP} WHERE a.id = :id`, { id })
    return row ? toApplication(row) : null
  }

  getByJob(jobId: string): Application | null {
    const row = this.db.get<ApplicationRow>(`${SELECT_APP} WHERE a.job_id = :jobId`, { jobId })
    return row ? toApplication(row) : null
  }

  list(query: ApplicationQuery): { items: ApplicationSummary[]; total: number } {
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
    addIn('a.status', query.statuses, 'status')
    addIn('a.outcome', query.outcomes, 'outcome')
    const term = query.search?.replace(/[%_\\]/g, ' ').trim().toLowerCase()
    if (term) {
      params.search = `%${term}%`
      where.push('(LOWER(j.title) LIKE :search OR LOWER(j.company) LIKE :search)')
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500))
    const offset = Math.max(0, query.offset ?? 0)
    const total =
      this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM applications a JOIN jobs j ON j.id = a.job_id ${whereSql}`, params as Params)?.n ?? 0
    const rows = this.db.all<ApplicationRow>(
      `${SELECT_APP} ${whereSql} ORDER BY a.updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params as Params
    )
    return { items: rows.map(toSummary), total }
  }

  /**
   * Applies a patch. Changing the status keeps the job's stage in step, setting an outcome stamps
   * outcomeAt, and moving to `submitted` stamps submittedAt unless the caller passes one.
   *
   * A withdrawn application stays withdrawn unless `reopen` is set (restoring a dismissed job) or it
   * was submitted after all. Background work that finishes after a dismissal can't bring it back.
   */
  update(id: string, patch: ApplicationUpdate, options: { reopen?: boolean } = {}): Application {
    const current = this.db.get<ApplicationRow>(`${SELECT_APP} WHERE a.id = :id`, { id })
    if (!current) throw new Error('That application no longer exists.')
    if (current.status === 'withdrawn' && patch.status !== undefined && patch.status !== 'submitted' && !options.reopen) {
      patch = { ...patch, status: undefined }
    }
    const sets: string[] = []
    const params: Record<string, string | number | null> = { id, at: now() }
    const set = (column: string, key: string, value: string | number | null) => {
      sets.push(`${column} = :${key}`)
      params[key] = value
    }
    if (patch.coverLetter !== undefined) set('cover_letter', 'coverLetter', patch.coverLetter)
    if (patch.coverLetterLint !== undefined) set('cover_letter_lint', 'lint', patch.coverLetterLint ? JSON.stringify(patch.coverLetterLint) : null)
    if (patch.answers !== undefined) set('answers', 'answers', JSON.stringify(patch.answers))
    if (patch.formFields !== undefined) set('form_fields', 'formFields', JSON.stringify(patch.formFields))
    if (patch.notes !== undefined) set('notes', 'notes', patch.notes)
    if (patch.resumeDocId !== undefined) set('resume_doc_id', 'resumeDocId', patch.resumeDocId)
    if (patch.submitMode !== undefined) set('submit_mode', 'submitMode', patch.submitMode)
    if (patch.confirmation !== undefined) set('confirmation', 'confirmation', patch.confirmation)
    if (patch.screenshotPath !== undefined) set('screenshot_path', 'screenshotPath', patch.screenshotPath)
    if (patch.error !== undefined) set('error', 'error', patch.error)
    if (patch.outcome !== undefined) {
      set('outcome', 'outcome', patch.outcome)
      set('outcome_at', 'outcomeAt', patch.outcome === 'none' ? null : params.at)
    }
    if (patch.status !== undefined) {
      set('status', 'status', patch.status)
      if (patch.status === 'submitted' && patch.submittedAt === undefined && !current.submitted_at) {
        set('submitted_at', 'submittedAt', params.at)
      }
    }
    if (patch.submittedAt !== undefined) set('submitted_at', 'submittedAt', patch.submittedAt)
    if (patch.submitClickedAt !== undefined) set('submit_clicked_at', 'submitClickedAt', patch.submitClickedAt)
    this.db.transaction(() => {
      this.db.run(`UPDATE applications SET ${sets.length ? `${sets.join(', ')}, ` : ''}updated_at = :at WHERE id = :id`, params)
      if (patch.status !== undefined) this.syncJobStage(current.job_id, patch.status)
    })
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM applications WHERE id = :id', { id })
  }

  /**
   * Applications waiting to be sent, best fit first. Jobs the user dismissed or that closed are left
   * out, and so is anything auto mode already clicked Submit on.
   */
  listReady(): ApplicationSummary[] {
    return this.db
      .all<ApplicationRow>(
        `${SELECT_APP} WHERE a.status = 'ready' AND j.stage = 'ready' AND a.submit_clicked_at IS NULL ORDER BY j.fit_score DESC, a.updated_at`
      )
      .map(toSummary)
  }

  /** Applications submitted since the given ISO time, counting Submit clicks that saw no confirmation. */
  countSubmittedSince(sinceIso: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM applications WHERE submitted_at >= :since OR submit_clicked_at >= :since', { since: sinceIso })
        ?.n ?? 0
    )
  }

  countByStatus(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const row of this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')) {
      out[row.status] = row.n
    }
    return out
  }

  /** When the user last applied to a company, matched on the normalized company name. */
  lastSubmittedAt(companyNorm: string): string | null {
    return (
      this.db.get<{ at: string | null }>(
        `SELECT MAX(a.submitted_at) AS at FROM applications a JOIN jobs j ON j.id = a.job_id
         WHERE j.company_norm = :norm AND a.submitted_at IS NOT NULL`,
        { norm: companyNorm }
      )?.at ?? null
    )
  }

  /** A dismissed job stays dismissed unless the application turns out to have been submitted. */
  private syncJobStage(jobId: string, status: ApplicationStatus): void {
    this.db.run("UPDATE jobs SET stage = :stage, updated_at = :at WHERE id = :id AND (stage != 'dismissed' OR :stage = 'applied')", {
      id: jobId,
      stage: JOB_STAGE_FOR_STATUS[status],
      at: now()
    })
  }
}
