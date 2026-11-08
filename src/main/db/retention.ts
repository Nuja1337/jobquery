import type { Db } from './database'

/** Jobs dropped by the free rules, and closed or archived jobs, are cleaned up after this many days. */
export const JOB_RETENTION_DAYS = 60
/** Events other than the kept types are deleted after this many days. */
export const EVENT_RETENTION_DAYS = 180
/** Cached AI responses are deleted after this many days. */
export const CACHE_RETENTION_DAYS = 90
/** Run records are deleted after this many days. */
export const RUN_RETENTION_DAYS = 180
/** Descriptions of closed and archived jobs are cut to this many characters. */
export const KEPT_DESCRIPTION_CHARS = 2000

/** Events that record a submission or an outcome. They stay as the history of what was sent. */
export const KEPT_EVENT_TYPES = ['submitted', 'outcome']

const DAY_MS = 86_400_000
const CUT_MARKER = ' […]'

export interface RetentionReport {
  /** Jobs the free rules dropped, with their duplicate rows, that were deleted. */
  jobsDeleted: number
  /** Closed or archived jobs whose description was shortened. */
  descriptionsTrimmed: number
  eventsDeleted: number
  cacheEntriesDeleted: number
  runsDeleted: number
}

const iso = (now: Date, days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString()

function changes(db: Db): number {
  return db.get<{ n: number }>('SELECT changes() AS n')?.n ?? 0
}

/** A job that was never sent to the AI and that the user never acted on or starred, so finding it again costs nothing. */
const disposable = (alias: string): string => `${alias}.discovered_at < :cutoff AND ${alias}.fit_score IS NULL AND ${alias}.starred = 0
  AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = ${alias}.id)`

/** A disposable job the free rules dropped, whose duplicate rows are all disposable too. */
const DROPPED_ORIGINAL = `o.stage IN ('filtered_out', 'prescored_out') AND ${disposable('o')}
  AND NOT EXISTS (SELECT 1 FROM jobs x WHERE x.dup_of = o.id AND NOT (x.stage = 'duplicate' AND ${disposable('x')}))`

/**
 * Keeps the database from growing without bound. Each rule runs in its own transaction.
 *
 * - Jobs in `filtered_out` or `prescored_out` older than 60 days are deleted when they have no
 *   application, no fit score and no star. So are their duplicate rows. An original that still has a duplicate
 *   the user acted on stays.
 * - Closed jobs, and scored jobs no source has listed for 60 days, older than 60 days and without an
 *   application keep the first 2,000 characters of the description. The columns the dedupe reads stay.
 * - Events older than 180 days are deleted, except submissions and outcomes.
 * - Cached AI responses older than 90 days and runs older than 180 days are deleted.
 */
export function runRetention(db: Db, now = new Date()): RetentionReport {
  const report: RetentionReport = { jobsDeleted: 0, descriptionsTrimmed: 0, eventsDeleted: 0, cacheEntriesDeleted: 0, runsDeleted: 0 }

  db.transaction(() => {
    const cutoff = iso(now, JOB_RETENTION_DAYS)
    // Duplicate rows go first, so the original no longer has anything pointing at it.
    db.run(`DELETE FROM jobs WHERE dup_of IN (SELECT o.id FROM jobs o WHERE ${DROPPED_ORIGINAL}) AND stage = 'duplicate'`, { cutoff })
    report.jobsDeleted += changes(db)
    db.run(`DELETE FROM jobs WHERE id IN (SELECT o.id FROM jobs o WHERE ${DROPPED_ORIGINAL})`, { cutoff })
    report.jobsDeleted += changes(db)
  })

  db.transaction(() => {
    const cutoff = iso(now, JOB_RETENTION_DAYS)
    // The marker adds 4 characters, so a description already cut is left alone.
    db.run(
      `UPDATE jobs SET description = substr(description, 1, :keep) || :marker
       WHERE length(description) > :limit
         AND discovered_at < :cutoff
         AND (stage = 'closed' OR (stage = 'scored' AND COALESCE(last_seen_at, discovered_at) < :cutoff))
         AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id)`,
      { keep: KEPT_DESCRIPTION_CHARS, marker: CUT_MARKER, limit: KEPT_DESCRIPTION_CHARS + CUT_MARKER.length, cutoff }
    )
    report.descriptionsTrimmed = changes(db)
  })

  db.transaction(() => {
    const names = KEPT_EVENT_TYPES.map((_, i) => `:t${i}`).join(', ')
    const params: Record<string, string> = { cutoff: iso(now, EVENT_RETENTION_DAYS) }
    KEPT_EVENT_TYPES.forEach((type, i) => (params[`t${i}`] = type))
    db.run(`DELETE FROM events WHERE at < :cutoff AND type NOT IN (${names})`, params)
    report.eventsDeleted = changes(db)
  })

  db.transaction(() => {
    db.run('DELETE FROM llm_cache WHERE created_at < :cutoff', { cutoff: iso(now, CACHE_RETENTION_DAYS) })
    report.cacheEntriesDeleted = changes(db)
  })

  db.transaction(() => {
    db.run('DELETE FROM runs WHERE started_at < :cutoff', { cutoff: iso(now, RUN_RETENTION_DAYS) })
    report.runsDeleted = changes(db)
  })

  return report
}
