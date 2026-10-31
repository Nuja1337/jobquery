import { describe, expect, it } from 'vitest'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { dismissJob, restoreJob, scoreJobNow } from './actions'
import { ingestRaw } from './ingest'
import { dismissSuggestion, suggestPreferences } from './learn'

async function setup() {
  const env = await makeTestEnv()
  env.ctx.profile.save(makeProfile())
  return env
}

function dismissed(env: Awaited<ReturnType<typeof setup>>, title: string, tags: string[], extra: Record<string, unknown> = {}) {
  const job = ingestRaw(env.ctx, makeRaw({ title, company: `Co ${Math.random()}`, description: `About ${title}. ${Math.random()}`, ...extra })).job
  dismissJob(env.ctx, job.id, null, tags)
  return job
}

describe('suggestPreferences', () => {
  it('suggests excluding a seniority word after three "too senior" dismissals', async () => {
    const env = await setup()
    dismissed(env, 'Staff Engineer, Payments', ['too senior'])
    dismissed(env, 'Staff Software Engineer', ['too senior'])
    expect(suggestPreferences(env.ctx)).toEqual([])
    dismissed(env, 'Staff Backend Engineer', ['too senior'])
    const [suggestion] = suggestPreferences(env.ctx)
    expect(suggestion).toMatchObject({ id: 'exclude-title:staff', evidence: 3 })
    expect(suggestion.message).toContain('"staff"')
    expect(suggestion.message).not.toContain('—')
    expect(suggestion.patch.preferences.excludeTitleKeywords).toEqual(['staff'])
  })

  it('stops suggesting a change once it is applied', async () => {
    const env = await setup()
    for (const t of ['Staff A', 'Staff B', 'Staff C']) dismissed(env, t, ['too senior'])
    const [suggestion] = suggestPreferences(env.ctx)
    env.ctx.settings.update(suggestion.patch)
    expect(suggestPreferences(env.ctx)).toEqual([])
  })

  it('does not offer a suggestion again after it is dismissed', async () => {
    const env = await setup()
    for (const t of ['Staff A', 'Staff B', 'Staff C']) dismissed(env, t, ['too senior'])
    dismissSuggestion(env.ctx, 'exclude-title:staff')
    expect(suggestPreferences(env.ctx)).toEqual([])
  })

  it('suggests narrowing the work types after three "not remote" dismissals', async () => {
    const env = await setup()
    for (const t of ['Dev A', 'Dev B', 'Dev C']) dismissed(env, t, ['not remote'], { remote: 'onsite' })
    const [suggestion] = suggestPreferences(env.ctx)
    expect(suggestion.patch.preferences.remote).toEqual(['remote', 'hybrid'])
    expect(suggestion.message).toContain('on-site')
  })

  it('suggests excluding a company with three dismissals, whatever the reason', async () => {
    const env = await setup()
    for (const t of ['Dev A', 'Dev B', 'Dev C']) dismissed(env, t, [], { company: 'Globex Corp.' })
    const [suggestion] = suggestPreferences(env.ctx)
    expect(suggestion).toMatchObject({ id: 'exclude-company:globex', evidence: 3 })
    expect(suggestion.patch.preferences.excludedCompanies).toEqual(['Globex Corp.'])
  })

  it('suggests a pay floor above the jobs turned down for low pay', async () => {
    const env = await setup()
    for (const max of [80000, 90000, 99000]) dismissed(env, `Dev ${max}`, ['pay too low'], { salaryMin: max - 10000, salaryMax: max, salaryCurrency: 'USD' })
    const [suggestion] = suggestPreferences(env.ctx)
    expect(suggestion.patch.preferences.minSalary).toBe(100000)
  })

  it('suggests a title word for repeated "wrong tech stack" dismissals but never a generic one', async () => {
    const env = await setup()
    for (const t of ['PHP Developer A', 'PHP Developer B', 'Senior PHP Developer']) dismissed(env, t, ['wrong tech stack'])
    const ids = suggestPreferences(env.ctx).map((s) => s.id)
    expect(ids).toContain('exclude-title:php')
    expect(ids).not.toContain('exclude-title:developer')
  })
})

describe('job actions', () => {
  it('dismisses and restores with an activity entry and a UI update', async () => {
    const env = await setup()
    const job = ingestRaw(env.ctx, makeRaw({ title: 'Software Engineer' })).job
    dismissJob(env.ctx, job.id, 'Not for me', ['too senior'])
    expect(env.ctx.jobs.get(job.id)).toMatchObject({ stage: 'dismissed', dismissReason: 'Not for me', dismissTags: ['too senior'] })
    restoreJob(env.ctx, job.id)
    expect(env.ctx.jobs.get(job.id)).toMatchObject({ stage: 'new', dismissReason: null, dismissTags: [] })
    expect(env.ctx.events.list({ limit: 5 }).map((e) => e.type)).toEqual(['restored', 'dismissed'])
    expect(env.pushed.filter((p) => p.channel === 'jobs:changed')).toHaveLength(2)
  })

  it('restores a scored job to shortlisted or scored by its score', async () => {
    const env = await setup()
    const job = ingestRaw(env.ctx, makeRaw({ title: 'Software Engineer' })).job
    await scoreJobNow(env.ctx, job.id)
    expect(env.ctx.jobs.get(job.id)?.stage).toBe('shortlisted')
    dismissJob(env.ctx, job.id, null, [])
    restoreJob(env.ctx, job.id)
    expect(env.ctx.jobs.get(job.id)?.stage).toBe('shortlisted')
  })

  it('withdraws an unsent application on dismiss and brings it back on restore', async () => {
    const env = await setup()
    const job = ingestRaw(env.ctx, makeRaw({ title: 'Software Engineer' })).job
    const app = env.ctx.applications.create(job.id)
    env.ctx.applications.update(app.id, { status: 'ready' })
    dismissJob(env.ctx, job.id, null, [])
    expect(env.ctx.applications.get(app.id)?.status).toBe('withdrawn')
    expect(env.ctx.applications.listReady()).toHaveLength(0)
    restoreJob(env.ctx, job.id)
    expect(env.ctx.applications.get(app.id)?.status).toBe('needs_attention')
  })

  it('scores a filtered-out job when asked', async () => {
    const env = await setup()
    env.ctx.settings.update({ preferences: { excludeTitleKeywords: ['intern'] } })
    const raw = makeRaw({ title: 'Intern Engineer' })
    const job = ingestRaw(env.ctx, raw).job
    env.ctx.jobs.setFree(job.id, { stage: 'filtered_out', filterReason: 'excluded title word: intern', prescore: null })
    const scored = await scoreJobNow(env.ctx, job.id)
    expect(scored).toMatchObject({ fitScore: 80, stage: 'shortlisted' })
  })
})
