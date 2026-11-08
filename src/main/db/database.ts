import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { MIGRATIONS, type Migration } from './schema'

type SqlValue = string | number | null | Uint8Array
type Bound = SQLInputValue
/** The arguments for a statement call: the values, or one object of named values. */
type Bindings = Bound[]

export type Params = Record<string, SqlValue | boolean | undefined> | Array<SqlValue | boolean | undefined>

/** The argument type of a function migration, whatever schema.ts declares it as. */
type MigrationHandle = Parameters<Extract<Migration, (...args: never[]) => unknown>>[0]

const STATEMENT_CACHE_LIMIT = 200

/**
 * A small wrapper around Node's built-in SQLite (node:sqlite).
 *
 * Writes go straight to the database file, which runs in WAL mode, so a committed write is already
 * durable. There is no in-memory copy and no periodic save. The earlier version kept the whole
 * database in memory (sql.js) and rewrote the file after each change, with a temp file and a
 * recovery path for a failed rename. Both are gone: SQLite's journal gives the same crash safety
 * without rewriting the file, and the rewrite cost grows with the number of jobs.
 */
export class Db {
  private lastError: Error | null = null
  private inTransaction = false
  private closed = false
  private readonly statements = new Map<string, StatementSync>()

  private constructor(
    private readonly db: DatabaseSync,
    private readonly filePath: string | null
  ) {}

  /**
   * Opens (or creates) the database file. Pass null for an in-memory database, used in tests.
   * A file written by the sql.js version opens as is. saveDelayMs is accepted for old callers and ignored.
   */
  static async open(filePath: string | null, _options: { saveDelayMs?: number } = {}): Promise<Db> {
    if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // sql.js ran with foreign keys off and the data was written that way, so they stay off.
    const db = new DatabaseSync(filePath ?? ':memory:', { enableForeignKeyConstraints: false })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      if (filePath) {
        // The first query on a file reads it, so this also fails here when the file is not a database.
        db.exec('PRAGMA journal_mode = WAL')
        db.exec('PRAGMA synchronous = NORMAL')
      }
      const instance = new Db(db, filePath)
      instance.migrate()
      return instance
    } catch (err) {
      db.close()
      throw err
    }
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    let version = row ? Number(row.value) : 0
    // Migration 1 creates meta itself, so drop the bootstrap table on a fresh database.
    if (version === 0) this.db.exec('DROP TABLE meta')
    const handle = migrationHandle(this.db)
    while (version < MIGRATIONS.length) {
      this.db.exec('BEGIN')
      try {
        const migration = MIGRATIONS[version]
        if (typeof migration === 'string') this.db.exec(migration)
        else migration(handle)
        version += 1
        this.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(version)])
        this.db.exec('COMMIT')
      } catch (err) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK')
        throw new Error(`Database migration ${version + 1} failed: ${(err as Error).message}`)
      }
    }
  }

  get schemaVersion(): number {
    const row = this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    return row ? Number(row.value) : 0
  }

  run(sql: string, params?: Params): void {
    try {
      const bound = normalizeParams(params)
      // Without parameters the text may hold several statements, as it could with sql.js.
      if (bound === undefined) this.db.exec(sql)
      else this.statement(sql).run(...bound)
      this.lastError = null
    } catch (err) {
      this.lastError = err as Error
      throw err
    }
  }

  all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
    const bound = normalizeParams(params)
    const rows = this.statement(sql).all(...(bound ?? []))
    // node:sqlite rows have no prototype. Copy them into plain objects like the callers expect.
    return rows.map((r) => ({ ...r }) as T)
  }

  get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
    const bound = normalizeParams(params)
    const row = this.statement(sql).get(...(bound ?? []))
    return row ? ({ ...row } as T) : undefined
  }

  /** Runs fn inside a transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn()
    this.inTransaction = true
    try {
      this.db.exec('BEGIN')
      try {
        const result = fn()
        this.db.exec('COMMIT')
        this.lastError = null
        return result
      } catch (err) {
        // SQLite rolls back on its own for some errors, so only roll back an open transaction.
        // A failed rollback must not hide the error that caused it.
        try {
          if (this.db.isTransaction) this.db.exec('ROLLBACK')
        } catch {
          // Keep the original error.
        }
        throw err
      }
    } catch (err) {
      this.lastError = err as Error
      throw err
    } finally {
      this.inTransaction = false
    }
  }

  /** The last error from a write, if the most recent write failed. */
  get saveError(): Error | null {
    return this.lastError
  }

  /**
   * Moves the write-ahead log into the database file. Committed writes are already durable, so this
   * only keeps the log short. Safe to call often. It never throws.
   */
  flush(): void {
    if (this.closed || !this.filePath) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    } catch (err) {
      this.lastError = err as Error
    }
  }

  close(): void {
    if (this.closed) return
    if (this.filePath) {
      try {
        // Leave one self-contained file behind instead of a file plus a -wal file.
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch (err) {
        this.lastError = err as Error
      }
    }
    this.closed = true
    this.statements.clear()
    this.db.close()
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql)
    if (!stmt) {
      // Dynamic SQL (long IN lists, say) would fill the cache with one-off statements.
      if (this.statements.size >= STATEMENT_CACHE_LIMIT) this.statements.clear()
      stmt = this.db.prepare(sql)
      this.statements.set(sql, stmt)
    }
    return stmt
  }
}

function normalizeParams(params?: Params): Bindings | undefined {
  if (!params) return undefined
  const fix = (v: SqlValue | boolean | undefined): Bound => {
    if (v === undefined) return null
    if (typeof v === 'boolean') return v ? 1n : 0n
    // node:sqlite binds every JS number as a double, which a TEXT column or an untyped expression
    // would keep as '1.0'. sql.js bound whole numbers as integers, so do the same through bigint.
    if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v)
    return v
  }
  if (Array.isArray(params)) return params.map(fix)
  // node:sqlite binds bare keys such as { id } to :id, @id or $id.
  const out: Record<string, Bound> = {}
  for (const [k, v] of Object.entries(params)) out[k] = fix(v)
  // The statement methods take the named object as their first argument. Their types only allow it in an overload.
  return [out] as unknown as Bindings
}

/**
 * What function migrations get. They were written for the sql.js Database object, so this offers
 * the same exec, run and prepare calls (step, getAsObject, free) on top of node:sqlite.
 */
export function migrationHandle(db: DatabaseSync): MigrationHandle {
  const handle = {
    exec(sql: string): void {
      db.exec(sql)
    },
    run(sql: string, params?: Params): void {
      const bound = normalizeParams(params)
      if (bound === undefined) db.exec(sql)
      else db.prepare(sql).run(...bound)
    },
    prepare(sql: string) {
      const rows = db.prepare(sql).all()
      let index = -1
      return {
        step: () => ++index < rows.length,
        getAsObject: () => ({ ...rows[index] }),
        free: () => true
      }
    }
  }
  return handle as unknown as MigrationHandle
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
