import type { AtsKind, Company, CompanyOrigin, JobStage } from '@shared/types'
import { type Db, now } from '../database'

/** Stages that mean a job on the board was worth the user's attention: shortlisted or better. */
export const RELEVANT_STAGES: JobStage[] = ['shortlisted', 'preparing', 'ready', 'applied']

export const INTERVAL_FAST_MINUTES = 60
export const INTERVAL_DEFAULT_MINUTES = 360
export const INTERVAL_SLOW_MINUTES = 1440
/** A relevant job found this recently keeps a board on the fast interval. */
export const FAST_WINDOW_DAYS = 14
/** A board with nothing relevant for this long is checked once a day. */
export const SLOW_AFTER_DAYS = 60
/** Failures in a row before a board is no longer watched. */
export const MAX_BOARD_FAILURES = 5
/** When a host asked us to wait, a board is tried again no sooner than this. */
const MIN_DEFER_MINUTES = 15
/** When no HTTP answer came back at all (offline, DNS, a timeout), a board is tried again after this. */
const UNREACHABLE_RETRY_MINUTES = 15

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

const stageList = (stages: JobStage[]) => stages.map((s) => `'${s}'`).join(', ')

interface StateRow {
  company_id: string
  origin: CompanyOrigin
  etag: string | null
  last_modified: string | null
  list_hash: string | null
  last_checked_at: string | null
  next_check_at: string
  last_changed_at: string | null
  interval_minutes: number
  failures: number
  last_status: number | null
  last_error: string | null
  live_jobs: number
  relevant_jobs: number
}

export interface BoardState {
  companyId: string
  origin: CompanyOrigin
  etag: string | null
  lastModified: string | null
  listHash: string | null
  lastCheckedAt: string | null
  nextCheckAt: string
  lastChangedAt: string | null
  intervalMinutes: number
  failures: number
  lastStatus: number | null
  lastError: string | null
  liveJobs: number
  relevantJobs: number
}

function toState(row: StateRow): BoardState {
  return {
    companyId: row.company_id,
    origin: row.origin,
    etag: row.etag,
    lastModified: row.last_modified,
    listHash: row.list_hash,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    lastChangedAt: row.last_changed_at,
    intervalMinutes: row.interval_minutes,
    failures: row.failures,
    lastStatus: row.last_status,
    lastError: row.last_error,
    liveJobs: row.live_jobs,
    relevantJobs: row.relevant_jobs
  }
}

/** What one read of a board found. A value left undefined keeps what is stored. */
export interface BoardCheck {
  /**
   * 200 or 304 for a good read, the HTTP status for a failed one, null when the host could not be
   * reached. A failure with null status counts no failure against the board, since a network outage
   * says nothing about the board. It is tried again in 15 minutes.
   */
  status: number | null
  etag?: string | null
  lastModified?: string | null
  /** Null clears the stored hash, so the next read compares against nothing. */
  listHash?: string | null
  /** Postings on the board that are still open. */
  jobCount?: number
  /** Postings on the board that are shortlisted or further. */
  relevantCount?: number
  /** A relevant posting was discovered on this board in the last 14 days. */
  newRelevant?: boolean
  /** Set when the read failed. */
  error?: string | null
  /** The host asked us to come back later (a 429). Counts no failure. A time in ms. */
  deferUntil?: number
}

export interface BoardCheckOutcome {
  state: BoardState
  /** True when this failure was the last one allowed, so the company is no longer watched. */
  unwatched: boolean
}

export interface DueBoard {
  company: Company
  state: BoardState
}

interface DueRow extends StateRow {
  c_id: string
  c_name: string
  c_ats: AtsKind
  c_ats_token: string
  c_careers_url: string | null
  c_watch: number
  c_blocked: number
  c_notes: string
  c_origin: CompanyOrigin
  c_created_at: string
}

export class BoardsRepo {
  constructor(private readonly db: Db) {}

  get(companyId: string): BoardState | null {
    const row = this.db.get<StateRow>('SELECT * FROM board_state WHERE company_id = :id', { id: companyId })
    return row ? toState(row) : null
  }

  /**
   * Gives a company that became watched a board state, due now. A company that already has one keeps
   * its etag and history, but its failures are cleared and it is due now, so turning watch back on
   * checks the board soon.
   */
  ensureState(companyId: string, origin: CompanyOrigin = 'manual', at = now()): void {
    this.db.run(
      `INSERT INTO board_state (company_id, origin, next_check_at) VALUES (:id, :origin, :at)
       ON CONFLICT(company_id) DO UPDATE SET failures = 0, last_error = NULL, next_check_at = MIN(next_check_at, :at)`,
      { id: companyId, origin, at }
    )
  }

  /** Clears a board's failures and its last error, and makes it due now. Does nothing for a company with no board state. */
  resetFailures(companyId: string, at = now()): void {
    this.db.run(
      `UPDATE board_state SET failures = 0, last_error = NULL, next_check_at = MIN(next_check_at, :at) WHERE company_id = :id`,
      { id: companyId, at }
    )
  }

  /** Watched boards that are due, soonest first. `ats` limits the list to boards the app can read. */
  due(at: string, limit: number, ats?: AtsKind[]): DueBoard[] {
    // A company watched through a path that skipped ensureState still gets checked.
    this.db.run(
      `INSERT OR IGNORE INTO board_state (company_id, origin, next_check_at)
       SELECT id, origin, :at FROM companies WHERE watch = 1 AND blocked = 0 AND ats_token IS NOT NULL AND ats != 'unknown'`,
      { at }
    )
    const params: Record<string, string | number> = { at, limit }
    ats?.forEach((a, i) => (params[`ats${i}`] = a))
    const filter = ats ? (ats.length ? `AND c.ats IN (${ats.map((_, i) => `:ats${i}`).join(', ')})` : 'AND 0') : ''
    const rows = this.db.all<DueRow>(
      `SELECT b.*, c.id AS c_id, c.name AS c_name, c.ats AS c_ats, c.ats_token AS c_ats_token, c.careers_url AS c_careers_url,
         c.watch AS c_watch, c.blocked AS c_blocked, c.notes AS c_notes, c.origin AS c_origin, c.created_at AS c_created_at
       FROM board_state b JOIN companies c ON c.id = b.company_id
       WHERE c.watch = 1 AND c.blocked = 0 AND c.ats_token IS NOT NULL AND c.ats != 'unknown'
         AND b.next_check_at <= :at ${filter}
       ORDER BY b.next_check_at, c.name_norm
       LIMIT :limit`,
      params
    )
    return rows.map((r) => ({
      state: toState(r),
      company: {
        id: r.c_id,
        name: r.c_name,
        ats: r.c_ats,
        atsToken: r.c_ats_token,
        careersUrl: r.c_careers_url,
        watch: r.c_watch === 1,
        blocked: r.c_blocked === 1,
        notes: r.c_notes,
        origin: r.c_origin,
        createdAt: r.c_created_at
      }
    }))
  }

  /** Counts of a board's stored postings, and whether a relevant one turned up lately. */
  relevance(
    source: string,
    atsToken: string,
    at = Date.now()
  ): { live: number; relevant: number; newRelevant: boolean } {
    const since = new Date(at - FAST_WINDOW_DAYS * DAY_MS).toISOString()
    const row = this.db.get<{ live: number | null; relevant: number | null; fresh: number | null }>(
      `SELECT SUM(CASE WHEN stage NOT IN ('closed', 'duplicate') THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN stage IN (${stageList(RELEVANT_STAGES)}) THEN 1 ELSE 0 END) AS relevant,
              SUM(CASE WHEN stage IN (${stageList(RELEVANT_STAGES)}) AND discovered_at >= :since THEN 1 ELSE 0 END) AS fresh
       FROM jobs WHERE source = :source AND ats_token = :token`,
      { source, token: atsToken, since }
    )
    return { live: row?.live ?? 0, relevant: row?.relevant ?? 0, newRelevant: (row?.fresh ?? 0) > 0 }
  }

  /**
   * True when a company has been known for at least 60 days and none of its board's postings that
   * mattered were discovered in that time.
   */
  private quiet(companyId: string, at: number): boolean {
    const company = this.db.get<{ ats: string; ats_token: string | null; created_at: string }>(
      'SELECT ats, ats_token, created_at FROM companies WHERE id = :id',
      { id: companyId }
    )
    if (!company?.ats_token) return false
    const cutoff = at - SLOW_AFTER_DAYS * DAY_MS
    if (Date.parse(company.created_at) > cutoff) return false
    const found = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM jobs WHERE source = :source AND ats_token = :token
         AND stage IN (${stageList(RELEVANT_STAGES)}) AND discovered_at >= :since`,
      { source: company.ats, token: company.ats_token, since: new Date(cutoff).toISOString() }
    )
    return (found?.n ?? 0) === 0
  }

  /** Writes what a read found and schedules the next one. */
  recordCheck(companyId: string, result: BoardCheck, atMs = Date.now()): BoardCheckOutcome {
    const state = this.get(companyId)
    if (!state) {
      this.ensureState(companyId, 'manual', new Date(atMs).toISOString())
    }
    const before = this.get(companyId)!
    const checkedAt = new Date(atMs).toISOString()
    const keep = <T>(value: T | undefined, stored: T): T => (value === undefined ? stored : value)
    let unwatched = false

    let failures = before.failures
    let interval = before.intervalMinutes
    let nextAt: number
    let lastError: string | null = null
    let lastChangedAt = before.lastChangedAt

    if (result.deferUntil !== undefined) {
      // The host is busy. Try again later without counting a failure.
      nextAt = Math.max(result.deferUntil, atMs + MIN_DEFER_MINUTES * MINUTE_MS)
      lastError = result.error ?? null
    } else if (result.error && result.status === null) {
      // No HTTP answer: the network is down or the host is unreachable. That says nothing about the
      // board, so it keeps its failure count and interval and is tried again soon.
      nextAt = atMs + UNREACHABLE_RETRY_MINUTES * MINUTE_MS
      lastError = result.error
    } else if (result.error) {
      failures += 1
      interval = Math.min(INTERVAL_SLOW_MINUTES, before.intervalMinutes * 2)
      nextAt = atMs + interval * MINUTE_MS
      lastError = result.error
      if (failures >= MAX_BOARD_FAILURES) {
        unwatched = true
        this.db.run('UPDATE companies SET watch = 0 WHERE id = :id', { id: companyId })
      }
    } else {
      failures = 0
      interval = result.newRelevant ? INTERVAL_FAST_MINUTES : this.quiet(companyId, atMs) ? INTERVAL_SLOW_MINUTES : INTERVAL_DEFAULT_MINUTES
      nextAt = atMs + interval * MINUTE_MS
      const changed = result.status === 200 && (result.listHash === undefined || result.listHash === null || result.listHash !== before.listHash)
      if (changed) lastChangedAt = checkedAt
    }

    this.db.run(
      `UPDATE board_state SET etag = :etag, last_modified = :lastModified, list_hash = :listHash,
         last_checked_at = :checkedAt, next_check_at = :nextAt, last_changed_at = :lastChangedAt,
         interval_minutes = :interval, failures = :failures, last_status = :status, last_error = :error,
         live_jobs = :live, relevant_jobs = :relevant
       WHERE company_id = :id`,
      {
        id: companyId,
        etag: result.error ? before.etag : keep(result.etag, before.etag),
        lastModified: result.error ? before.lastModified : keep(result.lastModified, before.lastModified),
        listHash: result.error ? before.listHash : keep(result.listHash, before.listHash),
        checkedAt,
        nextAt: new Date(nextAt).toISOString(),
        lastChangedAt,
        interval,
        failures,
        status: result.status,
        error: lastError,
        live: keep(result.jobCount, before.liveJobs),
        relevant: keep(result.relevantCount, before.relevantJobs)
      }
    )
    return { state: this.get(companyId)!, unwatched }
  }
}
