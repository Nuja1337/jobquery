import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Db, migrationHandle } from './database'
import { MIGRATIONS, type Migration } from './schema'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-db-'))

/** A database file at schema version 10, as an installed app would have it. */
function version10(file: string, setup: (job: (id: string, stage: string, fit: number | null) => void, app: (id: string, jobId: string, status: string, extra?: Record<string, string>) => void) => void): void {
  const raw = new DatabaseSync(file)
  const handle = migrationHandle(raw)
  MIGRATIONS.slice(0, 10).forEach((migration: Migration) => (typeof migration === 'string' ? raw.exec(migration) : migration(handle)))
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '10')").run()
  const job = (id: string, stage: string, fit: number | null) =>
    void raw
      .prepare(
        `INSERT INTO jobs (id, source, external_id, canonical_key, content_hash, company, company_norm, title, url, description, discovered_at, stage, fit_score, scored_profile_version, updated_at)
         VALUES (?, 'greenhouse', ?, ?, 'h', 'Acme', 'acme', 'Engineer', 'https://example.com', 'Text.', '2026-01-01T00:00:00.000Z', ?, ?, ?, '2026-01-01T00:00:00.000Z')`
      )
      .run(id, id, `greenhouse:acme:${id}`, stage, fit, fit === null ? null : 3)
  const app = (id: string, jobId: string, status: string, extra: Record<string, string> = {}) => {
    const columns = ['id', 'job_id', 'status', 'created_at', 'updated_at', ...Object.keys(extra)]
    raw
      .prepare(`INSERT INTO applications (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(id, jobId, status, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ...Object.values(extra))
  }
  setup(job, app)
  raw.close()
}

describe('migration 11', () => {
  it('marks shortlisted jobs and unsent ready applications for one rescore, and nothing else', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'v10.sqlite')
    version10(file, (job, app) => {
      job('short', 'shortlisted', 80)
      job('short-unscored', 'shortlisted', null)
      job('scored', 'scored', 50)
      job('new', 'new', null)
      job('ready', 'ready', 90)
      app('a-ready', 'ready', 'ready')
      job('ready-clicked', 'ready', 90)
      app('a-clicked', 'ready-clicked', 'ready', { submit_clicked_at: '2026-02-01T00:00:00.000Z' })
      job('ready-mode', 'ready', 90)
      app('a-mode', 'ready-mode', 'ready', { submit_mode: 'auto' })
      job('ready-attention', 'ready', 90)
      app('a-attention', 'ready-attention', 'needs_attention')
      job('applied', 'applied', 92)
      app('a-applied', 'applied', 'submitted', { submitted_at: '2026-02-01T00:00:00.000Z' })
      job('closed', 'closed', 85)
      job('dismissed', 'dismissed', 85)
    })

    const db = await Db.open(file)
    expect(db.schemaVersion).toBe(MIGRATIONS.length)
    const marked = db.all<{ id: string }>('SELECT id FROM jobs WHERE rescore_pending = 1 ORDER BY id').map((r) => r.id)
    expect(marked).toEqual(['ready', 'short'])
    // Scores, stages and versions stay as they were. The new score replaces them later.
    expect(db.get('SELECT stage, fit_score, scored_profile_version FROM jobs WHERE id = :id', { id: 'short' })).toEqual({ stage: 'shortlisted', fit_score: 80, scored_profile_version: 3 })
    expect(db.get('SELECT status FROM applications WHERE id = :id', { id: 'a-ready' })).toEqual({ status: 'ready' })
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('gives existing jobs empty source levels and no minimum years', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'v10.sqlite')
    version10(file, (job) => job('a', 'new', null))
    const db = await Db.open(file)
    expect(db.get('SELECT seniority, min_years, rescore_pending FROM jobs WHERE id = :id', { id: 'a' })).toEqual({ seniority: '[]', min_years: null, rescore_pending: 0 })
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('opens the legacy fixture and keeps its rows unmarked', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'legacy.sqlite')
    fs.copyFileSync(path.join(__dirname, '__fixtures__', 'legacy.sqlite'), file)
    const db = await Db.open(file)
    expect(db.schemaVersion).toBe(MIGRATIONS.length)
    expect(db.get('SELECT title, stage, seniority, min_years, rescore_pending FROM jobs WHERE id = :id', { id: 'legacy-1' })).toEqual({
      title: 'Platform Engineer',
      stage: 'new',
      seniority: '[]',
      min_years: null,
      rescore_pending: 0
    })
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
