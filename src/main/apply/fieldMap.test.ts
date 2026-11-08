import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField, Profile } from '@shared/types'
import { mapKnownField, mustAskUser, pickOption } from './fieldMap'

// Cases an audit found giving false answers that would pass the auto-submit checks.

const PROFILE: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  phone: '555-0100',
  yearsExperience: 12,
  links: { ...EMPTY_PROFILE.links, github: 'https://github.com/sam', linkedin: 'https://linkedin.com/in/sam' },
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' }
}

const field = (label: string, type: FieldType = 'text', options: string[] = []): FormField => ({
  key: 'q',
  label,
  type,
  required: true,
  options,
  placeholder: null,
  maxLength: null,
  fileHint: null
})

const map = (f: FormField, profile: Profile = PROFILE, jobLocation: string | null = 'New York, NY') =>
  mapKnownField(f, { profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse', jobLocation, company: 'Acme' })

describe('sponsorship questions', () => {
  const yesNo = (label: string) => field(label, 'select', ['Yes', 'No'])
  const needsVisa: Profile = { ...PROFILE, workAuthorization: { ...PROFILE.workAuthorization, needsSponsorship: true } }

  it('answers "authorized without sponsorship" as the opposite of "needs sponsorship"', () => {
    const q = yesNo('Are you legally authorized to work in the United States without sponsorship?')
    expect(map(q)?.value).toBe('Yes')
    expect(map(q, needsVisa)?.value).toBe('No')
  })

  it('answers "can you work without sponsorship" from the sponsorship setting', () => {
    expect(map(yesNo('Can you work for us without visa sponsorship?'))?.value).toBe('Yes')
    expect(map(yesNo('Can you work for us without visa sponsorship?'), needsVisa)?.value).toBe('No')
  })

  it('answers the plain question directly', () => {
    expect(map(yesNo('Will you now or in the future require sponsorship for employment visa status?'))?.value).toBe('No')
    expect(map(yesNo('Will you now or in the future require sponsorship for employment visa status?'), needsVisa)?.value).toBe('Yes')
  })

  it('knows someone needs sponsorship in a country they are not authorized in', () => {
    const canadaOnly: Profile = { ...PROFILE, workAuthorization: { authorizedCountries: ['Canada'], needsSponsorship: false, notes: '' } }
    expect(map(yesNo('Can you work in the United States without visa sponsorship?'), canadaOnly)?.value).toBe('No')
    expect(map(yesNo('Will you require sponsorship to work in the US?'), canadaOnly)?.value).toBe('Yes')
    expect(map(yesNo('Will you require sponsorship to work in Canada?'), canadaOnly)?.value).toBe('No')
  })

  it('leaves negated wording to the user', () => {
    const mapped = map(yesNo("Is it true that you won't need sponsorship?"))
    expect(mapped).toMatchObject({ value: '', needsUser: true })
  })
})

describe('years of experience', () => {
  it('fills the total only when no skill is named', () => {
    expect(map(field('How many years of experience do you have?', 'number'))?.value).toBe('12')
    // A skill the profile has no years for is the person's to answer, never the total.
    expect(map(field('How many years of experience do you have with Rust?', 'number'))).toMatchObject({ value: '', needsUser: true })
    expect(map(field('Years of experience in Kubernetes'))).toMatchObject({ value: '', needsUser: true })
    expect(map(field('How many years of Python experience do you have?', 'number'))).toMatchObject({ value: '', needsUser: true })
    expect(map(field('Years of professional experience', 'number'))?.value).toBe('12')
  })
})

describe('contact and link fields', () => {
  it('fills short fields that ask for the value', () => {
    expect(map(field('GitHub profile'))?.value).toBe('https://github.com/sam')
    expect(map(field('Mobile'))?.value).toBe('555-0100')
    expect(map(field('Mobile phone number'))?.value).toBe('555-0100')
    expect(map(field('Email address', 'email'))?.value).toBe('sam@example.com')
  })

  it('leaves questions that mention them to the writer', () => {
    expect(map(field('Describe your experience with GitHub Actions', 'textarea'))).toBeNull()
    expect(map(field('Describe your experience with GitHub Actions'))).toBeNull()
    expect(map(field('Tell us about a mobile app you shipped'))).toBeNull()
    expect(map(field('Mobile app experience'))).toBeNull()
    expect(map(field('GitHub Actions experience'))).toBeNull()
    expect(map(field('Share a link to a project you built on GitHub'))).toBeNull()
  })
})

describe('pickOption', () => {
  it('compares whole words', () => {
    expect(pickOption(['Cisgender female', 'Cisgender male', 'Non-binary'], 'Male')).toBe('Cisgender male')
    expect(pickOption(['White/Caucasian', 'East Asian', 'Black'], 'Asian')).toBe('East Asian')
    expect(pickOption(['White/Caucasian', 'Black'], 'Asian')).toBeNull()
  })

  it('returns null when several options fit', () => {
    expect(pickOption(['Cisgender male', 'Transgender male', 'Female'], 'Male')).toBeNull()
    expect(pickOption(['East Asian', 'South Asian', 'White'], 'Asian')).toBeNull()
    expect(pickOption(['Yes, US citizen', 'Yes, green card holder', 'No'], 'yes')).toBeNull()
  })

  it('still finds the usual matches', () => {
    expect(pickOption(['Yes', 'No'], 'yes')).toBe('Yes')
    expect(pickOption(['Yes, I am', 'No, I am not'], 'no')).toBe('No, I am not')
    expect(pickOption(['Asian (not Hispanic or Latino)', 'White (not Hispanic or Latino)'], 'Asian')).toBe('Asian (not Hispanic or Latino)')
    expect(pickOption(['LinkedIn', 'Company website', 'Referral'], 'Company website')).toBe('Company website')
  })
})

describe('AI-use questions', () => {
  it('catches more wordings', () => {
    for (const label of [
      'Please confirm that you wrote these responses without the help of AI tools',
      'Did you use AI assistance for this?',
      'Were any answers generated by ChatGPT or a similar tool?'
    ]) {
      expect(mustAskUser({ label, type: 'text' }), label).not.toBeNull()
    }
  })

  it('still leaves questions about AI as a subject alone', () => {
    for (const label of [
      'What AI application are you most proud of building?',
      'Why do you want to work on Claude?',
      'How would you apply AI to our product?',
      'Which LLM tools have you used in production?',
      'Describe a project where you used generative AI to solve a problem'
    ]) {
      expect(mustAskUser({ label, type: 'textarea' }), label).toBeNull()
    }
  })

  it('does not treat "confirm your email" as an attestation', () => {
    expect(mustAskUser({ label: 'Confirm your email', type: 'email' })).toBeNull()
  })
})
