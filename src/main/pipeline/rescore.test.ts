import { describe, expect, it } from 'vitest'
import type { FitAssessment, SubmitResult } from '@shared/types'
import { type TestEnv, makeProfile, makeRaw, makeTestEnv } from '../testing'
import { Pipeline } from './orchestrator'

// Decision 8: jobs scored on cut-down postings are scored once more, through the normal score step.

const OLD_FIT: FitAssessment = { score: 95, bucket: 'perfect', summary: 'Old score.', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }
const ok = (): SubmitResult => ({ ok: true, status: 'submitted', message: 'Sent.', screenshotPath: null })
const signal = () => new AbortController().signal

async function setup(options: Parameters<typeof makeTestEnv>[0] = {}) {
  const env = await makeTestEnv(options)
  env.ctx.profile.save(makeProfile())
  env.ctx.settings.update({ thresholds: { shortlistScore: 70, autoSubmitScore: 85 }, autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
  const version = env.ctx.profile.get().version
  const mark = (id: string) => env.ctx.db.run('UPDATE jobs SET rescore_pending = 1 WHERE id = :id', { id })
  /** A job scored 95 on an old posting, marked for the rescore (what migration 11 does). */
  const shortlisted = (name: string, extra: Record<string, unknown> = {}) => {
    const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: name, title: `Engineer ${name}`, company: `Co ${name}`, ...extra }), null)
    env.ctx.jobs.saveFit(job.id, OLD_FIT, version, 'shortlisted')
    mark(job.id)
    return job.id
  }
  const ready = (name: string, extra: Record<string, unknown> = {}) => {
    const id = shortlisted(name, extra)
    const app = env.ctx.applications.create(id)
    env.ctx.applications.update(app.id, { status: 'ready', coverLetter: 'Draft letter.' })
    return { jobId: id, appId: app.id }
  }
  const fresh = (name: string) => env.ctx.jobs.upsertRaw(makeRaw({ externalId: name, title: `Engineer ${name}`, company: `Co ${name}` }), null).job
  return { ...env, version, mark, shortlisted, ready, fresh, pipeline: new Pipeline(env.ctx, {}, () => []) }
}

const llmJobs = (env: TestEnv) => env.llmCalls.map((c) => c.prompt)

describe('which jobs the score step picks', () => {
  it('picks marked shortlisted jobs and unsent ready applications, and skips sent, started and closed ones', async () => {
    const env = await setup()
    const short = env.shortlisted('short')
    const { jobId: readyId } = env.ready('ready')
    const clicked = env.ready('clicked')
    env.ctx.db.run('UPDATE applications SET submit_clicked_at = :at WHERE id = :id', { id: clicked.appId, at: new Date().toISOString() })
    const modeSet = env.ready('mode')
    env.ctx.applications.update(modeSet.appId, { submitMode: 'auto' })
    const sent = env.ready('sent')
    env.ctx.applications.update(sent.appId, { status: 'submitted' })
    const closed = env.shortlisted('closed')
    env.ctx.jobs.setStage(closed, 'closed')

    const picked = env.ctx.jobs.listToScore(20).map((j) => j.id)
    expect(picked.sort()).toEqual([short, readyId].sort())
  })

  it('does not let marked jobs crowd out new jobs, and fills free slots with them', async () => {
    const env = await setup()
    const marked = ['m1', 'm2', 'm3', 'm4', 'm5'].map((n) => env.shortlisted(n))
    const newOnes = Array.from({ length: 10 }, (_, i) => env.fresh(`n${i}`).id)
    // A step of 8 keeps a quarter (2) for marked jobs and gives new jobs the other 6.
    const step = env.ctx.jobs.listToScore(8).map((j) => j.id)
    expect(step).toHaveLength(8)
    expect(step.filter((id) => newOnes.includes(id))).toHaveLength(6)
    expect(step.filter((id) => marked.includes(id))).toHaveLength(2)
    // With few new jobs, marked jobs take the free slots.
    for (const id of newOnes.slice(2)) env.ctx.jobs.setStage(id, 'filtered_out')
    const small = env.ctx.jobs.listToScore(8).map((j) => j.id)
    expect(small.filter((id) => newOnes.includes(id))).toHaveLength(2)
    expect(small.filter((id) => marked.includes(id))).toHaveLength(5)
    // A step of 1 never exceeds its limit.
    expect(env.ctx.jobs.listToScore(1)).toHaveLength(1)
    expect(env.ctx.jobs.listToScore(0)).toHaveLength(0)
  })
})

describe('rescoring through the score step', () => {
  it('scores a marked job again under the same limit, saves the score and clears the mark', async () => {
    const env = await setup({ score: (prompt) => (prompt.includes('Engineer low') ? 60 : 88) })
    const keep = env.shortlisted('keep')
    const low = env.shortlisted('low')
    const outcome = await env.pipeline.scoreStep(10, signal())
    expect(outcome.stats.scored).toBe(2)
    // Both were shortlisted before, so neither counts as a new shortlist entry.
    expect(outcome.stats.shortlisted).toBe(0)
    expect(env.ctx.jobs.get(keep)).toMatchObject({ stage: 'shortlisted', fitScore: 88 })
    // A shortlisted job whose new score falls below the line moves to scored, as it would have at first.
    expect(env.ctx.jobs.get(low)).toMatchObject({ stage: 'scored', fitScore: 60 })
    expect(env.ctx.jobs.needsRescore(keep)).toBe(false)
    expect(env.ctx.jobs.scoredProfileVersion(keep)).toBe(env.version)
    // A second step has nothing left to do.
    const before = env.llmCalls.length
    expect((await env.pipeline.scoreStep(10, signal())).stats.scored).toBe(0)
    expect(env.llmCalls).toHaveLength(before)
  })

  it('stays within the step limit when marked and new jobs both wait', async () => {
    const env = await setup()
    for (const n of ['m1', 'm2', 'm3', 'm4']) env.shortlisted(n)
    for (const n of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']) env.fresh(n)
    const outcome = await env.pipeline.scoreStep(4, signal())
    expect(outcome.stats.scored).toBe(4)
    expect(env.llmCalls).toHaveLength(4)
    // New jobs were not held back: at least three of the four calls were for them.
    expect(llmJobs(env).filter((p) => /Engineer n\d/.test(p))).toHaveLength(3)
  })

  it('keeps the stage and the draft of a ready application and changes only the score', async () => {
    const env = await setup({ score: () => 70 })
    const { jobId, appId } = env.ready('r1')
    await env.pipeline.scoreStep(10, signal())
    expect(env.ctx.jobs.get(jobId)).toMatchObject({ stage: 'ready', fitScore: 70 })
    const app = env.ctx.applications.get(appId)!
    expect(app).toMatchObject({ status: 'ready', coverLetter: 'Draft letter.', submitMode: null, submitClickedAt: null })
  })

  it('does not touch sent or closed jobs even if they carry a mark', async () => {
    const env = await setup()
    const sent = env.ready('sent')
    env.ctx.applications.update(sent.appId, { status: 'submitted' })
    const closed = env.shortlisted('closed')
    env.ctx.jobs.setStage(closed, 'closed')
    const outcome = await env.pipeline.scoreStep(10, signal())
    expect(outcome.stats.scored).toBe(0)
    expect(env.llmCalls).toHaveLength(0)
    expect(env.ctx.jobs.get(sent.jobId)).toMatchObject({ stage: 'applied', fitScore: 95 })
    expect(env.ctx.jobs.get(closed)).toMatchObject({ stage: 'closed', fitScore: 95 })
  })

  it('does not score a marked job again after a normal score, such as Score now', async () => {
    const env = await setup()
    const id = env.shortlisted('a')
    const job = env.ctx.jobs.get(id)!
    env.ctx.jobs.saveFit(id, { ...OLD_FIT, score: 80, bucket: 'great' }, env.version)
    expect(env.ctx.jobs.needsRescore(job.id)).toBe(false)
    expect(env.ctx.jobs.listToScore(10)).toHaveLength(0)
  })
})

describe('auto-submit after a rescore', () => {
  it('stops sending a ready application whose new score is below the auto-submit score, and sends one that stays above', async () => {
    const env = await setup({ score: (prompt) => (prompt.includes('Engineer weak') ? 60 : 92) })
    const weak = env.ready('weak')
    const strong = env.ready('strong')
    await env.pipeline.scoreStep(10, signal())
    expect(env.ctx.jobs.get(weak.jobId)).toMatchObject({ stage: 'ready', fitScore: 60 })
    expect(env.ctx.jobs.get(strong.jobId)).toMatchObject({ stage: 'ready', fitScore: 92 })

    const sentIds: string[] = []
    const sender = new Pipeline(env.ctx, {
      submit: async (id) => {
        sentIds.push(id)
        env.ctx.applications.update(id, { status: 'submitted' })
        return ok()
      }
    }, () => [])
    const stats = await sender.run({ discover: false, triage: false, submit: true })
    expect(stats.submitted).toBe(1)
    expect(sentIds).toEqual([strong.appId])
    // The weak one waits in Review with its draft, ready for the owner to send by hand.
    expect(env.ctx.applications.get(weak.appId)).toMatchObject({ status: 'ready', coverLetter: 'Draft letter.' })
  })
})
