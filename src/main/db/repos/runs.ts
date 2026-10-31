import type { RunRecord, RunStats } from '@shared/types'
import { type Db, newId, now, parseJson } from '../database'

interface RunRow {
  id: string
  trigger: 'manual' | 'schedule'
  started_at: string
  finished_at: string | null
  stats: string
  error: string | null
}

export function emptyStats(): RunStats {
  return {
    discovered: 0,
    newJobs: 0,
    duplicates: 0,
    filteredOut: 0,
    prescoredOut: 0,
    scored: 0,
    shortlisted: 0,
    prepared: 0,
    submitted: 0,
    errors: 0,
    costUsd: 0,
    tokens: 0,
    stoppedForBudget: false
  }
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stats: { ...emptyStats(), ...parseJson<Partial<RunStats>>(row.stats, {}) },
    error: row.error
  }
}

export class RunsRepo {
  constructor(private readonly db: Db) {}

  start(trigger: 'manual' | 'schedule'): RunRecord {
    const id = newId()
    this.db.run('INSERT INTO runs (id, trigger, started_at, stats) VALUES (:id, :trigger, :at, :stats)', {
      id,
      trigger,
      at: now(),
      stats: JSON.stringify(emptyStats())
    })
    return this.get(id)!
  }

  /** Saves the final numbers. Safe to call with partial stats while a run is going. */
  finish(id: string, stats: RunStats, error: string | null = null): RunRecord {
    this.db.run('UPDATE runs SET finished_at = :at, stats = :stats, error = :error WHERE id = :id', {
      id,
      at: now(),
      stats: JSON.stringify(stats),
      error
    })
    return this.get(id)!
  }

  get(id: string): RunRecord | null {
    const row = this.db.get<RunRow>('SELECT * FROM runs WHERE id = :id', { id })
    return row ? toRecord(row) : null
  }

  list(limit = 20): RunRecord[] {
    return this.db
      .all<RunRow>(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ${Math.max(1, Math.min(Math.floor(limit), 500))}`)
      .map(toRecord)
  }
}
