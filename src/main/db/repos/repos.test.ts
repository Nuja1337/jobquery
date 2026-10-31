import { describe, expect, it } from 'vitest'
import { EMPTY_PROFILE } from '@shared/defaults'
import { ingestRaw } from '../../pipeline/ingest'
import { makeProfile, makeRaw, makeTestEnv } from '../../testing'

describe('ProfileRepo', () => {
  it('returns the empty profile before anything is saved', async () => {
    const { ctx } = await makeTestEnv()
    const record = ctx.profile.get()
    expect(record.profile).toEqual(EMPTY_PROFILE)
    expect(record.updatedAt).toBeNull()
  })

  it('bumps the version only when a fit-relevant field changes', async () => {
    const { ctx } = await makeTestEnv()
    const first = ctx.profile.save(makeProfile())
    const v = first.version
    const same = ctx.profile.save({ ...first.profile, fullName: 'Sam R.', phone: '555', notesForAi: 'Be brief', links: { ...first.profile.links, github: 'g' }, facts: [{ question: 'Notice?', answer: '2 weeks' }] })
    expect(same.version).toBe(v)
    expect(same.profile.notesForAi).toBe('Be brief')
    for (const change of [
      { headline: 'New headline' },
      { summary: 'New summary' },
      { skills: ['Go'] },
      { yearsExperience: 9 },
      { certifications: ['AWS'] },
      { experience: [] },
      { education: [{ school: 'MIT' }] },
      { projects: [{ name: 'p', description: 'd', highlights: [] }] },
      { workAuthorization: { authorizedCountries: ['US'], needsSponsorship: false, notes: '' } }
    ]) {
      const before = ctx.profile.get()
      const after = ctx.profile.save({ ...before.profile, ...change })
      expect(after.version, JSON.stringify(change)).toBe(before.version + 1)
    }
  })

  it('fills missing nested fields from the defaults', async () => {
    const { ctx } = await makeTestEnv()
    ctx.db.run("INSERT INTO profile (id, data, version, hash, updated_at) VALUES (1, :data, 3, 'x', 'now')", { data: JSON.stringify({ fullName: 'Old Data' }) })
    const { profile, version } = ctx.profile.get()
    expect(version).toBe(3)
    expect(profile.fullName).toBe('Old Data')
    expect(profile.links.github).toBe('')
    expect(profile.skills).toEqual([])
  })
})

describe('DocumentsRepo', () => {
  it('keeps one primary resume and previews the first 300 characters', async () => {
    const { ctx } = await makeTestEnv()
    const text = 'x'.repeat(1000)
    const a = ctx.documents.insert({ kind: 'resume', name: 'a.pdf', text })
    const b = ctx.documents.insert({ kind: 'resume', name: 'b.pdf', text: 'short' })
    const sample = ctx.documents.insert({ kind: 'writing_sample', name: 's.txt', text: 'hello' })
    expect(a).toMatchObject({ isPrimary: true, textLength: 1000 })
    expect(a.textPreview).toHaveLength(300)
    expect(b.isPrimary).toBe(false)
    expect(sample.isPrimary).toBe(false)
    ctx.documents.setPrimary(b.id)
    expect(ctx.documents.list('resume').map((d) => [d.name, d.isPrimary]).sort()).toEqual([['a.pdf', false], ['b.pdf', true]])
    ctx.documents.setPrimary(sample.id)
    expect(ctx.documents.primaryResume()?.id).toBe(b.id)
    expect(ctx.documents.getText(a.id)).toHaveLength(1000)
  })

  it('hands the primary flag to another resume when the primary is deleted', async () => {
    const { ctx } = await makeTestEnv()
    const a = ctx.documents.insert({ kind: 'resume', name: 'a', text: '1' })
    const b = ctx.documents.insert({ kind: 'resume', name: 'b', text: '2' })
    ctx.documents.delete(a.id)
    expect(ctx.documents.get(a.id)).toBeNull()
    expect(ctx.documents.get(b.id)?.isPrimary).toBe(true)
  })
})

describe('AnswerBankRepo', () => {
  it('finds an exact match first, then a close one, and counts uses', async () => {
    const { ctx } = await makeTestEnv()
    const auth = ctx.answers.save({ question: 'Are you authorized to work in the US?', answer: 'Yes', kind: 'fact' })
    ctx.answers.save({ question: 'What is your notice period?', answer: 'Two weeks', kind: 'fact' })
    expect(ctx.answers.findBest('Are you authorized to work in the US?')?.id).toBe(auth.id)
    expect(ctx.answers.findBest('are you authorized to work in the US')?.id).toBe(auth.id)
    expect(ctx.answers.findBest('Are you legally authorized to work in the US?')?.id).toBe(auth.id)
    expect(ctx.answers.findBest('Why do you want to work here?')).toBeNull()
    ctx.answers.markUsed(auth.id)
    ctx.answers.markUsed(auth.id)
    expect(ctx.answers.get(auth.id)?.timesUsed).toBe(2)
    ctx.answers.save({ id: auth.id, question: 'Work authorization?', answer: 'Yes, US citizen', kind: 'fact' })
    expect(ctx.answers.get(auth.id)).toMatchObject({ answer: 'Yes, US citizen', timesUsed: 2 })
    ctx.answers.delete(auth.id)
    expect(ctx.answers.list()).toHaveLength(1)
  })
})

describe('CompaniesRepo and SearchesRepo', () => {
  it('saves partial updates, lists watched boards and finds companies by token or name', async () => {
    const { ctx } = await makeTestEnv()
    const acme = ctx.companies.save({ name: 'Acme, Inc.', ats: 'greenhouse', atsToken: 'acme', watch: true })
    ctx.companies.save({ name: 'Nope', ats: 'unknown', watch: true })
    ctx.companies.save({ name: 'Blocked Co', blocked: true })
    expect(ctx.companies.listWatched().map((c) => c.name)).toEqual(['Acme, Inc.'])
    expect(ctx.companies.findByAts('greenhouse', 'acme')?.id).toBe(acme.id)
    expect(ctx.companies.findByName('ACME')?.id).toBe(acme.id)
    expect(ctx.companies.blockedNames()).toEqual(['blocked'])
    const renamed = ctx.companies.save({ id: acme.id, notes: 'Friend works here' })
    expect(renamed).toMatchObject({ name: 'Acme, Inc.', atsToken: 'acme', watch: true, notes: 'Friend works here' })
  })

  it('stores search params and the last run time', async () => {
    const { ctx } = await makeTestEnv()
    const s = ctx.searches.save({ source: 'remotive', label: 'Remote devs', params: { query: 'typescript' }, enabled: true })
    ctx.searches.save({ source: 'adzuna', label: 'Off', params: {}, enabled: false })
    expect(ctx.searches.listEnabled().map((x) => x.id)).toEqual([s.id])
    ctx.searches.markRun(s.id)
    expect(ctx.searches.get(s.id)).toMatchObject({ params: { query: 'typescript' }, lastRunAt: expect.any(String) })
  })
})

describe('JobsRepo', () => {
  it('lists with filters, sorting, paging and the application id joined in', async () => {
    const { ctx } = await makeTestEnv()
    const a = ingestRaw(ctx, makeRaw({ title: 'Alpha Engineer', company: 'Zed' })).job
    const b = ingestRaw(ctx, makeRaw({ title: 'Beta Engineer', company: 'Acme' })).job
    const c = ingestRaw(ctx, makeRaw({ title: 'Gamma Designer', company: 'Mid', source: 'remoteok' })).job
    const fit = (score: number) => ({ score, bucket: score >= 70 ? ('great' as const) : ('good' as const), summary: 's', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] })
    ctx.jobs.saveFit(a.id, fit(90), 1, 'shortlisted')
    ctx.jobs.saveFit(b.id, fit(65), 1, 'shortlisted')
    ctx.jobs.star(c.id, true)
    const app = ctx.applications.create(a.id)

    const byScore = ctx.jobs.list({ sort: 'score' })
    expect(byScore.items.map((j) => j.title)).toEqual(['Alpha Engineer', 'Beta Engineer', 'Gamma Designer'])
    expect(byScore.total).toBe(3)
    expect(byScore.items[0].applicationId).toBe(app.id)
    expect(ctx.jobs.list({ sort: 'company' }).items.map((j) => j.company)).toEqual(['Acme', 'Mid', 'Zed'])
    expect(ctx.jobs.list({ stages: ['shortlisted', 'preparing'] }).total).toBe(2)
    expect(ctx.jobs.list({ buckets: ['great'] }).items.map((j) => j.id)).toEqual([a.id])
    expect(ctx.jobs.list({ sources: ['remoteok'] }).items.map((j) => j.id)).toEqual([c.id])
    expect(ctx.jobs.list({ starredOnly: true }).items.map((j) => j.id)).toEqual([c.id])
    expect(ctx.jobs.list({ search: 'designer' }).total).toBe(1)
    expect(ctx.jobs.list({ search: '50%_' }).total).toBe(0)
    const page = ctx.jobs.list({ sort: 'company', limit: 2, offset: 2 })
    expect(page).toMatchObject({ total: 3 })
    expect(page.items).toHaveLength(1)
  })

  it('dismisses with tags but never an applied job, and restores', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw()).job
    ctx.jobs.dismiss(job.id, 'meh', ['other'])
    expect(ctx.jobs.get(job.id)).toMatchObject({ stage: 'dismissed', dismissTags: ['other'] })
    ctx.jobs.restore(job.id, 60)
    expect(ctx.jobs.get(job.id)?.stage).toBe('new')
    ctx.jobs.setStage(job.id, 'applied')
    ctx.jobs.dismiss(job.id, null, [])
    expect(ctx.jobs.get(job.id)?.stage).toBe('applied')
  })

  it('keeps a stored description when a refresh arrives without one', async () => {
    const { ctx } = await makeTestEnv()
    const raw = makeRaw({ externalId: 'x', description: 'Full text.' })
    const { job } = ctx.jobs.upsertRaw(raw, null)
    ctx.jobs.upsertRaw({ ...raw, description: '' }, null)
    expect(ctx.jobs.get(job.id)?.description).toBe('Full text.')
  })

  it('finds jobs by content hash with originals first', async () => {
    const { ctx } = await makeTestEnv()
    const first = ingestRaw(ctx, makeRaw({ source: 'greenhouse', externalId: '1', description: 'Same.' })).job
    const second = ingestRaw(ctx, makeRaw({ source: 'remoteok', externalId: '2', description: 'Same.' })).job
    const third = ingestRaw(ctx, makeRaw({ source: 'remotive', externalId: '3', description: 'Same.' })).job
    expect(second.stage).toBe('duplicate')
    expect(third.stage).toBe('duplicate')
    const hash = (ctx.db.get<{ content_hash: string }>('SELECT content_hash FROM jobs WHERE id = :id', { id: first.id }))!.content_hash
    expect(ctx.jobs.findByContentHash(hash, third.id)[0].id).toBe(first.id)
  })
})

describe('ApplicationsRepo', () => {
  it('creates one application per job and keeps the job stage in step with the status', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw({ title: 'Engineer', company: 'Acme' })).job
    const app = ctx.applications.create(job.id)
    expect(app).toMatchObject({ status: 'draft', company: 'Acme', title: 'Engineer', flaggedCount: 0 })
    expect(ctx.applications.create(job.id).id).toBe(app.id)
    expect(ctx.jobs.get(job.id)?.stage).toBe('preparing')
    ctx.applications.update(app.id, { status: 'ready' })
    expect(ctx.jobs.get(job.id)?.stage).toBe('ready')
    const submitted = ctx.applications.update(app.id, { status: 'submitted' })
    expect(submitted.submittedAt).not.toBeNull()
    expect(ctx.jobs.get(job.id)?.stage).toBe('applied')
    const withOutcome = ctx.applications.update(app.id, { outcome: 'interview' })
    expect(withOutcome.outcomeAt).not.toBeNull()
    expect(ctx.applications.update(app.id, { outcome: 'none' }).outcomeAt).toBeNull()
  })

  it('counts flagged answers, filters and joins fit from the job', async () => {
    const { ctx } = await makeTestEnv()
    const a = ingestRaw(ctx, makeRaw({ title: 'Alpha', company: 'Acme' })).job
    const b = ingestRaw(ctx, makeRaw({ title: 'Beta', company: 'Globex' })).job
    ctx.jobs.saveFit(a.id, { score: 88, bucket: 'perfect', summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }, 1)
    const appA = ctx.applications.create(a.id)
    ctx.applications.create(b.id)
    const answer = (needsUser: boolean) => ({ fieldKey: String(Math.random()), label: 'Q', type: 'text' as const, required: true, options: [], value: needsUser ? '' : 'An answer', source: 'ai' as const, confidence: 0.5, needsUser, note: null, lint: null })
    const updated = ctx.applications.update(appA.id, { answers: [answer(true), answer(false), answer(true)], coverLetter: 'Hi', formFields: [] })
    expect(updated.flaggedCount).toBe(2)
    expect(updated.coverLetter).toBe('Hi')
    const list = ctx.applications.list({ search: 'acme' })
    expect(list.total).toBe(1)
    expect(list.items[0]).toMatchObject({ fitScore: 88, fitBucket: 'perfect', flaggedCount: 2 })
    expect(ctx.applications.list({ statuses: ['draft'] }).total).toBe(2)
    expect(ctx.applications.list({ statuses: ['ready'] }).total).toBe(0)
    expect(ctx.applications.countByStatus()).toEqual({ draft: 2 })
  })

  it('reports when the user last applied to a company', async () => {
    const { ctx } = await makeTestEnv()
    const job = ingestRaw(ctx, makeRaw({ company: 'Acme, Inc.' })).job
    const app = ctx.applications.create(job.id)
    expect(ctx.applications.lastSubmittedAt('acme')).toBeNull()
    ctx.applications.update(app.id, { status: 'submitted' })
    expect(ctx.applications.lastSubmittedAt('acme')).not.toBeNull()
    expect(ctx.applications.countSubmittedSince(new Date(Date.now() - 60_000).toISOString())).toBe(1)
  })
})

describe('EventsRepo and RunsRepo', () => {
  it('writes events, pushes them to the UI and filters the list', async () => {
    const { ctx, pushed } = await makeTestEnv()
    const e = ctx.events.add('error', 'Something broke.', 'job-1', { code: 7 })
    ctx.events.add('discovered', 'Found jobs.')
    expect(pushed.filter((p) => p.channel === 'event:new')).toHaveLength(2)
    expect(ctx.events.list({ limit: 10 }).map((x) => x.type)).toEqual(['discovered', 'error'])
    expect(ctx.events.list({ limit: 10, types: ['error'] })[0]).toMatchObject({ id: e.id, jobId: 'job-1', data: { code: 7 } })
    expect(ctx.events.list({ limit: 10, jobId: 'job-1' })).toHaveLength(1)
    expect(ctx.events.list({ limit: 1 })).toHaveLength(1)
  })

  it('records runs from start to finish', async () => {
    const { ctx } = await makeTestEnv()
    const run = ctx.runs.start('schedule')
    expect(run).toMatchObject({ trigger: 'schedule', finishedAt: null })
    expect(run.stats.scored).toBe(0)
    ctx.runs.finish(run.id, { ...run.stats, scored: 4, costUsd: 0.12 })
    expect(ctx.runs.list(5)[0]).toMatchObject({ finishedAt: expect.any(String), stats: { scored: 4, costUsd: 0.12 }, error: null })
  })
})
