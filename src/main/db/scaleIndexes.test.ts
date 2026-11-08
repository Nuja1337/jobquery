import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { makeRaw, makeTestEnv } from '../testing'
import { Db, migrationHandle } from './database'
import { MIGRATIONS, type Migration } from './schema'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-scale-'))
const indexNames = (db: Db) => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'applications'").map((r) => r.name)

describe('migration 12', () => {
  it('adds the two indexes to a version 11 database and keeps its rows', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'v11.sqlite')
    const raw = new DatabaseSync(file)
    const handle = migrationHandle(raw)
    MIGRATIONS.slice(0, 11).forEach((migration: Migration) => (typeof migration === 'string' ? raw.exec(migration) : migration(handle)))
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '11')").run()
    raw
      .prepare(
        `INSERT INTO jobs (id, source, external_id, canonical_key, content_hash, company, company_norm, title, url, description, discovered_at, stage, updated_at)
         VALUES ('j1', 'greenhouse', 'j1', 'greenhouse:acme:j1', 'h', 'Acme', 'acme', 'Engineer', 'https://example.com', 'Text.', '2026-01-01T00:00:00.000Z', 'ready', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    raw.prepare("INSERT INTO applications (id, job_id, status, created_at, updated_at) VALUES ('a1', 'j1', 'ready', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run()
    raw.close()

    const db = await Db.open(file)
    expect(db.schemaVersion).toBe(MIGRATIONS.length)
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(12)
    expect(indexNames(db)).toEqual(expect.arrayContaining(['idx_applications_created_at', 'idx_applications_submit_clicked']))
    expect(db.get('SELECT id, status FROM applications')).toEqual({ id: 'a1', status: 'ready' })
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does nothing when the indexes already exist', async () => {
    const db = await Db.open(null)
    const sql = MIGRATIONS[11] as string
    expect(() => db.run(sql)).not.toThrow()
    expect(indexNames(db).filter((n) => n === 'idx_applications_created_at')).toHaveLength(1)
    db.close()
  })
})

describe('countSubmittedSince', () => {
  const OLD = '2026-01-01T00:00:00.000Z'
  const SINCE = '2026-06-01T00:00:00.000Z'
  const NEW = '2026-06-02T00:00:00.000Z'
  const NEWER = '2026-06-03T00:00:00.000Z'
  const OR_QUERY = 'SELECT COUNT(*) AS n FROM applications WHERE submitted_at >= :since OR submit_clicked_at >= :since'

  it('gives the same count as the single OR query on a seeded database', async () => {
    const { ctx } = await makeTestEnv()
    // Every combination of the two times: empty, before, after, and both after.
    const times: Array<string | null> = [null, OLD, NEW, NEWER]
    let n = 0
    for (const submittedAt of times) {
      for (const clickedAt of times) {
        n += 1
        const { job } = ctx.jobs.upsertRaw(makeRaw({ externalId: `c${n}`, company: `Co${n}` }), null)
        const app = ctx.applications.create(job.id)
        ctx.db.run('UPDATE applications SET submitted_at = :s, submit_clicked_at = :c WHERE id = :id', { s: submittedAt, c: clickedAt, id: app.id })
      }
    }
    const old = ctx.db.get<{ n: number }>(OR_QUERY, { since: SINCE })!.n
    expect(old).toBe(12)
    expect(ctx.applications.countSubmittedSince(SINCE)).toBe(old)
    // The boundary counts, and a later cut leaves out earlier rows.
    for (const since of [NEW, NEWER, '2027-01-01T00:00:00.000Z']) {
      expect(ctx.applications.countSubmittedSince(since)).toBe(ctx.db.get<{ n: number }>(OR_QUERY, { since })!.n)
    }
    expect(ctx.applications.countSubmittedSince('2027-01-01T00:00:00.000Z')).toBe(0)
  })

  it('uses the indexes for both counts and the created count', async () => {
    const { ctx } = await makeTestEnv()
    const plan = (sql: string) =>
      ctx.db
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, { since: SINCE })
        .map((r) => r.detail)
        .join(' ')
    expect(plan('SELECT COUNT(*) AS n FROM applications WHERE submitted_at >= :since')).toMatch(/idx_applications_submitted/)
    expect(plan('SELECT COUNT(*) AS n FROM applications WHERE submit_clicked_at >= :since AND (submitted_at IS NULL OR submitted_at < :since)')).toMatch(/idx_applications_submit_clicked/)
    expect(plan('SELECT COUNT(*) AS n FROM applications WHERE created_at >= :since')).toMatch(/idx_applications_created_at/)
  })
})
