import type { AtsKind, Company, CompanyInput } from '@shared/types'
import { normalizeCompany } from '../../pipeline/dedupe'
import { type Db, newId, now } from '../database'

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
  created_at: string
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
    createdAt: row.created_at
  }
}

export class CompaniesRepo {
  constructor(private readonly db: Db) {}

  list(): Company[] {
    return this.db.all<CompanyRow>('SELECT * FROM companies ORDER BY name_norm').map(toCompany)
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
      `INSERT INTO companies (id, name, name_norm, ats, ats_token, careers_url, watch, blocked, notes, created_at)
       VALUES (:id, :name, :norm, :ats, :token, :careers, :watch, :blocked, :notes, :at)
       ON CONFLICT(id) DO UPDATE SET name = :name, name_norm = :norm, ats = :ats, ats_token = :token,
         careers_url = :careers, watch = :watch, blocked = :blocked, notes = :notes`,
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
        at: existing?.created_at ?? now()
      }
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM companies WHERE id = :id', { id })
    this.db.run('UPDATE jobs SET company_id = NULL WHERE company_id = :id', { id })
  }

  /** Finds the company for an ATS board, or creates an unwatched one. */
  ensureForAts(name: string, ats: AtsKind, token: string, careersUrl: string | null = null): Company {
    return this.findByAts(ats, token) ?? this.save({ name, ats, atsToken: token, careersUrl: careersUrl ?? undefined, watch: false })
  }
}
