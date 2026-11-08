import { describe, expect, it } from 'vitest'
import { EMPTY_PROFILE } from '@shared/defaults'
import type { FormField, PreparedAnswer, Profile } from '@shared/types'
import { COVER_LETTER_PDF, HELD_UPLOAD_NOTE } from '../apply/answers'
import { makeRaw, makeTestEnv } from '../testing'
import profileFixture from '../writing/__fixtures__/profile.json'
import scopely from '../writing/__fixtures__/scopely-client-engineer.posting.json'
import { HELD_LETTER_NOTE } from '../writing/lint'
import { Pipeline } from './orchestrator'

// Final review, finding 17: an application that was ready before the grounding hold existed is checked again
// before autopilot sends it.

const FIT = { score: 95, bucket: 'perfect' as const, summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }
const GOOD = `Hi Scopely team,

When our mobile puzzle game lost progress on about 300 phones, nobody could see it happening in the field. I wrote a small telemetry layer in C# inside the Unity client that reported save failures and frame times from real devices, and our QA lead used it to reproduce the bug in an afternoon.

The Client Engineer posting asks for monitoring and observability inside the Unity client, and for turning ambiguous live issues into signals the team can act on. On Tidepool the same UI bug looked different on each platform until the data lined up.

I write and present in English every day. I would like to talk about which signals your team wants first from real user monitoring, and how you decide what goes on a dashboard.

Thanks,
Mara`
const BAD = GOOD.replace('On Tidepool the', 'After 17 years in games I led the Zebracorp migration that cut crash reports by 80 percent, and the')

const upload = (required: boolean): FormField => ({ key: 'cl', label: 'Cover letter', type: 'file', required, options: [], placeholder: null, maxLength: null, fileHint: 'cover_letter' })
const attached = (required: boolean): PreparedAnswer => ({ fieldKey: 'cl', label: 'Cover letter', type: 'file', required, options: [], value: COVER_LETTER_PDF, source: 'file', confidence: 1, needsUser: false, note: null, lint: null })

async function setup() {
  const env = await makeTestEnv()
  env.ctx.profile.save({ ...EMPTY_PROFILE, ...(profileFixture as Partial<Profile>), languages: ['English'] })
  env.ctx.settings.update({ thresholds: { autoSubmitScore: 85 }, autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10 } })
  const addReady = (letter: string | null, required: boolean, company = 'Scopely') => {
    const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: `x-${Math.random()}`, company, title: scopely.title, description: scopely.text }), null)
    env.ctx.jobs.saveFit(job.id, FIT, env.ctx.profile.get().version, 'shortlisted')
    const app = env.ctx.applications.create(job.id)
    env.ctx.applications.update(app.id, { status: 'ready', coverLetter: letter ?? undefined, formFields: [upload(required)], answers: [attached(required)] })
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
  return { ...env, addReady, pipeline, sent }
}

const run = (pipeline: Pipeline) => pipeline.submitStep(5, new AbortController().signal)

describe('submit step and a letter the check holds back', () => {
  it('sends an application whose letter passes', async () => {
    const env = await setup()
    const id = env.addReady(GOOD, true)
    await run(env.pipeline)
    expect(env.sent).toEqual([id])
  })

  it('holds a ready application with an ungrounded letter on a required upload', async () => {
    const env = await setup()
    const id = env.addReady(BAD, true)
    await run(env.pipeline)
    expect(env.sent).toEqual([])
    const app = env.ctx.applications.get(id)!
    expect(app.status).toBe('needs_attention')
    expect(app.error).toContain(HELD_LETTER_NOTE)
    expect(app.coverLetterLint).not.toBeNull()
  })

  it('sends an application whose optional upload loses the held letter', async () => {
    const env = await setup()
    const id = env.addReady(BAD, false)
    await run(env.pipeline)
    expect(env.sent).toEqual([id])
    const app = env.ctx.applications.get(id)!
    expect(app.answers[0]).toMatchObject({ value: '', note: HELD_UPLOAD_NOTE })
  })

  it('sends an application with no letter, and keeps going past a held one', async () => {
    const env = await setup()
    const held = env.addReady(BAD, true, 'Held Co')
    const plain = env.addReady(null, false, 'Plain Co')
    await run(env.pipeline)
    expect(env.sent).toEqual([plain])
    expect(env.ctx.applications.get(held)?.status).toBe('needs_attention')
  })
})
