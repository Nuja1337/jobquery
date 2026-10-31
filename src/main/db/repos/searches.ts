import type { SavedSearch } from '@shared/types'
import { type Db, newId, now, parseJson } from '../database'

interface SearchRow {
  id: string
  source: SavedSearch['source']
  label: string
  params: string
  enabled: number
  last_run_at: string | null
}

function toSearch(row: SearchRow): SavedSearch {
  return {
    id: row.id,
    source: row.source,
    label: row.label,
    params: parseJson<Record<string, string>>(row.params, {}),
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at
  }
}

export class SearchesRepo {
  constructor(private readonly db: Db) {}

  list(): SavedSearch[] {
    return this.db.all<SearchRow>('SELECT * FROM searches ORDER BY label').map(toSearch)
  }

  listEnabled(): SavedSearch[] {
    return this.list().filter((s) => s.enabled)
  }

  get(id: string): SavedSearch | null {
    const row = this.db.get<SearchRow>('SELECT * FROM searches WHERE id = :id', { id })
    return row ? toSearch(row) : null
  }

  save(input: Omit<SavedSearch, 'id' | 'lastRunAt'> & { id?: string }): SavedSearch {
    const id = input.id ?? newId()
    this.db.run(
      `INSERT INTO searches (id, source, label, params, enabled) VALUES (:id, :source, :label, :params, :enabled)
       ON CONFLICT(id) DO UPDATE SET source = :source, label = :label, params = :params, enabled = :enabled`,
      { id, source: input.source, label: input.label, params: JSON.stringify(input.params), enabled: input.enabled }
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM searches WHERE id = :id', { id })
  }

  markRun(id: string): void {
    this.db.run('UPDATE searches SET last_run_at = :at WHERE id = :id', { id, at: now() })
  }
}
