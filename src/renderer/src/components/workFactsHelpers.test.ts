import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, JobPreferences } from '@shared/types'
import { cleanApplication } from './applicationFactsHelpers'
import { cleanWorkFacts, fillFilterFromAnswers, filterFromAnswers, filterIsDefault, nameParts, splitFullName, toggled, triParse, triValue } from './workFactsHelpers'

const facts = (patch: Partial<ApplicationFacts> = {}): ApplicationFacts => ({ ...structuredClone(EMPTY_APPLICATION_FACTS), ...patch })
const prefs = (patch: Partial<JobPreferences> = {}): JobPreferences => ({ ...structuredClone(DEFAULT_SETTINGS.preferences), ...patch })

describe('three-way answers', () => {
  it('keeps Not answered apart from No', () => {
    expect(triValue(null)).toBe('')
    expect(triValue(false)).toBe('no')
    expect(triValue(true)).toBe('yes')
    expect(triParse('')).toBeNull()
    expect(triParse('no')).toBe(false)
    expect(triParse('yes')).toBe(true)
  })
})

describe('toggled', () => {
  it('adds a missing item and removes a present one', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('job filter from the answers', () => {
  it('treats all three work styles and no employment type as the default', () => {
    expect(filterIsDefault(prefs())).toBe(true)
    expect(filterIsDefault(prefs({ remote: ['remote'] }))).toBe(false)
    expect(filterIsDefault(prefs({ employmentTypes: ['contract'] }))).toBe(false)
  })

  it('changes nothing when nothing is answered', () => {
    expect(filterFromAnswers(facts())).toBeNull()
    expect(fillFilterFromAnswers(prefs(), facts())).toEqual(prefs())
  })

  it('drops a work style answered No and keeps Yes and Not answered', () => {
    const f = facts({ workArrangement: { ...EMPTY_APPLICATION_FACTS.workArrangement, remote: true, onsite: false } })
    expect(filterFromAnswers(f)).toEqual({ remote: ['remote', 'hybrid'], employmentTypes: [] })
  })

  it('does not narrow on Yes alone', () => {
    const f = facts({ workArrangement: { ...EMPTY_APPLICATION_FACTS.workArrangement, remote: true } })
    expect(filterFromAnswers(f)).toBeNull()
  })

  it('keeps the default when all three are ruled out', () => {
    const f = facts({ workArrangement: { ...EMPTY_APPLICATION_FACTS.workArrangement, remote: false, hybrid: false, onsite: false } })
    expect(filterFromAnswers(f)).toBeNull()
  })

  it('copies the employment types', () => {
    const f = facts({ employment: { ...EMPTY_APPLICATION_FACTS.employment, types: ['full_time', 'contract'] } })
    const out = fillFilterFromAnswers(prefs(), f)
    expect(out.employmentTypes).toEqual(['full_time', 'contract'])
    expect(out.remote).toEqual(['remote', 'hybrid', 'onsite'])
  })

  it('leaves a filter alone once it is no longer the default', () => {
    const f = facts({ employment: { ...EMPTY_APPLICATION_FACTS.employment, types: ['full_time'] } })
    const own = prefs({ remote: ['remote'] })
    expect(fillFilterFromAnswers(own, f)).toBe(own)
  })
})

describe('name parts', () => {
  it('splits a full name of two or more words and leaves the middle empty', () => {
    expect(splitFullName('Alex Rivera')).toEqual({ first: 'Alex', last: 'Rivera' })
    expect(splitFullName('Mary Ann Smith')).toEqual({ first: 'Mary', last: 'Ann Smith' })
    expect(splitFullName('Cher')).toEqual({ first: '', last: '' })
  })

  it('prefers stored parts over the full name', () => {
    const name = { ...EMPTY_PROFILE.name, first: 'Mary Ann', last: 'Smith', preferred: 'Annie' }
    expect(nameParts({ fullName: 'Mary Ann Smith', name })).toEqual(name)
  })

  it('fills first and last from the full name when both are empty', () => {
    expect(nameParts({ fullName: 'Alex Rivera', name: EMPTY_PROFILE.name })).toMatchObject({ first: 'Alex', last: 'Rivera', preferred: '' })
  })

  it('reads a profile with no name object', () => {
    expect(nameParts({ fullName: 'Alex Rivera', name: undefined as never })).toMatchObject({ first: 'Alex', last: 'Rivera' })
  })
})

describe('cleanWorkFacts', () => {
  it('does not save an Other clearance with no name', () => {
    expect(cleanWorkFacts(facts({ clearance: 'Other' })).clearance).toBe('')
    expect(cleanWorkFacts(facts({ clearance: ' other ' })).clearance).toBe('')
  })

  it('keeps a named clearance', () => {
    expect(cleanWorkFacts(facts({ clearance: 'NATO Secret' })).clearance).toBe('NATO Secret')
    expect(cleanWorkFacts(facts({ clearance: 'Secret' })).clearance).toBe('Secret')
  })

  it('keeps 0 and null apart', () => {
    const f = facts({ experience: { ...EMPTY_APPLICATION_FACTS.experience, gamesIndustry: 0, shippedTitles: null }, workArrangement: { ...EMPTY_APPLICATION_FACTS.workArrangement, maxOfficeDaysPerWeek: 0, onsite: false } })
    const out = cleanWorkFacts(cleanApplication(f))
    expect(out.experience.gamesIndustry).toBe(0)
    expect(out.experience.shippedTitles).toBeNull()
    expect(out.workArrangement.maxOfficeDaysPerWeek).toBe(0)
    expect(out.workArrangement.onsite).toBe(false)
    expect(out.workArrangement.remote).toBeNull()
  })

  it('drops blank list entries and an empty graduation date', () => {
    const f = facts({
      citizenships: [' Germany ', ''],
      schedule: { ...EMPTY_APPLICATION_FACTS.schedule, timeZones: ['', 'CET'] },
      education: { ...EMPTY_APPLICATION_FACTS.education, expectedGraduation: '', fields: ['  '], relatedFields: ['Software Engineering'] }
    })
    const out = cleanWorkFacts(f)
    expect(out.citizenships).toEqual(['Germany'])
    expect(out.schedule.timeZones).toEqual(['CET'])
    expect(out.education.expectedGraduation).toBeNull()
    expect(out.education.fields).toEqual([])
  })

  it('is stable when run twice', () => {
    const once = cleanWorkFacts(facts({ clearance: 'Other', citizenships: [' x '] }))
    expect(cleanWorkFacts(once)).toEqual(once)
  })
})
