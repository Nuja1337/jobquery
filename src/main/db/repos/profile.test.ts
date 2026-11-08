import { describe, expect, it } from 'vitest'
import { EMPTY_APPLICATION_FACTS } from '@shared/defaults'
import { makeProfile, makeTestEnv } from '../../testing'
import { splitFullName } from './profile'

const insertRaw = (db: { run(sql: string, params?: Record<string, string | number>): void }, data: unknown) =>
  db.run('INSERT INTO profile (id, data, version, hash, updated_at) VALUES (1, :data, 1, :hash, :at)', { data: JSON.stringify(data), hash: 'x', at: new Date().toISOString() })

describe('ProfileRepo application facts', () => {
  it('returns the empty facts for a new profile', async () => {
    const { ctx } = await makeTestEnv()
    expect(ctx.profile.get().profile.application).toEqual(EMPTY_APPLICATION_FACTS)
  })

  it('loads a profile saved before the field existed with the defaults', async () => {
    const { ctx } = await makeTestEnv()
    const legacy: Record<string, unknown> = { ...makeProfile({ fullName: 'Sam Rivera' }) }
    delete legacy.application
    insertRaw(ctx.db, legacy)
    const loaded = ctx.profile.get().profile
    expect(loaded.fullName).toBe('Sam Rivera')
    expect(loaded.application).toEqual(EMPTY_APPLICATION_FACTS)
  })

  it('fills the facts a partial application object lacks', async () => {
    const { ctx } = await makeTestEnv()
    insertRaw(ctx.db, { ...makeProfile(), application: { address: { city: 'Austin' }, noticeWeeks: 3, skillYears: { React: 4 }, relocation: { willing: true } } })
    const facts = ctx.profile.get().profile.application
    expect(facts.address).toEqual({ street: '', city: 'Austin', region: '', postalCode: '', country: '' })
    expect(facts.noticeWeeks).toBe(3)
    expect(facts.skillYears).toEqual({ React: 4 })
    expect(facts.relocation).toEqual({ willing: true, places: [] })
    expect(facts.salary).toEqual([])
    expect(facts.references).toBe('Available on request.')
    expect(facts.earliestStart).toBeNull()
    // Facts added later come back as "not answered", and a stored answer is kept.
    expect(facts.relativesAtEmployers).toBeNull()
    expect(facts.referrals).toBe('')
  })

  it('keeps the family and referral facts a profile saved', async () => {
    const { ctx } = await makeTestEnv()
    insertRaw(ctx.db, { ...makeProfile(), application: { relativesAtEmployers: false, referrals: 'none' } })
    const facts = ctx.profile.get().profile.application
    expect(facts.relativesAtEmployers).toBe(false)
    expect(facts.referrals).toBe('none')
  })

  it('saves and returns the facts, and leaves the fit version alone', async () => {
    const { ctx } = await makeTestEnv()
    const first = ctx.profile.save(makeProfile())
    const application = {
      ...EMPTY_APPLICATION_FACTS,
      address: { street: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'United States' },
      salary: [{ currency: 'USD', min: 100000, target: 120000, period: 'year' as const, answerStyle: 'range' as const }],
      skillYears: { React: 6 }
    }
    const second = ctx.profile.save({ ...first.profile, application })
    expect(second.profile.application).toEqual(application)
    expect(second.version).toBe(first.version)
  })

  it('keeps the profile version when only facts the fit view does not show change', async () => {
    const { ctx } = await makeTestEnv()
    const first = ctx.profile.save(makeProfile())
    const application = { ...first.profile.application, experience: { ...first.profile.application.experience, shippedTitles: 2 } }
    expect(ctx.profile.save({ ...first.profile, application }).version).toBe(first.version)
  })

  it('does not share the empty facts between loads', async () => {
    const { ctx } = await makeTestEnv()
    const loaded = ctx.profile.get().profile
    loaded.application.skillYears.Go = 3
    expect(EMPTY_APPLICATION_FACTS.skillYears).toEqual({})
    expect(ctx.profile.get().profile.application.skillYears).toEqual({})
  })
})

describe('ProfileRepo selection facts and name', () => {
  it('gives an old stored application the full defaults for every new fact', async () => {
    const { ctx } = await makeTestEnv()
    // What a profile saved before the selections existed holds: none of the new keys.
    insertRaw(ctx.db, { ...makeProfile(), application: { address: { city: 'Austin' }, noticeWeeks: 3 } })
    const facts = ctx.profile.get().profile.application
    expect(facts).toEqual({ ...EMPTY_APPLICATION_FACTS, address: { ...EMPTY_APPLICATION_FACTS.address, city: 'Austin' }, noticeWeeks: 3 })
    expect(facts.workArrangement.remote).toBeNull()
    expect(facts.employment.currentPay).toEqual({ stance: '', amount: null, currency: '', period: 'year' })
    expect(facts.education.highestCompleted).toBeNull()
    expect(facts.experience.gamesIndustry).toBeNull()
    expect(facts.citizenships).toEqual([])
  })

  it('keeps a stored nested answer and fills the keys it lacks', async () => {
    const { ctx } = await makeTestEnv()
    insertRaw(ctx.db, {
      ...makeProfile(),
      application: {
        workArrangement: { hybrid: true, maxOfficeDaysPerWeek: 2 },
        employment: { types: ['contract'], currentPay: { stance: 'decline' } },
        schedule: { weekends: false },
        screening: { drugTest: true },
        education: { highestCompleted: 'bachelor', fields: ['Computer Science'] },
        experience: { gamesIndustry: 0, platforms: ['pc'] },
        exportControlUsPerson: false
      }
    })
    const facts = ctx.profile.get().profile.application
    expect(facts.workArrangement).toEqual({ remote: null, hybrid: true, onsite: null, maxOfficeDaysPerWeek: 2, commutableCities: [] })
    expect(facts.employment).toEqual({
      types: ['contract'],
      hoursPerWeek: null,
      currentlyEmployed: null,
      desiredTitle: '',
      currentPay: { stance: 'decline', amount: null, currency: '', period: 'year' }
    })
    expect(facts.schedule).toEqual({ evenings: null, weekends: false, nights: null, onCall: null, overtime: null, timeZones: [] })
    expect(facts.screening).toEqual({ backgroundCheck: null, drugTest: true, creditCheck: null })
    expect(facts.education).toEqual({ highestCompleted: 'bachelor', currentlyEnrolled: null, expectedGraduation: null, fields: ['Computer Science'], relatedFields: [] })
    // 0 is an answer and stays 0. Only a missing key reads as null.
    expect(facts.experience).toEqual({ professionalSoftware: null, gamesIndustry: 0, teamLead: null, peopleManagement: null, shippedTitles: null, aaaTitles: null, platforms: ['pc'] })
    expect(facts.exportControlUsPerson).toBe(false)
    expect(facts.clearanceEligible).toBeNull()
  })

  it('gives an authorization entry without visa details the not-answered defaults', async () => {
    const { ctx } = await makeTestEnv()
    insertRaw(ctx.db, {
      ...makeProfile(),
      application: {
        authorization: [
          { country: 'United States', status: 'visa', needsSponsorship: true, notes: '' },
          { country: 'Canada', status: 'visa', needsSponsorship: false, notes: '', visaType: 'tn', expires: '2028-01-31', anyEmployer: false }
        ]
      }
    })
    const [us, ca] = ctx.profile.get().profile.application.authorization
    expect(us).toEqual({ country: 'United States', status: 'visa', needsSponsorship: true, notes: '', visaType: '', expires: null, anyEmployer: null })
    expect(ca).toMatchObject({ visaType: 'tn', expires: '2028-01-31', anyEmployer: false })
  })

  it('saves the new facts and reads them back unchanged', async () => {
    const { ctx } = await makeTestEnv()
    const first = ctx.profile.save(makeProfile())
    const application = {
      ...first.profile.application,
      workArrangement: { remote: true, hybrid: true, onsite: false, maxOfficeDaysPerWeek: 3, commutableCities: ['Austin'] },
      experience: { ...first.profile.application.experience, shippedTitles: 0, platforms: ['pc' as const, 'console' as const] }
    }
    const second = ctx.profile.save({ ...first.profile, application })
    expect(second.profile.application).toEqual(application)
    // The fit view shows work arrangement, so changing it changes the version that fit scores are checked against.
    expect(second.version).toBe(first.version + 1)
  })

  it('splits the name from the full name for a profile saved without one', async () => {
    const { ctx } = await makeTestEnv()
    const legacy: Record<string, unknown> = { ...makeProfile({ fullName: 'Sam Rivera' }) }
    delete legacy.name
    insertRaw(ctx.db, legacy)
    const loaded = ctx.profile.get().profile
    expect(loaded.fullName).toBe('Sam Rivera')
    expect(loaded.name).toEqual({ first: 'Sam', middle: '', last: 'Rivera', preferred: '', pronunciation: '' })
  })

  it('uses the first word as the first name and the rest as the last name', () => {
    expect(splitFullName('Mary Ann  Smith')).toEqual({ first: 'Mary', last: 'Ann Smith' })
    expect(splitFullName('  Alex Rivera ')).toEqual({ first: 'Alex', last: 'Rivera' })
  })

  it('does not split a one-word or empty name', async () => {
    expect(splitFullName('Cher')).toEqual({ first: '', last: '' })
    expect(splitFullName('   ')).toEqual({ first: '', last: '' })
    const { ctx } = await makeTestEnv()
    const legacy: Record<string, unknown> = { ...makeProfile({ fullName: 'Cher' }) }
    delete legacy.name
    insertRaw(ctx.db, legacy)
    expect(ctx.profile.get().profile.name).toEqual({ first: '', middle: '', last: '', preferred: '', pronunciation: '' })
  })

  it('keeps a stored name and fills the keys it lacks', async () => {
    const { ctx } = await makeTestEnv()
    insertRaw(ctx.db, { ...makeProfile({ fullName: 'Samuel Rivera' }), name: { first: 'Samuel', last: 'Rivera-Jones', preferred: 'Sam' } })
    expect(ctx.profile.get().profile.name).toEqual({ first: 'Samuel', middle: '', last: 'Rivera-Jones', preferred: 'Sam', pronunciation: '' })
  })

  it('leaves the full name as it was', async () => {
    const { ctx } = await makeTestEnv()
    const saved = ctx.profile.save(makeProfile({ fullName: 'Dana Q. Public' }))
    expect(saved.profile.fullName).toBe('Dana Q. Public')
    expect(saved.profile.name).toMatchObject({ first: 'Dana', middle: 'Q.', last: 'Public' })
  })
})
