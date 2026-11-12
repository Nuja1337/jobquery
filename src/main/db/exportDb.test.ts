import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from './database'
import { exportDatabaseCopy, isLiveDatabaseFile } from './exportDb'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquery-export-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function seeded() {
  const dir = tempDir()
  const dbFile = path.join(dir, 'jobquery.sqlite')
  const db = await Db.open(dbFile)
  db.run("INSERT INTO providers (id, kind, label, api_key_enc, created_at) VALUES ('p1', 'anthropic', 'Claude', 'enc:TOPSECRETKEYBYTES', '2026-01-01T00:00:00.000Z')")
  db.run("INSERT INTO searches (id, source, label, params) VALUES ('s1', 'adzuna', 'Adzuna', :p)", {
    p: JSON.stringify({ what: 'engineer', app_id: 'APPIDSECRET', app_key: 'APPKEYSECRET' })
  })
  db.run("INSERT INTO settings (key, value) VALUES ('budget', :v)", { v: '{"maxTriagePerDay":5}' })
  return { dir, dbFile, db }
}

describe('exportDatabaseCopy', () => {
  it('writes a readable copy while the database is open', async () => {
    const { dir, dbFile, db } = await seeded()
    const target = path.join(dir, 'out', 'backup.sqlite')
    expect(exportDatabaseCopy(db, dbFile, target)).toBe(path.resolve(target))

    const copy = new DatabaseSync(target)
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({ value: String(db.schemaVersion) })
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'budget'").get()).toMatchObject({ value: '{"maxTriagePerDay":5}' })
    expect(copy.prepare('SELECT id, label FROM providers').get()).toMatchObject({ id: 'p1', label: 'Claude' })
    copy.close()
    // The live database still works.
    expect(db.get("SELECT label FROM providers WHERE id = 'p1'")).toEqual({ label: 'Claude' })
    db.close()
  })

  it('removes stored provider keys and search credentials from the copy, bytes included', async () => {
    const { dir, dbFile, db } = await seeded()
    const target = path.join(dir, 'backup.sqlite')
    exportDatabaseCopy(db, dbFile, target)
    const copy = new DatabaseSync(target)
    expect(copy.prepare('SELECT api_key_enc FROM providers').get()).toMatchObject({ api_key_enc: null })
    expect(JSON.parse((copy.prepare('SELECT params FROM searches').get() as { params: string }).params)).toEqual({ what: 'engineer', app_id: '', app_key: '' })
    copy.close()
    const bytes = fs.readFileSync(target).toString('latin1')
    for (const secret of ['TOPSECRETKEYBYTES', 'APPIDSECRET', 'APPKEYSECRET']) expect(bytes).not.toContain(secret)
    // The live database keeps its keys.
    expect(db.get('SELECT api_key_enc FROM providers')).toEqual({ api_key_enc: 'enc:TOPSECRETKEYBYTES' })
    db.close()
  })

  it('refuses the live database and its side files, and changes nothing', async () => {
    const { dbFile, db } = await seeded()
    for (const suffix of ['', '-wal', '-shm']) {
      expect(() => exportDatabaseCopy(db, dbFile, `${dbFile}${suffix}`)).toThrow(/file JobQuery is using/)
    }
    // A different spelling of the same path is the same file.
    expect(() => exportDatabaseCopy(db, dbFile, path.join(path.dirname(dbFile), 'sub', '..', path.basename(dbFile)))).toThrow(/file JobQuery is using/)
    expect(isLiveDatabaseFile(dbFile, path.join(path.dirname(dbFile), 'other.sqlite'))).toBe(false)
    expect(db.get("SELECT label FROM providers WHERE id = 'p1'")).toEqual({ label: 'Claude' })
    db.close()
  })

  it('replaces an earlier copy and leaves no partial file when it fails', async () => {
    const { dir, dbFile, db } = await seeded()
    const target = path.join(dir, 'backup.sqlite')
    fs.writeFileSync(target, 'old copy')
    exportDatabaseCopy(db, dbFile, target)
    const copy = new DatabaseSync(target)
    expect(copy.prepare('SELECT COUNT(*) AS n FROM providers').get()).toMatchObject({ n: 1 })
    copy.close()
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.partial'))).toEqual([])

    // A target below a path that is a file can't be made.
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'x')
    expect(() => exportDatabaseCopy(db, dbFile, path.join(blocker, 'x.sqlite'))).toThrow()
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.partial'))).toEqual([])
    db.close()
  })
})
