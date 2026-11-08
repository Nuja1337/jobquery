import { describe, expect, it } from 'vitest'
import type { FitAssessment, JobStage } from '@shared/types'
import { ingestRaw } from '../pipeline/ingest'
import { makeRaw, makeTestEnv } from '../testing'
import { runRetention } from './retention'

const DAY = 86_400_000
const NOW = new Date('2026-11-07T12:00:00.000Z')
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString()

const fit: FitAssessment = { score: 40, bucket: 'weak', summary: 's', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }

async function setup() {
  const { ctx } = await makeTestEnv()
  /** Stores a job, then sets its stage and age the way a long-running install would have them. */
  const add = (externalId: string, stage: JobStage, days: number, extra: Partial<Parameters<typeof makeRaw>[0]> = {}) => {
    const job = ingestRaw(ctx, makeRaw({ externalId, description: `Unique description for ${externalId}`, title: `Role ${externalId}`, ...extra })).job
    ctx.db.run('UPDATE jobs SET stage = :stage, discovered_at = :at, last_seen_at = :at WHERE id = :id', { id: job.id, stage, at: ago(days) })
    return job.id
  }
  const exists = (id: string) => ctx.jobs.get(id) !== null
  return { ctx, add, exists }
}

describe('retention of jobs the free rules dropped', () => {
  it('deletes old filtered and prescored jobs and keeps recent ones', async () => {
    const { add, exists, ctx } = await setup()
    const oldFiltered = add('1', 'filtered_out', 61)
    const oldPrescored = add('2', 'prescored_out', 90)
    const recent = add('3', 'filtered_out', 59)
    const oldNew = add('4', 'new', 200)
    const report = runRetention(ctx.db, NOW)
    expect(report.jobsDeleted).toBe(2)
    expect(exists(oldFiltered)).toBe(false)
    expect(exists(oldPrescored)).toBe(false)
    expect(exists(recent)).toBe(true)
    expect(exists(oldNew)).toBe(true)
  })

  it('keeps a job that has an application or a fit score', async () => {
    const { add, exists, ctx } = await setup()
    const withApp = add('1', 'filtered_out', 100)
    ctx.applications.create(withApp)
    ctx.db.run("UPDATE jobs SET stage = 'filtered_out' WHERE id = :id", { id: withApp })
    const scored = add('2', 'prescored_out', 100)
    ctx.jobs.saveFit(scored, fit, 1)
    const plain = add('3', 'prescored_out', 100)
    runRetention(ctx.db, NOW)
    expect(exists(withApp)).toBe(true)
    expect(exists(scored)).toBe(true)
    expect(exists(plain)).toBe(false)
  })

  it('keeps a starred job, and an original that has a starred duplicate', async () => {
    const { add, exists, ctx } = await setup()
    const starredFiltered = add('1', 'filtered_out', 100)
    const starredPrescored = add('2', 'prescored_out', 100)
    ctx.db.run('UPDATE jobs SET starred = 1 WHERE id IN (:a, :b)', { a: starredFiltered, b: starredPrescored })
    const plain = add('3', 'filtered_out', 100)
    const original = add('4', 'filtered_out', 100)
    const copy = add('5', 'duplicate', 100)
    ctx.jobs.markDuplicate(copy, original)
    ctx.db.run('UPDATE jobs SET starred = 1 WHERE id = :id', { id: copy })
    runRetention(ctx.db, NOW)
    expect(exists(starredFiltered)).toBe(true)
    expect(exists(starredPrescored)).toBe(true)
    expect(exists(plain)).toBe(false)
    expect(exists(original)).toBe(true)
    expect(exists(copy)).toBe(true)
  })

  it('deletes the duplicate rows of a deleted job, and keeps an original that a kept duplicate points at', async () => {
    const { add, exists, ctx } = await setup()
    const original = add('1', 'filtered_out', 100)
    const copy = add('2', 'duplicate', 100)
    ctx.jobs.markDuplicate(copy, original)
    const heldOriginal = add('3', 'filtered_out', 100)
    const heldCopy = add('4', 'duplicate', 100)
    ctx.jobs.markDuplicate(heldCopy, heldOriginal)
    ctx.jobs.saveFit(heldCopy, fit, 1)
    const otherCopy = add('5', 'duplicate', 100)
    ctx.jobs.markDuplicate(otherCopy, heldOriginal)
    runRetention(ctx.db, NOW)
    expect(exists(original)).toBe(false)
    expect(exists(copy)).toBe(false)
    expect(exists(heldOriginal)).toBe(true)
    expect(exists(heldCopy)).toBe(true)
    expect(exists(otherCopy)).toBe(true)
  })
})

describe('retention of old descriptions', () => {
  const long = 'x'.repeat(5000)

  it('cuts the description of an old closed job and keeps the dedupe columns', async () => {
    const { add, ctx } = await setup()
    const id = add('1', 'closed', 100, { description: long })
    const before = ctx.db.get<{ content_hash: string; canonical_key: string }>('SELECT content_hash, canonical_key FROM jobs WHERE id = :id', { id })!
    const report = runRetention(ctx.db, NOW)
    expect(report.descriptionsTrimmed).toBe(1)
    const job = ctx.jobs.get(id)!
    expect(job.description).toBe(`${'x'.repeat(2000)} […]`)
    expect(ctx.db.get('SELECT content_hash, canonical_key FROM jobs WHERE id = :id', { id })).toEqual(before)
  })

  it('does not cut the same description twice', async () => {
    const { add, ctx } = await setup()
    add('1', 'closed', 100, { description: long })
    expect(runRetention(ctx.db, NOW).descriptionsTrimmed).toBe(1)
    expect(runRetention(ctx.db, NOW).descriptionsTrimmed).toBe(0)
  })

  it('leaves short descriptions, recent jobs and jobs with an application alone', async () => {
    const { add, ctx } = await setup()
    const short = add('1', 'closed', 100, { description: 'short text' })
    const recent = add('2', 'closed', 10, { description: long })
    const withApp = add('3', 'closed', 100, { description: long })
    ctx.applications.create(withApp)
    ctx.db.run("UPDATE jobs SET stage = 'closed' WHERE id = :id", { id: withApp })
    const live = add('4', 'shortlisted', 100, { description: long })
    expect(runRetention(ctx.db, NOW).descriptionsTrimmed).toBe(0)
    expect(ctx.jobs.get(short)!.description).toBe('short text')
    expect(ctx.jobs.get(recent)!.description).toBe(long)
    expect(ctx.jobs.get(withApp)!.description).toBe(long)
    expect(ctx.jobs.get(live)!.description).toBe(long)
  })

  it('cuts a scored job only when no source has listed it for 60 days', async () => {
    const { add, ctx } = await setup()
    const stale = add('1', 'scored', 100, { description: long })
    const listed = add('2', 'scored', 100, { description: long })
    ctx.db.run('UPDATE jobs SET last_seen_at = :at WHERE id = :id', { id: listed, at: ago(2) })
    expect(runRetention(ctx.db, NOW).descriptionsTrimmed).toBe(1)
    expect(ctx.jobs.get(stale)!.description.length).toBe(2004)
    expect(ctx.jobs.get(listed)!.description).toBe(long)
  })
})

describe('retention of events, cache and runs', () => {
  it('deletes old events except submissions and outcomes', async () => {
    const { ctx } = await setup()
    const put = (type: string, days: number) => {
      const e = ctx.events.add(type as 'error', `${type} ${days}`)
      ctx.db.run('UPDATE events SET at = :at WHERE id = :id', { id: e.id, at: ago(days) })
      return e.id
    }
    const oldError = put('error', 200)
    const oldRun = put('run_finished', 181)
    const oldSubmitted = put('submitted', 400)
    const oldOutcome = put('outcome', 400)
    const recent = put('error', 179)
    const report = runRetention(ctx.db, NOW)
    expect(report.eventsDeleted).toBe(2)
    const left = new Set(ctx.db.all<{ id: string }>('SELECT id FROM events').map((r) => r.id))
    expect(left.has(oldError)).toBe(false)
    expect(left.has(oldRun)).toBe(false)
    expect(left.has(oldSubmitted)).toBe(true)
    expect(left.has(oldOutcome)).toBe(true)
    expect(left.has(recent)).toBe(true)
  })

  it('deletes cached responses older than 90 days', async () => {
    const { ctx } = await setup()
    const put = (key: string, days: number) =>
      ctx.db.run('INSERT INTO llm_cache (key, task, value, created_at) VALUES (:key, :task, :value, :at)', { key, task: 'triage', value: '{}', at: ago(days) })
    put('old', 91)
    put('fresh', 89)
    const report = runRetention(ctx.db, NOW)
    expect(report.cacheEntriesDeleted).toBe(1)
    expect(ctx.db.all<{ key: string }>('SELECT key FROM llm_cache').map((r) => r.key)).toEqual(['fresh'])
  })

  it('deletes runs older than 180 days', async () => {
    const { ctx } = await setup()
    const old = ctx.runs.start('manual')
    const fresh = ctx.runs.start('manual')
    ctx.db.run('UPDATE runs SET started_at = :at WHERE id = :id', { id: old.id, at: ago(181) })
    ctx.db.run('UPDATE runs SET started_at = :at WHERE id = :id', { id: fresh.id, at: ago(179) })
    const report = runRetention(ctx.db, NOW)
    expect(report.runsDeleted).toBe(1)
    expect(ctx.db.all<{ id: string }>('SELECT id FROM runs').map((r) => r.id)).toEqual([fresh.id])
  })

  it('reports nothing to do on an empty database', async () => {
    const { ctx } = await setup()
    expect(runRetention(ctx.db, NOW)).toEqual({ jobsDeleted: 0, descriptionsTrimmed: 0, eventsDeleted: 0, cacheEntriesDeleted: 0, runsDeleted: 0 })
  })
})
