import { describe, expect, it, vi } from 'vitest'
import { makeRaw, makeTestEnv } from '../testing'
import { Pipeline } from './orchestrator'

const FIT = { score: 95, bucket: 'perfect' as const, summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }

async function setup(cap: number) {
  const env = await makeTestEnv()
  env.ctx.settings.update({
    preferences: { companyCooldownDays: 90 },
    thresholds: { autoSubmitScore: 85 },
    autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: cap }
  })
  const addReady = (company: string, pending = false) => {
    const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: `x-${company}-${Math.random()}`, company }), null)
    env.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    const app = env.ctx.applications.create(job.id)
    env.ctx.applications.update(app.id, { status: 'ready' })
    if (pending) env.ctx.db.run('UPDATE jobs SET rescore_pending = 1 WHERE id = :id', { id: job.id })
    return app.id
  }
  const sent: string[] = []
  const pipeline = new Pipeline(env.ctx, {
    submit: async (id) => {
      sent.push(id)
      env.ctx.applications.update(id, { status: 'submitted' })
      env.ctx.db.run('UPDATE applications SET submitted_at = :at WHERE id = :id', { at: new Date().toISOString(), id })
      return { ok: true, status: 'submitted', message: 'Sent.', screenshotPath: null }
    }
  })
  return { ...env, addReady, pipeline, sent, count: vi.spyOn(env.ctx.applications, 'countSubmittedSince') }
}

describe('submit step daily count', () => {
  it('reads the count once for the step and once after each attempt, not once for each candidate', async () => {
    const env = await setup(50)
    // Twelve applications to one company. The first goes out, and the other eleven are skipped.
    for (let i = 0; i < 12; i++) env.addReady('Same Co')
    const out = await env.pipeline.submitStep(5, new AbortController().signal, { loop: true })
    expect(env.sent).toHaveLength(1)
    expect(out.attempts).toHaveLength(1)
    // One read before the loop and one after the attempt.
    expect(env.count).toHaveBeenCalledTimes(2)
  })

  it('stops at the daily cap, counting what this step sent', async () => {
    const env = await setup(2)
    for (const company of ['A', 'B', 'C', 'D']) env.addReady(company)
    const out = await env.pipeline.submitStep(10, new AbortController().signal)
    expect(env.sent).toHaveLength(2)
    expect(out.attempts).toHaveLength(2)
  })

  it('sees a send made by someone else while an attempt was running', async () => {
    const env = await setup(2)
    const [a, b, c] = ['A', 'B', 'C'].map((company) => env.addReady(company))
    const other = env.ctx.jobs.upsertRaw(makeRaw({ externalId: 'manual', company: 'Manual Co' }), null).job
    const manual = env.ctx.applications.create(other.id)
    const pipeline = new Pipeline(env.ctx, {
      submit: async (id) => {
        env.sent.push(id)
        env.ctx.applications.update(id, { status: 'submitted' })
        env.ctx.db.run('UPDATE applications SET submitted_at = :at WHERE id = :id', { at: new Date().toISOString(), id })
        // A manual submit lands during the first attempt, which fills the cap of two.
        if (env.sent.length === 1) env.ctx.db.run('UPDATE applications SET submitted_at = :at WHERE id = :id', { at: new Date().toISOString(), id: manual.id })
        return { ok: true, status: 'submitted', message: 'Sent.', screenshotPath: null }
      }
    })
    await pipeline.submitStep(10, new AbortController().signal)
    expect(env.sent).toEqual([a])
    expect(env.ctx.applications.get(b)?.status).toBe('ready')
    expect(env.ctx.applications.get(c)?.status).toBe('ready')
  })

  it('still skips a job that is waiting for a rescore', async () => {
    const env = await setup(10)
    const held = env.addReady('Held Co', true)
    const free = env.addReady('Free Co')
    await env.pipeline.submitStep(5, new AbortController().signal)
    expect(env.sent).toEqual([free])
    expect(env.ctx.applications.get(held)?.status).toBe('ready')
  })
})
