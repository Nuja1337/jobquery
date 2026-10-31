import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { describe, expect, it } from 'vitest'
import { contentHash } from '../pipeline/dedupe'
import { Db } from './database'
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-db-'))
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

describe('Db saving', () => {
  it('schedules a save after a transaction commits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-db-'))
    const file = path.join(dir, 'tx.sqlite')
    const db = await Db.open(file, { saveDelayMs: 20 })
    db.flush()
    db.transaction(() => db.run("INSERT INTO settings (key, value) VALUES ('tx', '1')"))
    await new Promise((r) => setTimeout(r, 120))
    const reopened = await Db.open(file)
    expect(reopened.get<{ value: string }>("SELECT value FROM settings WHERE key = 'tx'")?.value).toBe('1')
    db.close()
    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('saves during a stream of writes instead of waiting for a pause', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-db-'))
    const file = path.join(dir, 'busy.sqlite')
    const db = await Db.open(file, { saveDelayMs: 400 })
    db.flush()
    const started = Date.now()
    // Write every 100ms for 3.6 seconds, so a pause long enough for the normal save never comes.
    while (Date.now() - started < 3600) {
      db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:k, :v)', { k: 'busy', v: String(Date.now()) })
      await new Promise((r) => setTimeout(r, 100))
    }
    const reopened = await Db.open(file)
    expect(reopened.get("SELECT value FROM settings WHERE key = 'busy'")).toBeDefined()
    db.close()
    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }, 10_000)

  it('opens the temp copy when the main file is damaged', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-db-'))
    const file = path.join(dir, 'damaged.sqlite')
    const db = await Db.open(file)
    db.run("INSERT INTO settings (key, value) VALUES ('kept', 'yes')")
    db.close()
    fs.copyFileSync(file, `${file}.tmp`)
    fs.writeFileSync(file, 'not a database')
    const reopened = await Db.open(file)
    expect(reopened.get<{ value: string }>("SELECT value FROM settings WHERE key = 'kept'")?.value).toBe('yes')
    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('a temp file left by a save that failed at the rename', () => {
    async function setup(): Promise<{ dir: string; file: string }> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-db-'))
      const file = path.join(dir, 'main.sqlite')
      const db = await Db.open(file)
      db.run("INSERT INTO settings (key, value) VALUES ('which', 'old')")
      db.close()
      return { dir, file }
    }

    /** A copy of the main file with a different value, standing in for the newest save. */
    async function writeNewerTmp(file: string): Promise<void> {
      const copy = `${file}.copy`
      fs.copyFileSync(file, copy)
      const db = await Db.open(copy)
      db.run("UPDATE settings SET value = 'new' WHERE key = 'which'")
      db.close()
      fs.renameSync(copy, `${file}.tmp`)
    }

    const which = (db: Db) => db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'which'")?.value

    it('is used when it is newer than the main file and intact', async () => {
      const { dir, file } = await setup()
      await writeNewerTmp(file)
      fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
      const db = await Db.open(file)
      expect(which(db)).toBe('new')
      // The next save writes it to the main file.
      db.close()
      const again = await Db.open(file)
      expect(which(again)).toBe('new')
      again.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('is ignored when the main file is newer', async () => {
      const { dir, file } = await setup()
      await writeNewerTmp(file)
      fs.utimesSync(`${file}.tmp`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
      const db = await Db.open(file)
      expect(which(db)).toBe('old')
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('is ignored when it is newer but cut short', async () => {
      const { dir, file } = await setup()
      await writeNewerTmp(file)
      const bytes = fs.readFileSync(`${file}.tmp`)
      fs.writeFileSync(`${file}.tmp`, bytes.subarray(0, Math.floor(bytes.length / 3)))
      fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
      const db = await Db.open(file)
      expect(which(db)).toBe('old')
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })
})

describe('migration 3', () => {
  type Row = Partial<Record<string, string | number | null>> & { id: string }

  /** A database file at schema version 2, as an installed app would have it. */
  async function oldDatabase(setup: (insertJob: (row: Row) => void, run: (sql: string, params?: Array<string | number | null>) => void) => void) {
    const SQL = await initSqlJs()
    const raw = new SQL.Database()
    raw.exec(MIGRATIONS[0] as string)
    raw.exec(MIGRATIONS[1] as string)
    raw.run("INSERT INTO meta (key, value) VALUES ('schema_version', '2')")
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
      raw.run(`INSERT INTO jobs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((n) => full[n]))
    }
    setup(insertJob, (sql, params) => raw.run(sql, params))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-db-'))
    const file = path.join(dir, 'old.sqlite')
    fs.writeFileSync(file, raw.export())
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
    const SQL = await initSqlJs()
    const raw = new SQL.Database()
    raw.exec(MIGRATIONS[0] as string)
    raw.exec(MIGRATIONS[1] as string)
    ;(MIGRATIONS[2] as (db: typeof raw) => void)(raw)
    raw.run("INSERT INTO meta (key, value) VALUES ('schema_version', '3')")
    const provider = (id: string, kind: string, baseUrl: string | null) =>
      raw.run("INSERT INTO providers (id, kind, label, base_url, created_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')", [id, kind, id, baseUrl])
    provider('ollama', 'ollama', null)
    provider('lmstudio', 'openai_compatible', 'http://localhost:1234/v1')
    provider('loopback', 'openai_compatible', 'http://127.0.0.1:8080/v1')
    provider('openai', 'openai', null)
    provider('groq', 'openai_compatible', 'https://api.groq.com/openai/v1')
    provider('not-local', 'openai_compatible', 'https://localhost.example.com/v1')
    raw.run(
      "INSERT INTO llm_calls (id, at, task, stage, provider_kind, model) VALUES ('c1', '2026-01-02T00:00:00.000Z', 'triage', 'triage', 'ollama', 'llama'), ('c2', '2026-01-02T00:00:00.000Z', 'triage', 'triage', 'openai', 'gpt-5')"
    )
    raw.run(
      "INSERT INTO jobs (id, source, external_id, canonical_key, content_hash, company, company_norm, title, url, description, discovered_at, stage, updated_at) VALUES ('j1', 'greenhouse', '1', 'k1', 'h', 'Acme', 'acme', 'Engineer', 'https://example.com', 'Text.', '2026-01-01T00:00:00.000Z', 'new', '2026-01-01T00:00:00.000Z')"
    )
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-db-'))
    const file = path.join(dir, 'v3.sqlite')
    fs.writeFileSync(file, raw.export())

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
