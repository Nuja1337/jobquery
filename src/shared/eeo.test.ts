import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './defaults'
import { defaultEeo, normalizeEeo, UK_ETHNICITY_IDS } from './eeo'

const D = DEFAULT_SETTINGS.eeo

describe('normalizeEeo on rows saved before version 2', () => {
  it('reads a legacy Male and No row as ids with the other families on decline', () => {
    expect(normalizeEeo({ gender: 'Male', veteran: 'No' })).toEqual({ ...D, gender: 'man', veteran: 'not_protected' })
  })

  it('maps the common wordings', () => {
    const got = normalizeEeo({ gender: 'Female', race: 'White', veteran: 'I am not a protected veteran', disability: 'No, I do not have a disability', pronouns: 'she/her' })
    expect(got).toEqual({ ...D, gender: 'woman', race: ['white'], veteran: 'not_protected', disability: 'no', pronouns: 'she' })
  })

  it('reads Hispanic or Latino as the Hispanic answer, not a race', () => {
    expect(normalizeEeo({ race: 'Hispanic or Latino' })).toMatchObject({ hispanicLatino: 'yes', race: [] })
    expect(normalizeEeo({ race: 'White (Not Hispanic or Latino)' })).toMatchObject({ hispanicLatino: 'no', race: ['white'] })
  })

  it('tells the Asian groups apart', () => {
    expect(normalizeEeo({ race: 'East Asian' }).race).toEqual(['asian_east'])
    expect(normalizeEeo({ race: 'Southeast Asian' }).race).toEqual(['asian_southeast'])
    expect(normalizeEeo({ race: 'South Asian' }).race).toEqual(['asian_south'])
    expect(normalizeEeo({ race: 'Asian (Not Hispanic or Latino)' })).toMatchObject({ race: ['asian'], hispanicLatino: 'no' })
  })

  it('treats decline wording and whitespace as decline', () => {
    const declined = { gender: ' ', race: 'decline', veteran: "I don't wish to answer", disability: 'I do not want to answer', pronouns: '' }
    expect(normalizeEeo(declined)).toEqual(D)
    expect(normalizeEeo({ gender: 'Decline to self-identify', veteran: 'I prefer not to answer' })).toEqual(D)
  })

  it('keeps unknown gender and pronoun text where the family has a text field', () => {
    expect(normalizeEeo({ gender: 'Agender', pronouns: 'xe/xem' })).toMatchObject({ gender: 'self_describe', genderText: 'Agender', pronouns: 'custom', pronounsText: 'xe/xem' })
  })

  it('declines unknown text where the family has no text field', () => {
    expect(normalizeEeo({ race: 'Two or More Races', veteran: 'Maybe', disability: 'Sometimes' })).toEqual(D)
  })

  it('does not treat a veteran who is not protected as protected', () => {
    expect(normalizeEeo({ veteran: 'I am a veteran, but not a protected veteran' }).veteran).toBe('not_protected')
    expect(normalizeEeo({ veteran: 'I identify as one or more of the classifications of protected veteran' }).veteran).toBe('protected')
  })

  it('does not pick the status in a "but choose not to self-identify" wording', () => {
    expect(normalizeEeo({ veteran: 'I identify as a protected veteran, but choose not to self-identify' }).veteran).toBe('decline')
  })
})

describe('normalizeEeo on version 2 rows', () => {
  it('returns a complete v2 row unchanged', () => {
    const row = {
      ...D,
      gender: 'self_describe' as const,
      genderText: 'Agender',
      transgender: 'no' as const,
      hispanicLatino: 'no' as const,
      race: ['asian_east' as const, 'white' as const],
      veteran: 'protected' as const,
      veteranCategories: ['disabled' as const, 'service_medal' as const],
      militaryService: 'yes' as const,
      militarySpouse: 'no' as const,
      disability: 'yes' as const,
      sexualOrientation: ['queer' as const, 'self_describe' as const],
      sexualOrientationText: 'Demisexual',
      lgbtq: 'yes' as const,
      pronouns: 'custom' as const,
      pronounsText: 'xe/xem',
      birthYear: 1990,
      ukEthnicity: 'mixed_white_black_caribbean' as const,
      religion: 'sikh' as const,
      caring: 'yes' as const,
      socioeconomic: { householdOccupation: 'technical_craft' as const, schoolType: 'state_selective' as const, freeSchoolMeals: 'no' as const, parentDegree: 'yes' as const },
      neurodivergent: 'no' as const
    }
    expect(normalizeEeo(row)).toEqual(row)
  })

  it('fills keys a partial v2 row leaves out', () => {
    expect(normalizeEeo({ version: 2, gender: 'woman' })).toEqual({ ...D, gender: 'woman' })
  })

  it('does not run the legacy mapping on a v2 row with an unknown id', () => {
    expect(normalizeEeo({ version: 2, gender: 'Male', disability: 'No' })).toEqual(D)
  })

  it('keeps race ids once each, in a fixed order, and drops unknown ones', () => {
    expect(normalizeEeo({ version: 2, race: ['white', 'asian', 'white', 'martian'] }).race).toEqual(['asian', 'white'])
  })

  it('keeps veteran categories only for a protected veteran', () => {
    expect(normalizeEeo({ version: 2, veteran: 'not_protected', veteranCategories: ['disabled'] }).veteranCategories).toEqual([])
    expect(normalizeEeo({ version: 2, veteran: 'protected', veteranCategories: ['disabled', 'nope'] }).veteranCategories).toEqual(['disabled'])
  })

  it('accepts a birth year in range and nothing else', () => {
    expect(normalizeEeo({ version: 2, birthYear: 1985 }).birthYear).toBe(1985)
    for (const bad of [1850, 3000, 1985.5, '1985', NaN, null, undefined]) expect(normalizeEeo({ version: 2, birthYear: bad }).birthYear).toBeNull()
  })

  it('ignores unknown keys and a newer version number', () => {
    const got = normalizeEeo({ version: 3, gender: 'man', shoeSize: 'x' })
    expect(got).toEqual({ ...D, gender: 'man' })
    expect(got).not.toHaveProperty('shoeSize')
  })
})

describe('normalizeEeo on malformed input', () => {
  it.each([null, undefined, 'Male', 7, true, [], ['gender'], {}])('returns the defaults for %j', (raw) => {
    expect(normalizeEeo(raw)).toEqual(D)
  })

  it('does not throw on fields of the wrong type', () => {
    const odd = { gender: 5, race: { a: 1 }, veteran: [], disability: null, pronouns: 3 }
    expect(normalizeEeo(odd)).toEqual(D)
    expect(normalizeEeo({ version: 2, gender: {}, race: 'white', genderText: 4, birthYear: {} })).toEqual(D)
  })

  it('returns a fresh object each time', () => {
    const a = defaultEeo()
    a.race.push('white')
    expect(defaultEeo().race).toEqual([])
    expect(normalizeEeo(null).race).toEqual([])
  })
})

describe('normalizeEeo on the UK and EU families', () => {
  it('declines every UK and EU family by default', () => {
    expect(D).toMatchObject({
      ukEthnicity: 'decline',
      religion: 'decline',
      caring: 'decline',
      neurodivergent: 'decline',
      socioeconomic: { householdOccupation: 'decline', schoolType: 'decline', freeSchoolMeals: 'decline', parentDegree: 'decline' }
    })
  })

  it('fills the UK and EU keys on a v2 row saved before they existed', () => {
    const oldV2: Record<string, unknown> = { ...D, gender: 'woman' }
    for (const key of ['ukEthnicity', 'religion', 'caring', 'socioeconomic', 'neurodivergent']) delete oldV2[key]
    expect(normalizeEeo(oldV2)).toEqual({ ...D, gender: 'woman' })
  })

  it('keeps known ids and replaces unknown ones with decline', () => {
    const got = normalizeEeo({
      version: 2,
      ukEthnicity: 'white_roma',
      religion: 'Sikh',
      caring: 'yes',
      neurodivergent: 'maybe',
      socioeconomic: { householdOccupation: 'retired', schoolType: 'boarding', freeSchoolMeals: 'yes', parentDegree: 7 }
    })
    expect(got).toMatchObject({
      ukEthnicity: 'white_roma',
      religion: 'decline',
      caring: 'yes',
      neurodivergent: 'decline',
      socioeconomic: { householdOccupation: 'retired', schoolType: 'decline', freeSchoolMeals: 'yes', parentDegree: 'decline' }
    })
  })

  it('covers the 19 ONS subgroups', () => {
    expect(UK_ETHNICITY_IDS).toHaveLength(20)
    for (const id of UK_ETHNICITY_IDS) expect(normalizeEeo({ version: 2, ukEthnicity: id }).ukEthnicity).toBe(id)
  })

  it('treats a socioeconomic value that is not an object as all decline', () => {
    expect(normalizeEeo({ version: 2, socioeconomic: 'yes' }).socioeconomic).toEqual(D.socioeconomic)
    expect(normalizeEeo({ version: 2, socioeconomic: [] }).socioeconomic).toEqual(D.socioeconomic)
  })
})
