import type { BulkCompanyAction, CompanyCounts, CompanyPage, CompanyQuery, CompanyWithBoard } from '@shared/api'
import type { AtsKind, Company, CompanyInput, CompanyOrigin } from '@shared/types'
import { normalizeCompany } from '../../pipeline/dedupe'
import { type Db, newId, now } from '../database'
import { MAX_BOARD_FAILURES } from './boards'

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

/** A watched company whose board the pipeline can read. */
const READABLE = "c.watch = 1 AND c.blocked = 0 AND c.ats_token IS NOT NULL AND c.ats != 'unknown'"

interface CompanyRow {
  id: string
  name: string
  name_norm: string
  ats: AtsKind
  ats_token: string | null
  careers_url: string | null
  watch: number
  blocked: number
  notes: string
  origin: CompanyOrigin
  created_at: string
}

interface CompanyBoardRow extends CompanyRow {
  last_checked_at: string | null
  next_check_at: string | null
  interval_minutes: number | null
  failures: number
  last_error: string | null
  live_jobs: number
  relevant_jobs: number
}

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    ats: row.ats,
    atsToken: row.ats_token,
    careersUrl: row.careers_url,
    watch: row.watch === 1,
    blocked: row.blocked === 1,
    notes: row.notes,
    origin: row.origin,
    createdAt: row.created_at
  }
}

/** Escapes the characters LIKE treats as wildcards. Use with ESCAPE '!'. */
const likeText = (text: string): string => text.replace(/[!%_]/g, (ch) => `!${ch}`)

export class CompaniesRepo {
  constructor(private readonly db: Db) {}

  list(): Company[] {
    return this.db.all<CompanyRow>('SELECT * FROM companies ORDER BY name_norm').map(toCompany)
  }

  /**
   * One page of companies with their board state, filtered in SQL. Filters combine with AND.
   * Rows are ordered by name. Counts cover every company and ignore the filters.
   */
  listPage(query: CompanyQuery = {}): CompanyPage {
    const whole = (value: number | undefined, fallback: number): number => (Number.isFinite(value) ? Math.floor(value as number) : fallback)
    const size = Math.min(MAX_PAGE_SIZE, Math.max(1, whole(query.pageSize, DEFAULT_PAGE_SIZE)))
    const page = Math.max(1, whole(query.page, 1))
    const where: string[] = []
    const params: Record<string, string | number> = {}
    const text = query.search?.trim()
    if (text) {
      where.push("(c.name_norm LIKE :like ESCAPE '!' OR LOWER(c.name) LIKE :like ESCAPE '!' OR LOWER(c.ats_token) LIKE :like ESCAPE '!')")
      params.like = `%${likeText(text.toLowerCase())}%`
    }
    if (query.ats && query.ats !== 'all') {
      where.push('c.ats = :ats')
      params.ats = query.ats
    }
    if (query.origin && query.origin !== 'all') {
      where.push('c.origin = :origin')
      params.origin = query.origin
    }
    switch (query.state) {
      case 'watched':
        where.push('c.watch = 1 AND c.blocked = 0')
        break
      case 'unwatched':
        where.push('c.watch = 0 AND c.blocked = 0')
        break
      case 'blocked':
        where.push('c.blocked = 1')
        break
      case 'stopped':
        where.push(`c.watch = 0 AND c.blocked = 0 AND b.failures >= ${MAX_BOARD_FAILURES}`)
        break
      case 'failing':
        where.push(`c.watch = 1 AND c.blocked = 0 AND b.failures BETWEEN 1 AND ${MAX_BOARD_FAILURES - 1}`)
        break
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM companies c LEFT JOIN board_state b ON b.company_id = c.id ${clause}`,
      params
    )?.n ?? 0
    const rows = this.db.all<CompanyBoardRow>(
      `SELECT c.*, b.last_checked_at, b.next_check_at, b.interval_minutes, COALESCE(b.failures, 0) AS failures, b.last_error,
         COALESCE(b.live_jobs, 0) AS live_jobs, COALESCE(b.relevant_jobs, 0) AS relevant_jobs
       FROM companies c LEFT JOIN board_state b ON b.company_id = c.id
       ${clause}
       ORDER BY c.name_norm, c.id
       LIMIT :limit OFFSET :offset`,
      { ...params, limit: size, offset: (page - 1) * size }
    )
    const items: CompanyWithBoard[] = rows.map((r) => ({
      ...toCompany(r),
      lastCheckedAt: r.last_checked_at,
      nextCheckAt: r.next_check_at,
      intervalMinutes: r.interval_minutes,
      failures: r.failures,
      lastError: r.last_error,
      liveJobs: r.live_jobs,
      relevantJobs: r.relevant_jobs
    }))
    return { items, total, counts: this.counts() }
  }

  /** Totals for the summary strip. One pass over the companies. */
  counts(): CompanyCounts {
    const row = this.db.get<Record<string, number | string | null>>(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(c.watch = 1 AND c.blocked = 0), 0) AS watched,
         COALESCE(SUM(c.blocked = 1), 0) AS blocked,
         COALESCE(SUM(c.origin = 'posting_link'), 0) AS from_postings,
         COALESCE(SUM(c.watch = 0 AND c.blocked = 0 AND b.failures >= ${MAX_BOARD_FAILURES}), 0) AS stopped,
         COALESCE(SUM(c.watch = 1 AND c.blocked = 0 AND b.failures BETWEEN 1 AND ${MAX_BOARD_FAILURES - 1}), 0) AS failing,
         COALESCE(SUM(CASE WHEN c.watch = 1 AND c.blocked = 0 THEN b.live_jobs ELSE 0 END), 0) AS live_jobs,
         COALESCE(SUM(CASE WHEN c.watch = 1 AND c.blocked = 0 THEN b.relevant_jobs ELSE 0 END), 0) AS relevant_jobs,
         MIN(CASE WHEN ${READABLE} THEN b.next_check_at END) AS next_check_at
       FROM companies c LEFT JOIN board_state b ON b.company_id = c.id`,
    )
    const n = (key: string): number => Number(row?.[key] ?? 0)
    return {
      total: n('total'),
      watched: n('watched'),
      blocked: n('blocked'),
      fromPostings: n('from_postings'),
      stopped: n('stopped'),
      failing: n('failing'),
      liveJobs: n('live_jobs'),
      relevantJobs: n('relevant_jobs'),
      nextCheckAt: (row?.next_check_at as string | null) ?? null
    }
  }

  /**
   * Applies one action to many companies in one transaction. Returns how many changed, and the
   * companies that now need a board state: readable boards that were not watched before and are now.
   * A blocked company is never watched, so "watch" skips blocked ones and "block" turns watch off.
   */
  bulk(ids: string[], action: BulkCompanyAction): { changed: number; started: Company[]; rewatched: Company[] } {
    const started: Company[] = []
    const rewatched: Company[] = []
    let changed = 0
    this.db.transaction(() => {
      for (const id of new Set(ids)) {
        const before = this.get(id)
        if (!before) continue
        switch (action) {
          case 'watch': {
            if (before.blocked) continue
            const after = before.watch ? before : this.save({ id, watch: true })
            if (!before.watch) changed += 1
            if (after.atsToken && after.ats !== 'unknown') (before.watch ? rewatched : started).push(after)
            break
          }
          case 'unwatch':
            if (!before.watch) continue
            this.save({ id, watch: false })
            changed += 1
            break
          case 'block':
            if (before.blocked) continue
            this.save({ id, blocked: true, watch: false })
            changed += 1
            break
          case 'unblock':
            if (!before.blocked) continue
            this.save({ id, blocked: false })
            changed += 1
            break
          case 'delete':
            this.delete(id)
            changed += 1
            break
        }
      }
    })
    return { changed, started, rewatched }
  }

  get(id: string): Company | null {
    const row = this.db.get<CompanyRow>('SELECT * FROM companies WHERE id = :id', { id })
    return row ? toCompany(row) : null
  }

  findByAts(ats: AtsKind, token: string): Company | null {
    const row = this.db.get<CompanyRow>('SELECT * FROM companies WHERE ats = :ats AND ats_token = :token', { ats, token })
    return row ? toCompany(row) : null
  }

  findByName(name: string): Company | null {
    const row = this.db.get<CompanyRow>('SELECT * FROM companies WHERE name_norm = :norm ORDER BY created_at LIMIT 1', {
      norm: normalizeCompany(name)
    })
    return row ? toCompany(row) : null
  }

  /** Watched companies whose job board the pipeline can read. */
  listWatched(): Company[] {
    return this.db
      .all<CompanyRow>(
        "SELECT * FROM companies WHERE watch = 1 AND blocked = 0 AND ats_token IS NOT NULL AND ats != 'unknown' ORDER BY name_norm"
      )
      .map(toCompany)
  }

  /** How many companies are watched and have a board the pipeline can read. */
  countWatched(): number {
    return (
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM companies WHERE watch = 1 AND blocked = 0 AND ats_token IS NOT NULL AND ats != 'unknown'"
      )?.n ?? 0
    )
  }

  /** Normalized names of blocked companies. */
  blockedNames(): string[] {
    return this.db.all<{ name_norm: string }>('SELECT name_norm FROM companies WHERE blocked = 1').map((r) => r.name_norm)
  }

  /** Creates or updates a company. Fields left out keep their stored values. */
  save(input: CompanyInput & { id?: string }): Company {
    const existing = input.id ? this.db.get<CompanyRow>('SELECT * FROM companies WHERE id = :id', { id: input.id }) : undefined
    const id = existing?.id ?? input.id ?? newId()
    const name = (input.name ?? existing?.name ?? input.atsToken ?? 'Unnamed company').trim()
    this.db.run(
      `INSERT INTO companies (id, name, name_norm, ats, ats_token, careers_url, watch, blocked, notes, origin, created_at)
       VALUES (:id, :name, :norm, :ats, :token, :careers, :watch, :blocked, :notes, :origin, :at)
       ON CONFLICT(id) DO UPDATE SET name = :name, name_norm = :norm, ats = :ats, ats_token = :token,
         careers_url = :careers, watch = :watch, blocked = :blocked, notes = :notes, origin = :origin`,
      {
        id,
        name,
        norm: normalizeCompany(name),
        ats: input.ats ?? existing?.ats ?? 'unknown',
        token: input.atsToken ?? existing?.ats_token ?? null,
        careers: input.careersUrl ?? existing?.careers_url ?? null,
        watch: input.watch ?? (existing ? existing.watch === 1 : false),
        blocked: input.blocked ?? (existing ? existing.blocked === 1 : false),
        notes: input.notes ?? existing?.notes ?? '',
        origin: input.origin ?? existing?.origin ?? 'manual',
        at: existing?.created_at ?? now()
      }
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM companies WHERE id = :id', { id })
    this.db.run('DELETE FROM board_state WHERE company_id = :id', { id })
    this.db.run('UPDATE jobs SET company_id = NULL WHERE company_id = :id', { id })
  }

  /** Finds the company for an ATS board, or creates an unwatched one. */
  ensureForAts(name: string, ats: AtsKind, token: string, careersUrl: string | null = null): Company {
    return this.findByAts(ats, token) ?? this.save({ name, ats, atsToken: token, careersUrl: careersUrl ?? undefined, watch: false })
  }
}
