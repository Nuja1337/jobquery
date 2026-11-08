import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, FieldType, FormField, Profile } from '@shared/types'
import { mapApplicationField } from './applicationFacts'
import { mapInferredField, mapKnownField, type MappedAnswer } from './fieldMap'

// A fact answer must never claim more than the facts say. Where the facts cannot answer, the field
// is flagged with a note.

const FACTS: ApplicationFacts = {
  ...structuredClone(EMPTY_APPLICATION_FACTS),
  authorization: [{ country: 'Canada', status: 'citizen', needsSponsorship: false, notes: '' }],
  salary: [{ currency: 'USD', min: 110000, target: 130000, period: 'year', answerStyle: 'range' }],
  noticeWeeks: 2,
  relocation: { willing: true, places: [] },
  skillYears: { 'C++': 6 },
  clearance: 'Secret',
  driversLicense: true,
  over18: true
}
const profileWith = (patch: Partial<ApplicationFacts> = {}, yearsExperience: number | null = 8): Profile => ({
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  location: 'Toronto, ON',
  yearsExperience,
  workAuthorization: { authorizedCountries: ['Canada'], needsSponsorship: false, notes: '' },
  application: { ...FACTS, ...patch }
})
const field = (label: string, type: FieldType = 'select'): FormField => ({
  key: 'q', label, type, required: true, options: type === 'select' ? ['Yes', 'No'] : [], placeholder: null, maxLength: null, fileHint: null
})
const NOW = new Date(2026, 10, 7)
const ctxOf = (profile: Profile, jobLocation = 'Austin, TX') => ({
  profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse' as const, jobLocation, company: 'Acme', now: NOW
})

/** What the fact branches alone say. */
const facts = (label: string, profile = profileWith(), type: FieldType = 'select'): MappedAnswer | null =>
  mapApplicationField(field(label, type), ctxOf(profile))
/** What the whole mapper says, as the filler sees it. */
const mapped = (label: string, profile = profileWith(), type: FieldType = 'select'): MappedAnswer | null => {
  const f = field(label, type)
  const ctx = ctxOf(profile)
  return mapKnownField(f, ctx) ?? mapInferredField(f, ctx)
}

const expectFlag = (r: MappedAnswer | null) => {
  expect(r).not.toBeNull()
  expect(r?.needsUser).toBe(true)
  expect(r?.value).toBe('')
  expect(r?.note).toBeTruthy()
}
const expectValue = (r: MappedAnswer | null, value: string) => {
  expect(r?.value).toBe(value)
  expect(r?.needsUser).toBe(false)
  expect(r?.source).toBe('profile')
}

describe('years of a kind of work', () => {
  const flagged = [
    'Do you have 2+ years shipping AAA titles?',
    'Do you have 2+ years of experience shipping AAA titles?',
    'Do you have 3+ years of experience in the games industry?',
    'Do you have 3 years of experience in a lead role?',
    'Do you have 5 years of experience in a senior role?',
    'Do you have at least 3 years of experience leading a team?',
    'Do you have 3 years of console experience?',
    'Do you have 4+ years of experience with mobile games?'
  ]
  it.each(flagged)('flags "%s"', (label) => {
    expectFlag(facts(label))
  })

  it('still answers general experience from the total', () => {
    expectValue(facts('Do you have 5 years of professional experience?'), 'Yes')
    expectValue(facts('Do you have 5+ years of relevant work experience?'), 'Yes')
    expectValue(facts('Do you have at least 5 years of experience?'), 'Yes')
    expectValue(facts('Do you have 5 years of professional experience?', profileWith({}, 3)), 'No')
    expectValue(facts('Do you have more than 8 years of total professional experience?'), 'No')
  })

  it('still answers a named skill from its years', () => {
    expectValue(facts('Do you have 5+ years of experience with C++?'), 'Yes')
    expectValue(facts('Do you have at least 8 years of experience with C++?'), 'No')
  })

  it('does not read an age question as years of work', () => {
    expect(facts('Are you at least 18 years old?')?.needsUser).toBe(false)
  })
})

describe('age questions with a second requirement', () => {
  const compound = [
    'Are you 18 years of age or older and legally authorized to work in the United States?',
    'Are you at least 18 years old and authorized to work in the US without sponsorship?',
    "Are you at least 18 years old with a valid driver's license?",
    'Are you over 18 and eligible to work in the U.S.?',
    'I am at least 18 years of age and legally authorized to work in the United States'
  ]
  const authorized = compound.filter((l) => !/license/.test(l))

  it.each(compound)('says No when the person is under 18: "%s"', (label) => {
    expectValue(facts(label, profileWith({ over18: false })), 'No')
  })

  it.each(compound)('flags when the age is not answered: "%s"', (label) => {
    expectFlag(facts(label, profileWith({ over18: null })))
  })

  it.each(authorized)('leaves the rest to the other branches when over 18: "%s"', (label) => {
    // The age fact alone must not answer Yes. The authorization branch decides.
    expect(facts(label)).toBeNull()
  })

  it.each(authorized)('answers No to a Canadian citizen on a US job: "%s"', (label) => {
    const r = mapped(label)
    expect(r?.value).not.toBe('Yes')
    expect(r === null || r.needsUser || r.value === 'No').toBe(true)
  })

  it('answers No to age plus license when the person has no license', () => {
    expectValue(facts("Are you at least 18 years old with a valid driver's license?", profileWith({ driversLicense: false })), 'No')
  })

  it('answers Yes to age plus license when the person has both', () => {
    expectValue(facts("Are you at least 18 years old with a valid driver's license?"), 'Yes')
  })

  it('does not let the license fact answer a license plus authorization question', () => {
    expect(facts("Do you have a valid driver's license and are you authorized to work in the US?")).toBeNull()
  })

  it('still answers a plain age question', () => {
    expectValue(facts('Are you at least 18 years of age?'), 'Yes')
    expectValue(facts('Are you at least 18 years of age?', profileWith({ over18: false })), 'No')
    expectValue(facts('Are you under 18?'), 'No')
  })
})

describe('security clearance', () => {
  it('matches levels as whole words', () => {
    expectFlag(facts('Do you hold an active TS clearance?', profileWith({ clearance: 'Secret' })))
    expectFlag(facts('Do you hold an active Top Secret clearance?', profileWith({ clearance: 'Secret' })))
    expectValue(facts('Do you hold an active Secret clearance?', profileWith({ clearance: 'Secret' })), 'Yes')
  })

  it('does not take a level from the middle of another word', () => {
    // "ts" sits inside "meets" and "secret" inside "secretary". Neither names a level.
    expectValue(facts('Do you hold a clearance that meets the contract needs?', profileWith({ clearance: 'Secret' })), 'Yes')
    expectValue(facts('Our secretary asks: do you hold an active clearance?', profileWith({ clearance: 'Confidential' })), 'Yes')
  })

  it('does not count Public Trust as an active clearance', () => {
    expectFlag(facts('Do you hold an active security clearance?', profileWith({ clearance: 'Public Trust' })))
    expectValue(facts('Do you hold a Public Trust clearance?', profileWith({ clearance: 'Public Trust' })), 'Yes')
  })

  it('does not count a bare Other as a clearance', () => {
    expectFlag(facts('Do you hold an active security clearance?', profileWith({ clearance: 'Other' })))
  })

  it('still answers from a held clearance', () => {
    expectValue(facts('Do you hold an active security clearance?', profileWith({ clearance: 'Secret' })), 'Yes')
    expectValue(facts('Do you hold an active security clearance?', profileWith({ clearance: 'None' })), 'No')
  })
})

describe('start date and notice as yes/no questions', () => {
  it('compares the start with the time asked', () => {
    expectValue(facts('Can you start within 2 weeks?'), 'Yes')
    expectValue(facts('Can you start within 1 week?'), 'No')
    expectValue(facts('Are you able to start within 30 days?'), 'Yes')
    expectValue(facts('Are you available to start within one month?'), 'Yes')
    expectValue(facts('Can you start in less than 2 weeks?'), 'No')
    expectValue(facts('Can you start within 2 weeks?', profileWith({ noticeWeeks: 4 })), 'No')
  })

  it('counts the earliest start date when it is later than the notice period', () => {
    const later = profileWith({ noticeWeeks: 2, earliestStart: '2027-01-15' })
    expectValue(facts('Can you start within 4 weeks?', later), 'No')
    expectValue(facts('Can you start within 3 months?', later), 'Yes')
  })

  it('flags when there is nothing to compare', () => {
    expectFlag(facts('Can you start within 2 weeks?', profileWith({ noticeWeeks: null })))
  })

  it('inverts "longer than" and "more than"', () => {
    expectValue(facts('Is your notice period longer than 1 month?'), 'No')
    expectValue(facts('Is your notice period longer than 1 week?'), 'Yes')
    expectValue(facts('Is your notice period more than 14 days?'), 'No')
    expectValue(facts('Is your notice period more than 13 days?'), 'Yes')
    expectValue(facts('Is your notice period shorter than 3 weeks?'), 'Yes')
    expectValue(facts('Is your notice period 2 weeks or less?'), 'Yes')
    expectValue(facts('Is your notice period at least 4 weeks?'), 'No')
    expectValue(facts('Is your notice period longer than 1 month?', profileWith({ noticeWeeks: 8 })), 'Yes')
  })

  it('flags a comparison it cannot read', () => {
    expectFlag(facts('Is your notice period longer than 1 week but shorter than 3 weeks?'))
    expectFlag(facts('Is your notice period 2 weeks?'))
  })
})

describe('relocation at the owner\'s own cost', () => {
  it.each([
    'Are you willing to relocate at your own expense?',
    'Are you willing to relocate to Irvine, CA at your own expense?',
    'Are you open to relocating? Relocation is self-funded.',
    'Are you willing to relocate? Relocation expenses are not covered.'
  ])('flags "%s"', (label) => {
    expectFlag(facts(label))
  })

  it('still answers a plain relocation question', () => {
    expectValue(facts('Are you willing to relocate?'), 'Yes')
  })

  it('answers No when the person would not relocate at all', () => {
    expectValue(facts('Are you willing to relocate at your own expense?', profileWith({ relocation: { willing: false, places: [] } })), 'No')
  })

  it('leaves relocation assistance questions to other branches', () => {
    expect(facts('Do you need relocation assistance?')).toBeNull()
  })
})

describe('salary wording that asks for agreement', () => {
  it.each([
    'Are you comfortable with a salary of 80,000?',
    'Is a salary range of $100,000 to $120,000 acceptable?',
    'Does our salary range align with your expectations?',
    'Would a base salary of $90,000 work for you?'
  ])('flags "%s"', (label) => {
    expectFlag(facts(label))
  })

  it('still answers an expected salary question', () => {
    expect(facts('What are your salary expectations?', profileWith(), 'text')?.value).toContain('110,000')
  })
})
