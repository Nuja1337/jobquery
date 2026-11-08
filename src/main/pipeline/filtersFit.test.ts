import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AuthorizationEntry, JobPreferences } from '@shared/types'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { applyFree, buildFreeEnv, freeFingerprint, ingestRaw } from './ingest'
import { type FilterContext, type FilterJob, applyFilters, employmentTypesOf, seniorityFromLabel } from './filters'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const base: FilterContext = { now: NOW, blockedCompanies: new Set<string>(), lastAppliedAt: () => null }

function prefs(overrides: Partial<JobPreferences> = {}): JobPreferences {
  return { ...structuredClone(DEFAULT_SETTINGS.preferences), ...overrides }
}

function job(overrides: Partial<FilterJob> = {}): FilterJob {
  return { title: 'Gameplay Programmer', company: 'Acme', location: 'Remote', remote: 'remote', salaryMax: null, salaryCurrency: null, postedAt: null, description: 'Build things.', ...overrides }
}

const reasonOf = (j: FilterJob, p: JobPreferences, ctx: Partial<FilterContext> = {}): string | null => {
  const r = applyFilters(j, p, { ...base, ...ctx })
  return r.pass ? null : r.reason
}

const entry = (country: string, status: AuthorizationEntry['status'], needsSponsorship = false): AuthorizationEntry => ({ country, status, needsSponsorship, notes: '' })

describe('employment type filter', () => {
  it('reads the types a source label names', () => {
    expect(employmentTypesOf('Full-time')).toEqual(['full_time'])
    expect(employmentTypesOf('FULL_TIME')).toEqual(['full_time'])
    expect(employmentTypesOf('Permanent')).toEqual(['full_time'])
    expect(employmentTypesOf('Part-time, Contract')).toEqual(['part_time', 'contract'])
    expect(employmentTypesOf('Contract to hire')).toEqual(['contract_to_hire'])
    expect(employmentTypesOf('Working student')).toEqual(['internship'])
    expect(employmentTypesOf('Freelance')).toEqual(['freelance'])
    expect(employmentTypesOf('Temporary')).toEqual(['temporary'])
    expect(employmentTypesOf('Other')).toEqual([])
    expect(employmentTypesOf(null)).toEqual([])
  })

  it('treats an empty list as any type', () => {
    expect(reasonOf(job({ employmentType: 'Contract' }), prefs({ employmentTypes: [] }))).toBeNull()
  })

  it('drops a job whose stated type is not wanted', () => {
    expect(reasonOf(job({ employmentType: 'Contract' }), prefs({ employmentTypes: ['full_time'] }))).toBe('contract, you want full-time')
    expect(reasonOf(job({ employmentType: 'Part-time' }), prefs({ employmentTypes: ['full_time', 'contract'] }))).toBe('part-time, you want full-time or contract')
  })

  it('passes a wanted type, one of several stated types, and a job that states none', () => {
    expect(reasonOf(job({ employmentType: 'Full-time' }), prefs({ employmentTypes: ['full_time'] }))).toBeNull()
    expect(reasonOf(job({ employmentType: 'Full-time, Contract' }), prefs({ employmentTypes: ['contract'] }))).toBeNull()
    expect(reasonOf(job({ employmentType: null }), prefs({ employmentTypes: ['full_time'] }))).toBeNull()
    expect(reasonOf(job({ employmentType: 'Other' }), prefs({ employmentTypes: ['full_time'] }))).toBeNull()
  })

  it('passes settings stored before the filter existed', () => {
    const old = prefs()
    delete (old as Partial<JobPreferences>).employmentTypes
    expect(reasonOf(job({ employmentType: 'Contract' }), old)).toBeNull()
  })
})

describe('relocation places as locations', () => {
  const p = prefs({ locations: ['Austin, TX'], remote: [] })
  const berlin = job({ location: 'Berlin, Germany', remote: 'onsite' })
  const relocation = (willing: boolean | null) => ({ relocation: { willing, places: ['Berlin'] } })

  it('drops a job outside the location list when the owner would not move there', () => {
    expect(reasonOf(berlin, p)).toBe("location doesn't match")
    expect(reasonOf(berlin, p, relocation(false))).toBe("location doesn't match")
    // An unanswered relocation question is not a Yes.
    expect(reasonOf(berlin, p, relocation(null))).toBe("location doesn't match")
  })

  it('passes a job in a place the owner would move to', () => {
    expect(reasonOf(berlin, p, relocation(true))).toBeNull()
    expect(reasonOf(job({ location: 'Munich, Germany', remote: 'onsite' }), p, relocation(true))).toBe("location doesn't match")
    expect(reasonOf(job({ location: 'Munich, Germany', remote: 'onsite' }), p, { relocation: { willing: true, places: ['Germany'] } })).toBeNull()
  })

  it('still passes the owner\'s own locations', () => {
    expect(reasonOf(job({ location: 'Austin, TX', remote: 'onsite' }), p, relocation(true))).toBeNull()
  })

  it('does not narrow an empty location list', () => {
    expect(reasonOf(berlin, prefs({ locations: [], remote: [] }), relocation(true))).toBeNull()
  })
})

describe('visa sponsorship from the authorization entries', () => {
  const noSponsor = 'We do not offer visa sponsorship for this role.'
  const needsSponsorship = prefs({ needsVisaSponsorship: true })

  it('uses the preference setting when the profile lists no countries', () => {
    expect(reasonOf(job({ description: noSponsor }), needsSponsorship)).toBe('says no visa sponsorship')
    expect(reasonOf(job({ description: noSponsor }), prefs({ needsVisaSponsorship: false }))).toBeNull()
    expect(reasonOf(job({ description: noSponsor }), needsSponsorship, { authorization: [] })).toBe('says no visa sponsorship')
  })

  it('drops a no-sponsorship job in a country where the owner has no permission', () => {
    const authorization = [entry('Germany', 'citizen'), entry('United States', 'none')]
    const us = job({ location: 'Austin, TX', description: noSponsor, remote: 'onsite' })
    expect(reasonOf(us, prefs(), { authorization })).toBe('says no visa sponsorship')
  })

  it('passes the same posting in a country where the owner needs no sponsorship, whatever the setting says', () => {
    const authorization = [entry('Germany', 'citizen'), entry('United States', 'none')]
    const de = job({ location: 'Berlin, Germany', description: noSponsor, remote: 'onsite' })
    expect(reasonOf(de, needsSponsorship, { authorization })).toBeNull()
  })

  it('counts a visa as needing sponsorship only when the entry says so', () => {
    const us = job({ location: 'Seattle, WA', description: noSponsor, remote: 'onsite' })
    expect(reasonOf(us, prefs(), { authorization: [entry('United States', 'visa', true)] })).toBe('says no visa sponsorship')
    expect(reasonOf(us, prefs(), { authorization: [entry('United States', 'visa', false)] })).toBeNull()
    expect(reasonOf(us, prefs(), { authorization: [entry('United States', 'permanent_resident')] })).toBeNull()
  })

  it('treats a country with no entry as needing sponsorship', () => {
    const ca = job({ location: 'Toronto, Canada', description: noSponsor, remote: 'onsite' })
    expect(reasonOf(ca, prefs(), { authorization: [entry('Germany', 'citizen')] })).toBe('says no visa sponsorship')
  })

  it('for a job with no known country, needs sponsorship only if no entry is free of it', () => {
    const anywhere = job({ location: 'Remote', description: noSponsor })
    expect(reasonOf(anywhere, prefs(), { authorization: [entry('Germany', 'citizen'), entry('United States', 'none')] })).toBeNull()
    expect(reasonOf(anywhere, prefs(), { authorization: [entry('United States', 'none')] })).toBe('says no visa sponsorship')
  })

  it('passes a multi-country job when any one of its countries needs no sponsorship', () => {
    const authorization = [entry('Germany', 'citizen'), entry('United States', 'none')]
    const both = job({ location: 'Austin, TX; Berlin, Germany', description: noSponsor, remote: 'onsite' })
    expect(reasonOf(both, prefs(), { authorization })).toBeNull()
  })
})

describe('source-supplied seniority', () => {
  it('maps source labels to seniority ids', () => {
    expect(seniorityFromLabel('Entry Level')).toBe('junior')
    expect(seniorityFromLabel('entry-level')).toBe('junior')
    expect(seniorityFromLabel('Mid-level')).toBe('mid')
    expect(seniorityFromLabel('Mid Level')).toBe('mid')
    expect(seniorityFromLabel('Senior Level')).toBe('senior')
    expect(seniorityFromLabel('Senior')).toBe('senior')
    expect(seniorityFromLabel('Management')).toBe('manager')
    expect(seniorityFromLabel('student')).toBe('intern')
    expect(seniorityFromLabel('Internship')).toBe('intern')
    expect(seniorityFromLabel('executive')).toBe('executive')
    expect(seniorityFromLabel('experienced')).toBeNull()
    expect(seniorityFromLabel('')).toBeNull()
    expect(seniorityFromLabel(undefined)).toBeNull()
  })

  const wantsSenior = prefs({ seniority: ['senior', 'staff'] })

  it('uses the source level when the title says nothing', () => {
    expect(reasonOf(job({ title: 'Gameplay Programmer', seniority: ['junior'] }), wantsSenior)).toBe('seniority: junior')
    expect(reasonOf(job({ title: 'Gameplay Programmer', seniority: ['senior'] }), wantsSenior)).toBeNull()
  })

  it('passes when any one of several stated levels is wanted', () => {
    expect(reasonOf(job({ seniority: ['mid', 'senior'] }), wantsSenior)).toBeNull()
  })

  it('lets the title win over the source level', () => {
    expect(reasonOf(job({ title: 'Senior Gameplay Programmer', seniority: ['junior'] }), wantsSenior)).toBeNull()
    expect(reasonOf(job({ title: 'Junior Gameplay Programmer', seniority: ['senior'] }), wantsSenior)).toBe('seniority: junior')
  })

  it('passes a job whose source states no level', () => {
    expect(reasonOf(job({ seniority: [] }), wantsSenior)).toBeNull()
    expect(reasonOf(job({}), wantsSenior)).toBeNull()
  })
})

describe('the profile reaches the free filters', () => {
  async function setup(application: Partial<ReturnType<typeof makeProfile>['application']>) {
    const env = await makeTestEnv()
    const base = makeProfile()
    env.ctx.profile.save({ ...base, application: { ...base.application, ...application } })
    env.ctx.settings.update({ preferences: { locations: ['Austin, TX'], remote: [], targetTitles: [] }, thresholds: { prescoreMin: 0 } })
    return env
  }
  const berlin = () => makeRaw({ externalId: 'b', title: 'Software Engineer', location: 'Berlin, Germany', remote: 'onsite' })

  it('drops a job outside the location list', async () => {
    const env = await setup({})
    expect(applyFree(env.ctx, ingestRaw(env.ctx, berlin()).job, buildFreeEnv(env.ctx))).toBe('filtered_out')
  })

  it('keeps a job in a place the owner would move to', async () => {
    const env = await setup({ relocation: { willing: true, places: ['Berlin'] } })
    expect(applyFree(env.ctx, ingestRaw(env.ctx, berlin()).job, buildFreeEnv(env.ctx))).toBe('new')
  })

  it('stores the level a source states and keeps it when the posting is listed again', async () => {
    const env = await setup({ relocation: { willing: true, places: ['Berlin'] } })
    const first = ingestRaw(env.ctx, { ...berlin(), seniority: ['mid', 'senior'], minYears: 3 }).job
    expect(first).toMatchObject({ seniority: ['mid', 'senior'], minYears: 3 })
    const again = ingestRaw(env.ctx, berlin()).job
    expect(again).toMatchObject({ id: first.id, seniority: ['mid', 'senior'], minYears: 3 })
  })

  it('changes the filter fingerprint when authorization or relocation changes', async () => {
    const env = await setup({})
    const before = freeFingerprint(buildFreeEnv(env.ctx))
    const base = env.ctx.profile.get().profile
    env.ctx.profile.save({ ...base, application: { ...base.application, relocation: { willing: true, places: ['Berlin'] } } })
    expect(freeFingerprint(buildFreeEnv(env.ctx))).not.toBe(before)
  })
})
