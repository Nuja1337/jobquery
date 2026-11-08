import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { contentHash } from '../pipeline/dedupe'
import { Db, migrationHandle } from './database'
import { MIGRATIONS } from './schema'

describe('Db', () => {
  it('runs migrations on a fresh in-memory database', async () => {
    const db = await Db.open(null)
    expect(db.schemaVersion).toBe(MIGRATIONS.length)
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['jobs', 'applications', 'llm_calls', 'llm_cache', 'profile', 'providers']))
  })

  it('binds named params without the colon and converts booleans', async () => {
    const db = await Db.open(null)
    db.run('INSERT INTO settings (key, value) VALUES (:key, :value)', { key: 'a', value: 'x' })
    db.run('INSERT INTO searches (id, source, label, params, enabled) VALUES (:id, :source, :label, :params, :enabled)', {
      id: 's1', source: 'remotive', label: 'test', params: '{}', enabled: false
    })
    expect(db.get<{ value: string }>('SELECT value FROM settings WHERE key = :key', { key: 'a' })?.value).toBe('x')
    expect(db.get<{ enabled: number }>('SELECT enabled FROM searches')?.enabled).toBe(0)
  })

  it('persists to disk and reopens without re-running migrations', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-db-'))
    const file = path.join(dir, 'test.sqlite')
    const db = await Db.open(file)
    db.run("INSERT INTO settings (key, value) VALUES ('k', 'v')")
    db.close()
    const reopened = await Db.open(file)
    expect(reopened.get<{ value: string }>("SELECT value FROM settings WHERE key = 'k'")?.value).toBe('v')
    expect(reopened.schemaVersion).toBe(MIGRATIONS.length)
    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rolls back a failed transaction', async () => {
    const db = await Db.open(null)
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value) VALUES ('t', '1')")
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.get("SELECT * FROM settings WHERE key = 't'")).toBeUndefined()
  })
})

describe('Db on disk', () => {
  const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-db-'))
  const insertJob = (db: Db, id: string) =>
    db.run(
      `INSERT INTO jobs (id, source, external_id, canonical_key, content_hash, company, company_norm, title, url, ats, description, discovered_at, stage, updated_at)
       VALUES (:id, 'greenhouse', :id, :key, 'h', 'Acme', 'acme', 'Engineer', 'https://example.com', 'greenhouse', 'Text.', '2026-01-01T00:00:00.000Z', 'new', '2026-01-01T00:00:00.000Z')`,
      { id, key: `greenhouse:acme:${id}` }
    )

  it('opens a file written by the sql.js version and keeps its rows', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'legacy.sqlite')
    fs.copyFileSync(path.join(__dirname, '__fixtures__', 'legacy.sqlite'), file)
    const db = await Db.open(file)
    expect(db.schemaVersion).toBe(MIGRATIONS.length)
    expect(db.get<{ title: string; company: string }>("SELECT title, company FROM jobs WHERE id = 'legacy-1'")).toEqual({ title: 'Platform Engineer', company: 'Acme' })
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes 20,000 rows in a transaction quickly and a second open sees them after close', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'many.sqlite')
    const db = await Db.open(file)
    const started = performance.now()
    db.transaction(() => {
      for (let i = 0; i < 20_000; i++) insertJob(db, `job-${i}`)
    })
    expect(performance.now() - started).toBeLessThan(5000) // Generous, since the suite runs many files at once. Serial inserts would take far longer.
    db.close()
    const reopened = await Db.open(file)
    expect(reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')?.n).toBe(20_000)
    reopened.close()
    expect(fs.existsSync(`${file}-wal`)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('makes a committed write visible to another connection before close, and flush never throws', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'live.sqlite')
    const db = await Db.open(file)
    db.run("INSERT INTO settings (key, value) VALUES ('live', '1')")
    db.flush()
    const other = await Db.open(file)
    expect(other.get<{ value: string }>("SELECT value FROM settings WHERE key = 'live'")?.value).toBe('1')
    other.close()
    db.close()
    expect(() => db.flush()).not.toThrow()
    expect(() => db.close()).not.toThrow()
    expect(db.saveError).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates the folder for a new database file', async () => {
    const dir = tempDir()
    const db = await Db.open(path.join(dir, 'nested', 'deeper', 'new.sqlite'))
    expect(db.schemaVersion).toBe(MIGRATIONS.length)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a file that is not a database', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'bad.sqlite')
    fs.writeFileSync(file, 'not a database, but long enough that SQLite does not read it as an empty file '.repeat(5))
    await expect(Db.open(file)).rejects.toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('Db values', () => {
  it('binds booleans and undefined in positional and named params', async () => {
    const db = await Db.open(null)
    expect(db.get('SELECT ? AS a, ? AS b, typeof(?) AS t, typeof(?) AS u', [true, undefined, 5, 2.5])).toEqual({ a: 1, b: null, t: 'integer', u: 'real' })
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['count', 7 as unknown as string])
    expect(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'count'")?.value).toBe('7')
    db.run('INSERT INTO providers (id, kind, label, base_url, created_at) VALUES (:id, :kind, :label, :base_url, :created_at)', {
      id: 'p', kind: 'openai', label: 'p', base_url: undefined, created_at: 'x'
    })
    expect(db.get<{ base_url: string | null }>("SELECT base_url FROM providers WHERE id = 'p'")?.base_url).toBeNull()
  })

  it('round-trips a Uint8Array and returns plain objects', async () => {
    const db = await Db.open(null)
    db.run('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)')
    db.run('INSERT INTO blobs (id, data) VALUES (:id, :data)', { id: 1, data: new Uint8Array([1, 2, 3]) })
    const row = db.get<{ id: number; data: Uint8Array }>('SELECT * FROM blobs')!
    expect(Array.from(row.data)).toEqual([1, 2, 3])
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
  })

  it('returns COUNT, SUM and length() as numbers', async () => {
    const db = await Db.open(null)
    db.run("INSERT INTO settings (key, value) VALUES ('a', 'xyz'), ('b', 'xy')")
    const row = db.get<{ n: unknown; total: unknown; len: unknown }>("SELECT COUNT(*) AS n, SUM(length(value)) AS total, length('abc') AS len FROM settings")!
    expect(row).toEqual({ n: 2, total: 5, len: 3 })
  })

  it('runs a parameterless run with several statements', async () => {
    const db = await Db.open(null)
    db.run("INSERT INTO settings (key, value) VALUES ('a', '1'); INSERT INTO settings (key, value) VALUES ('b', '2')")
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM settings')?.n).toBe(2)
  })
})

describe('Db transactions', () => {
  it('lets nested calls join the outer transaction and rolls everything back on a throw', async () => {
    const db = await Db.open(null)
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value) VALUES ('outer', '1')")
        db.transaction(() => db.run("INSERT INTO settings (key, value) VALUES ('inner', '1')"))
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.get('SELECT * FROM settings')).toBeUndefined()
    // The failed transaction leaves the database usable.
    expect(db.transaction(() => 7)).toBe(7)
  })

  it('returns the value of fn and commits', async () => {
    const db = await Db.open(null)
    const value = db.transaction(() => {
      db.run("INSERT INTO settings (key, value) VALUES ('k', 'v')")
      return 'done'
    })
    expect(value).toBe('done')
    expect(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'k'")?.value).toBe('v')
  })

  it('reports a failed write through saveError until the next good write', async () => {
    const db = await Db.open(null)
    expect(() => db.run('INSERT INTO no_such_table (x) VALUES (1)')).toThrow()
    expect(db.saveError).toBeInstanceOf(Error)
    db.run("INSERT INTO settings (key, value) VALUES ('k', 'v')")
    expect(db.saveError).toBeNull()
  })
})

describe('migration 3', () => {
  type Row = Partial<Record<string, string | number | null>> & { id: string }

  /** A database file at schema version 2, as an installed app would have it. */
  async function oldDatabase(setup: (insertJob: (row: Row) => void, run: (sql: string, params?: Array<string | number | null>) => void) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-db-'))
    const file = path.join(dir, 'old.sqlite')
    const raw = new DatabaseSync(file)
    const rawRun = (sql: string, params: Array<string | number | null> = []) => void raw.prepare(sql).run(...params)
    raw.exec(MIGRATIONS[0] as string)
    raw.exec(MIGRATIONS[1] as string)
    rawRun("INSERT INTO meta (key, value) VALUES ('schema_version', '2')")
    const insertJob = (row: Row) => {
      const full: Record<string, string | number | null> = {
        source: 'greenhouse',
        external_id: row.id,
        canonical_key: `greenhouse:acme:${row.id}`,
        content_hash: 'old-hash',
        company: 'Acme',
        company_norm: 'acme',
        title: 'Engineer',
        url: 'https://example.com',
        ats: 'greenhouse',
        ats_token: 'acme',
        description: 'Text.',
        discovered_at: '2026-01-01T00:00:00.000Z',
        stage: 'shortlisted',
        updated_at: '2026-02-01T00:00:00.000Z',
        ...row
      }
      const names = Object.keys(full)
      rawRun(`INSERT INTO jobs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((n) => full[n]))
    }
    setup(insertJob, rawRun)
    raw.close()
    const db = await Db.open(file)
    return { db, dir }
  }

  const job = (db: Db, id: string) => db.get<Record<string, string | number | null>>('SELECT * FROM jobs WHERE id = :id', { id })!

  it('adds the new columns and fills them from what is stored', async () => {
    const { db, dir } = await oldDatabase((insertJob, run) => {
      insertJob({ id: 'a', updated_at: '2026-03-03T00:00:00.000Z' })
      insertJob({ id: 'gone1', stage: 'dismissed', updated_at: '2026-04-01T00:00:00.000Z' })
      insertJob({ id: 'gone2', stage: 'dismissed', updated_at: '2026-04-01T00:00:00.000Z' })
      run("INSERT INTO events (id, at, type, job_id, message) VALUES ('e1', '2026-03-10T00:00:00.000Z', 'dismissed', 'gone1', 'x')")
    })
    expect(db.schemaVersion).toBe(MIGRATIONS.length)
    expect(job(db, 'a')).toMatchObject({ last_seen_at: '2026-03-03T00:00:00.000Z', dismissed_at: null })
    expect(job(db, 'gone1').dismissed_at).toBe('2026-03-10T00:00:00.000Z')
    expect(job(db, 'gone2').dismissed_at).toBe('2026-04-01T00:00:00.000Z')
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('re-keys board postings by token and leaves aggregator keys alone', async () => {
    const { db, dir } = await oldDatabase((insertJob) => {
      insertJob({ id: 'renamed', canonical_key: 'greenhouse:acme old name:7', external_id: '7', company: 'Acme Robotics', company_norm: 'acme robotics' })
      insertJob({ id: 'agg', source: 'remoteok', ats: 'unknown', ats_token: null, canonical_key: 'remoteok:acme:5', external_id: '5' })
    })
    expect(job(db, 'renamed').canonical_key).toBe('greenhouse:acme:7')
    expect(job(db, 'agg').canonical_key).toBe('remoteok:acme:5')
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the oldest row when a rename stored a board twice, and marks the other a duplicate', async () => {
    const { db, dir } = await oldDatabase((insertJob) => {
      insertJob({ id: 'first', external_id: '1', canonical_key: 'greenhouse:acme:1', discovered_at: '2026-01-01T00:00:00.000Z' })
      insertJob({ id: 'second', external_id: '1', canonical_key: 'greenhouse:acme robotics:1', company: 'Acme Robotics', company_norm: 'acme robotics', discovered_at: '2026-06-01T00:00:00.000Z' })
      insertJob({ id: 'copy', source: 'remoteok', ats: 'unknown', ats_token: null, canonical_key: 'remoteok:acme:9', external_id: '9', stage: 'duplicate', dup_of: 'second' })
    })
    expect(job(db, 'first')).toMatchObject({ canonical_key: 'greenhouse:acme:1', stage: 'shortlisted', dup_of: null })
    expect(job(db, 'second')).toMatchObject({ stage: 'duplicate', dup_of: 'first', canonical_key: 'greenhouse:acme:1~second' })
    // A duplicate that pointed at the row that lost now points at the one that stayed.
    expect(job(db, 'copy').dup_of).toBe('first')
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')?.n).toBe(3)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the row that has an application, even when it is newer, and deletes nothing', async () => {
    const { db, dir } = await oldDatabase((insertJob, run) => {
      insertJob({ id: 'first', external_id: '1', canonical_key: 'greenhouse:acme:1', discovered_at: '2026-01-01T00:00:00.000Z' })
      insertJob({ id: 'second', external_id: '1', canonical_key: 'greenhouse:acme robotics:1', company: 'Acme Robotics', company_norm: 'acme robotics', discovered_at: '2026-06-01T00:00:00.000Z', stage: 'ready', starred: 1 })
      run("INSERT INTO applications (id, job_id, status, created_at, updated_at) VALUES ('app', 'second', 'ready', '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z')")
    })
    expect(job(db, 'second')).toMatchObject({ canonical_key: 'greenhouse:acme:1', stage: 'ready', dup_of: null })
    expect(job(db, 'first')).toMatchObject({ stage: 'duplicate', dup_of: 'second' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM applications')?.n).toBe(1)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('never marks a row with an application as a duplicate when both have one', async () => {
    const { db, dir } = await oldDatabase((insertJob, run) => {
      insertJob({ id: 'first', external_id: '1', canonical_key: 'greenhouse:acme:1' })
      insertJob({ id: 'second', external_id: '1', canonical_key: 'greenhouse:acme robotics:1', company: 'Acme Robotics', company_norm: 'acme robotics', discovered_at: '2026-06-01T00:00:00.000Z', stage: 'preparing' })
      run("INSERT INTO applications (id, job_id, status, created_at, updated_at) VALUES ('a1', 'first', 'draft', '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z')")
      run("INSERT INTO applications (id, job_id, status, created_at, updated_at) VALUES ('a2', 'second', 'draft', '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z')")
    })
    expect(job(db, 'first').canonical_key).toBe('greenhouse:acme:1')
    expect(job(db, 'second')).toMatchObject({ stage: 'preparing', canonical_key: 'greenhouse:acme:1~second' })
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('recomputes content hashes over the whole description and releases duplicates that matched on the first 600 characters', async () => {
    const opening = 'Shared opening about the company and the team. '.repeat(30)
    const { db, dir } = await oldDatabase((insertJob) => {
      insertJob({ id: 'a', external_id: '8154295', canonical_key: 'greenhouse:acme:8154295', description: `${opening} Payments team.` })
      insertJob({ id: 'b', external_id: '8190042', canonical_key: 'greenhouse:acme:8190042', description: `${opening} Risk team.`, stage: 'duplicate', dup_of: 'a' })
      insertJob({ id: 'same', external_id: '5', canonical_key: 'greenhouse:acme:5', description: `${opening} Payments team.`, stage: 'duplicate', dup_of: 'a' })
      insertJob({ id: 'board2', source: 'lever', canonical_key: 'lever:acme:5', external_id: '5', ats: 'lever', description: `${opening} Payments team.`, stage: 'duplicate', dup_of: 'a' })
    })
    expect(job(db, 'a').content_hash).toBe(contentHash({ company: 'Acme', title: 'Engineer', description: `${opening} Payments team.` }))
    expect(job(db, 'b')).toMatchObject({ stage: 'new', dup_of: null })
    expect(job(db, 'same')).toMatchObject({ stage: 'duplicate', dup_of: 'a' })
    expect(job(db, 'board2')).toMatchObject({ stage: 'duplicate', dup_of: 'a' })
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('migration 4', () => {
  it('adds the free-tier columns to a version 3 database and marks local providers free', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-db-'))
    const file = path.join(dir, 'v3.sqlite')
    const raw = new DatabaseSync(file)
    const rawRun = (sql: string, params: Array<string | number | null> = []) => void raw.prepare(sql).run(...params)
    raw.exec(MIGRATIONS[0] as string)
    raw.exec(MIGRATIONS[1] as string)
    ;(MIGRATIONS[2] as (db: unknown) => void)(migrationHandle(raw))
    rawRun("INSERT INTO meta (key, value) VALUES ('schema_version', '3')")
    const provider = (id: string, kind: string, baseUrl: string | null) =>
      rawRun("INSERT INTO providers (id, kind, label, base_url, created_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')", [id, kind, id, baseUrl])
    provider('ollama', 'ollama', null)
    provider('lmstudio', 'openai_compatible', 'http://localhost:1234/v1')
    provider('loopback', 'openai_compatible', 'http://127.0.0.1:8080/v1')
    provider('openai', 'openai', null)
    provider('groq', 'openai_compatible', 'https://api.groq.com/openai/v1')
    provider('not-local', 'openai_compatible', 'https://localhost.example.com/v1')
    rawRun(
      "INSERT INTO llm_calls (id, at, task, stage, provider_kind, model) VALUES ('c1', '2026-01-02T00:00:00.000Z', 'triage', 'triage', 'ollama', 'llama'), ('c2', '2026-01-02T00:00:00.000Z', 'triage', 'triage', 'openai', 'gpt-5')"
    )
    rawRun(
      "INSERT INTO jobs (id, source, external_id, canonical_key, content_hash, company, company_norm, title, url, description, discovered_at, stage, updated_at) VALUES ('j1', 'greenhouse', '1', 'k1', 'h', 'Acme', 'acme', 'Engineer', 'https://example.com', 'Text.', '2026-01-01T00:00:00.000Z', 'new', '2026-01-01T00:00:00.000Z')"
    )
    raw.close()

    const db = await Db.open(file)
    expect(db.schemaVersion).toBe(MIGRATIONS.length)
    const billing = Object.fromEntries(db.all<{ id: string; billing: string }>('SELECT id, billing FROM providers').map((r) => [r.id, r.billing]))
    // Only Ollama becomes free. A local address can be a proxy to a paid API, so it stays paid.
    expect(billing).toEqual({ ollama: 'free', lmstudio: 'paid', loopback: 'paid', openai: 'paid', groq: 'paid', 'not-local': 'paid' })
    expect(db.get('SELECT requests_per_minute AS m, requests_per_day AS d FROM providers WHERE id = :id', { id: 'groq' })).toEqual({ m: null, d: null })
    expect(db.all('SELECT id, provider_id, free FROM llm_calls ORDER BY id')).toEqual([
      { id: 'c1', provider_id: null, free: 1 },
      { id: 'c2', provider_id: null, free: 0 }
    ])
    expect(db.get<{ triage_failures: number }>("SELECT triage_failures FROM jobs WHERE id = 'j1'")?.triage_failures).toBe(0)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('gives a fresh database the same columns and defaults', async () => {
    const db = await Db.open(null)
    db.run("INSERT INTO providers (id, kind, label, created_at) VALUES ('p', 'openai', 'p', 'x')")
    expect(db.get('SELECT billing, requests_per_minute AS m, requests_per_day AS d FROM providers')).toEqual({ billing: 'paid', m: null, d: null })
    db.run("INSERT INTO llm_calls (id, at, task, stage, provider_kind, model) VALUES ('c', 'x', 't', 's', 'openai', 'm')")
    expect(db.get('SELECT provider_id, free FROM llm_calls')).toEqual({ provider_id: null, free: 0 })
  })
})
