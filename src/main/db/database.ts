import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { MIGRATIONS } from './schema'

const MAX_SAVE_DELAY_MS = 3000

export type Params = Record<string, SqlValue | boolean | undefined> | Array<SqlValue | boolean | undefined>

/**
 * A small wrapper around sql.js (SQLite compiled to WebAssembly).
 *
 * The whole database lives in memory and is written to disk shortly after each
 * change, and again on close. For one person's job search this stays small
 * (tens of megabytes at most), and it avoids native modules that need
 * rebuilding for every Electron version.
 */
export class Db {
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false
  /** When the oldest unsaved change happened. Saves can't be put off past MAX_SAVE_DELAY_MS. */
  private dirtySince: number | null = null
  private lastSaveError: Error | null = null
  private inTransaction = false

  private constructor(
    private readonly db: Database,
    private readonly filePath: string | null,
    private readonly saveDelayMs: number
  ) {}

  /** Opens (or creates) the database file. Pass null for an in-memory database, used in tests. */
  static async open(filePath: string | null, options: { saveDelayMs?: number } = {}): Promise<Db> {
    const SQL = await initSqlJs()
    let db: Database
    if (filePath && fs.existsSync(filePath)) {
      db = new SQL.Database(fs.readFileSync(filePath))
    } else {
      db = new SQL.Database()
    }
    const instance = new Db(db, filePath, options.saveDelayMs ?? 400)
    instance.migrate()
    return instance
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    let version = row ? Number(row.value) : 0
    // Migration 1 creates meta itself, so drop the bootstrap table on a fresh database.
    if (version === 0) this.db.exec('DROP TABLE meta')
    while (version < MIGRATIONS.length) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[version])
        version += 1
        this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(version)])
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw new Error(`Database migration ${version + 1} failed: ${(err as Error).message}`)
      }
    }
    this.markDirty()
  }

  get schemaVersion(): number {
    const row = this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    return row ? Number(row.value) : 0
  }

  run(sql: string, params?: Params): void {
    this.db.run(sql, normalizeParams(params))
    this.markDirty()
  }

  all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
    const stmt = this.db.prepare(sql)
    try {
      const bound = normalizeParams(params)
      if (bound) stmt.bind(bound)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  /** Runs fn inside a transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn()
    this.inTransaction = true
    this.db.exec('BEGIN')
    let result: T
    try {
      result = fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      this.inTransaction = false
      throw err
    }
    // Clear the flag before scheduling the save, or markDirty would skip it.
    this.inTransaction = false
    this.markDirty()
    return result
  }

  private markDirty(): void {
    this.dirty = true
    this.dirtySince ??= Date.now()
    if (!this.filePath || this.inTransaction) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    // Wait for a quiet moment, but never longer than MAX_SAVE_DELAY_MS during a busy run.
    const waited = Date.now() - this.dirtySince
    const delay = waited >= MAX_SAVE_DELAY_MS ? 0 : Math.min(this.saveDelayMs, MAX_SAVE_DELAY_MS - waited)
    this.saveTimer = setTimeout(() => this.flushFromTimer(), delay)
  }

  /** Timer saves must not throw. A failed save (a locked file on Windows, say) is retried. */
  private flushFromTimer(): void {
    try {
      this.flush()
      this.lastSaveError = null
    } catch (err) {
      this.lastSaveError = err as Error
      this.saveTimer = setTimeout(() => this.flushFromTimer(), 1000)
    }
  }

  /** The last error from a background save, if the most recent one failed. */
  get saveError(): Error | null {
    return this.lastSaveError
  }

  /** Writes the database to disk now. Safe to call often. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.filePath || !this.dirty) return
    const data = this.db.export()
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    // Write to a temp file first so a crash mid-write never corrupts the real file.
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, data)
    try {
      fs.renameSync(tmp, this.filePath)
    } catch {
      // Windows can refuse a rename while another program (an antivirus scan) holds the file.
      fs.copyFileSync(tmp, this.filePath)
      fs.rmSync(tmp, { force: true })
    }
    this.dirty = false
    this.dirtySince = null
  }

  close(): void {
    this.flush()
    this.db.close()
  }
}

function normalizeParams(params?: Params): SqlValue[] | Record<string, SqlValue> | undefined {
  if (!params) return undefined
  const fix = (v: SqlValue | boolean | undefined): SqlValue => {
    if (v === undefined) return null
    if (typeof v === 'boolean') return v ? 1 : 0
    return v
  }
  if (Array.isArray(params)) return params.map(fix)
  const out: Record<string, SqlValue> = {}
  for (const [k, v] of Object.entries(params)) {
    // Allow callers to write { id } for a statement that uses :id.
    const key = k.startsWith(':') || k.startsWith('$') || k.startsWith('@') ? k : `:${k}`
    out[key] = fix(v)
  }
  return out
}

/** ISO timestamp, the only time format stored in the database. */
export function now(): string {
  return new Date().toISOString()
}

export function newId(): string {
  return crypto.randomUUID()
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
