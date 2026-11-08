import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { FitAssessment, JobPreferences } from '@shared/types'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { type FilterContext, type FilterJob, applyFilters, employmentTypesOf } from './filters'
import { Pipeline } from './orchestrator'

// Regression tests for the second code review (filters and the submit step).

const NOW = Date.parse('2026-10-30T12:00:00Z')
const prefs: JobPreferences = {
  ...structuredClone(DEFAULT_SETTINGS.preferences),
  needsVisaSponsorship: true,
  targetTitles: [],
  locations: [],
  remote: [],
  seniority: [],
  employmentTypes: [],
  maxPostingAgeDays: 0,
  minSalary: null,
  companyCooldownDays: 0
}
const job = (description: string): FilterJob => ({ title: 'Software Engineer', company: 'Acme', location: 'Austin, TX', remote: 'onsite', salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null, description }) as FilterJob
const fctx: FilterContext = { now: NOW, blockedCompanies: new Set(), lastAppliedAt: () => null }
const passes = (text: string): boolean => applyFilters(job(text), prefs, fctx).pass

describe('F8: postings that say they do not sponsor', () => {
  it.each([
    'Visa sponsorship will not be provided for this position.',
    'This position does not qualify for visa sponsorship.',
    "We're not able to sponsor visas at this time.",
    "We're not able to offer visa sponsorship.",
    'We are not offering relocation or visa sponsorship for this role.',
    'This role is not open to visa sponsorship.',
    'Sponsorship will not be available for this role.',
    "This role isn't eligible for visa sponsorship.",
    'We will not sponsor visas for this role.',
    'We cannot offer sponsorship.',
    'No sponsorship is available.'
  ])('drops the job for: %s', (text) => {
    expect(passes(text)).toBe(false)
  })

  it.each([
    'Visa sponsorship is available for this role.',
    'Not sure if we sponsor? Ask us.',
    'We hire with or without sponsorship.',
    'We sponsor game jams and do not require a degree.',
    'We sponsor events for the community.'
  ])('keeps the job for: %s', (text) => {
    expect(passes(text)).toBe(true)
  })
})

describe('F13: employment type labels', () => {
  it('returns both types of "Full-time or Part-time"', () => {
    expect(employmentTypesOf('Full-time or Part-time').sort()).toEqual(['full_time', 'part_time'])
    expect(employmentTypesOf('Full-time and Contract').sort()).toEqual(['contract', 'full_time'])
  })
  it('reads "Contract (Full-time)" as a contract', () => {
    expect(employmentTypesOf('Contract (Full-time)')).toEqual(['contract'])
  })
  it('keeps the existing separators and a bracket that is the only type', () => {
    expect(employmentTypesOf('Full time / Contract').sort()).toEqual(['contract', 'full_time'])
    expect(employmentTypesOf('Employment (Part-time)')).toEqual(['part_time'])
    expect(employmentTypesOf('Permanent')).toEqual(['full_time'])
    expect(employmentTypesOf('Employee')).toEqual([])
  })
})

describe('F7: a job waiting for its rescore is not sent', () => {
  const OLD_FIT: FitAssessment = { score: 95, bucket: 'perfect', summary: 'Old.', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }

  async function ready(pending: boolean) {
    const env = await makeTestEnv({ score: () => 40 })
    env.ctx.profile.save(makeProfile())
    env.ctx.settings.update({ thresholds: { shortlistScore: 70, autoSubmitScore: 85 }, autopilot: { enabled: true, autoSubmit: true, dailySubmitCap: 10, dryRun: false } })
    const v = env.ctx.profile.get().version
    const { job: row } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: 'x', title: 'Engineer x', company: 'Co x' }), null)
    env.ctx.jobs.saveFit(row.id, OLD_FIT, v, 'shortlisted')
    if (pending) env.ctx.db.run('UPDATE jobs SET rescore_pending = 1 WHERE id = :id', { id: row.id })
    const app = env.ctx.applications.create(row.id)
    env.ctx.applications.update(app.id, { status: 'ready', coverLetter: 'Draft.' })
    env.ctx.jobs.setStage(row.id, 'ready')
    const sent: string[] = []
    const p = new Pipeline(
      env.ctx,
      {
        submit: async (id) => {
          sent.push(id)
          env.ctx.applications.update(id, { status: 'submitted' })
          return { ok: true, status: 'submitted', message: 'Sent.', screenshotPath: null }
        }
      },
      () => []
    )
    return { env, p, sent, jobId: row.id }
  }

  it('skips a marked job and leaves the mark', async () => {
    const { env, p, sent, jobId } = await ready(true)
    const out = await p.submitStep(5, new AbortController().signal)
    expect(sent).toEqual([])
    expect(out.did).toBe(0)
    expect(env.ctx.jobs.needsRescore(jobId)).toBe(true)
    expect(env.ctx.applications.listReady()).toEqual([])
  })

  it('sends the same job when it is not marked', async () => {
    const { env, p, sent } = await ready(false)
    expect(env.ctx.applications.listReady()).toHaveLength(1)
    await p.submitStep(5, new AbortController().signal)
    expect(sent).toHaveLength(1)
  })
})
