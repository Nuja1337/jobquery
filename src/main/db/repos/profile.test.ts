import { describe, expect, it } from 'vitest'
import { EMPTY_APPLICATION_FACTS } from '@shared/defaults'
import { makeProfile, makeTestEnv } from '../../testing'

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

  it('does not share the empty facts between loads', async () => {
    const { ctx } = await makeTestEnv()
    const loaded = ctx.profile.get().profile
    loaded.application.skillYears.Go = 3
    expect(EMPTY_APPLICATION_FACTS.skillYears).toEqual({})
    expect(ctx.profile.get().profile.application.skillYears).toEqual({})
  })
})
