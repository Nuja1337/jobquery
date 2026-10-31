import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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
})
