import type { PushChannel, PushEvents } from '@shared/api'
import type { EventRecord, EventType } from '@shared/types'
import { type Db, newId, now, parseJson } from '../database'

export type Emit = <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void

interface EventRow {
  id: string
  at: string
  type: EventType
  job_id: string | null
  message: string
  data: string | null
}

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    at: row.at,
    type: row.type,
    jobId: row.job_id,
    message: row.message,
    data: parseJson<Record<string, unknown> | null>(row.data, null)
  }
}

export class EventsRepo {
  constructor(
    private readonly db: Db,
    private readonly emit: Emit
  ) {}

  /** Writes an activity log entry and pushes it to the UI. */
  add(type: EventType, message: string, jobId?: string | null, data?: Record<string, unknown> | null): EventRecord {
    const record: EventRecord = { id: newId(), at: now(), type, jobId: jobId ?? null, message, data: data ?? null }
    this.db.run(
      'INSERT INTO events (id, at, type, job_id, message, data) VALUES (:id, :at, :type, :jobId, :message, :data)',
      { id: record.id, at: record.at, type, jobId: record.jobId, message, data: data ? JSON.stringify(data) : null }
    )
    this.emit('event:new', record)
    return record
  }

  list(query: { limit?: number; types?: EventType[]; jobId?: string } = {}): EventRecord[] {
    const where: string[] = []
    const params: Record<string, string> = {}
    if (query.types && query.types.length > 0) {
      const names = query.types.map((t, i) => {
        params[`t${i}`] = t
        return `:t${i}`
      })
      where.push(`type IN (${names.join(', ')})`)
    }
    if (query.jobId) {
      where.push('job_id = :jobId')
      params.jobId = query.jobId
    }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 1000))
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ${limit}`
    return this.db.all<EventRow>(sql, params).map(toRecord)
  }
}
