import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Education, FieldType, FormField, Profile } from '@shared/types'
import { highestDegree, mapInferredField, mapKnownField, matchFact } from './fieldMap'

// Fact matching refuses opposite polarity. Compound, region and unknown-country questions flag.
// In-progress degrees are never given as earned.

const NOW = new Date(2026, 10, 7)

const BASE: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  phone: '555-0100',
  location: 'Austin, TX',
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' }
}
const withFacts = (facts: Array<{ question: string; answer: string }>): Profile => ({ ...BASE, facts })

const field = (label: string, type: FieldType = 'radio', options: string[] = ['Yes', 'No']): FormField => ({
  key: 'q', label, type, required: true, options, placeholder: null, maxLength: null, fileHint: null
})

const run = (profile: Profile, label: string, location = 'New York, NY', type: FieldType = 'radio', options?: string[]) => {
  const f = field(label, type, options ?? (type === 'radio' ? ['Yes', 'No'] : []))
  const ctx = { profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse' as const, jobLocation: location, company: 'Acme', now: NOW }
  return mapKnownField(f, ctx) ?? mapInferredField(f, ctx)
}

describe('matchFact polarity', () => {
  const short = withFacts([{ question: 'Background check', answer: 'Yes' }])
  const long = withFacts([{ question: 'Are you willing to undergo a background check?', answer: 'Yes' }])

  it('does not answer an opposite-polarity question from a short fact', () => {
    expect(matchFact(short, 'Have you ever failed a background check?')).toBeNull()
    expect(matchFact(short, 'Have you ever refused a background check?')).toBeNull()
    expect(matchFact(short, 'Have you ever been convicted of a felony?')).toBeNull()
    expect(matchFact(withFacts([{ question: 'Drug test', answer: 'Yes' }]), 'Have you ever failed a drug test?')).toBeNull()
    expect(matchFact(withFacts([{ question: 'Relocate', answer: 'Yes' }]), 'Are you unwilling to relocate?')).toBeNull()
    expect(matchFact(withFacts([{ question: 'Willing to travel', answer: 'Yes' }]), 'Are you not willing to travel?')).toBeNull()
    expect(matchFact(withFacts([{ question: 'Willing to travel', answer: 'Yes' }]), "Aren't you willing to travel?")).toBeNull()
  })

  it('does not match a long question from a short fact that shares only part of it', () => {
    expect(matchFact(short, 'Is there anything in your background check we should know about?')).toBeNull()
    expect(matchFact(short, 'Are you willing to undergo a background check?')).toBeNull()
  })

  it('does not let a long fact with a polarity word answer the plain question', () => {
    const failed = withFacts([{ question: 'Have you ever failed a background check?', answer: 'No' }])
    expect(matchFact(failed, 'Are you willing to undergo a background check?')).toBeNull()
    expect(matchFact(failed, 'Have you ever failed a background check?')).toBe('No')
  })

  it('still matches the same question', () => {
    expect(matchFact(long, 'Are you willing to undergo a background check?')).toBe('Yes')
    expect(matchFact(long, 'Are you willing to undergo a background check')).toBe('Yes')
  })

  it('still matches a notice period asked in other words', () => {
    const notice = withFacts([{ question: 'Notice period', answer: '2 weeks' }])
    expect(matchFact(notice, 'What is your notice period?')).toBe('2 weeks')
  })

  it('never lets the short fact answer the polarity question through the field map', () => {
    const got = run(short, 'Have you ever failed a background check?')
    expect(got?.source === 'profile' && got.value === 'Yes' && !got.needsUser).toBe(false)
    expect(run(long, 'Are you willing to undergo a background check?')?.value).toBe('Yes')
  })
})

describe('sponsorship questions', () => {
  const US_ONLY = BASE
  const CANADA_ONLY: Profile = { ...BASE, workAuthorization: { authorizedCountries: ['Canada'], needsSponsorship: false, notes: '' } }

  it('flags a question that asks authorization and sponsorship together', () => {
    for (const label of [
      'Are you legally authorized to work in the United States and will you require sponsorship?',
      'Are you authorized to work in the US, and do you now or in the future require visa sponsorship?',
      'Are you eligible to work in the United States or will you need sponsorship?'
    ]) {
      const got = run(US_ONLY, label)
      expect(got?.needsUser, label).toBe(true)
      expect(got?.value).toBe('')
    }
  })

  it('still answers the "without sponsorship" wording', () => {
    expect(run(US_ONLY, 'Are you authorized to work in the United States without sponsorship?')?.value).toBe('Yes')
  })

  it('still answers a plain sponsorship question when the job country is known', () => {
    expect(run(US_ONLY, 'Will you now or in the future require sponsorship?', 'New York, NY')?.value).toBe('No')
    expect(run(CANADA_ONLY, 'Will you now or in the future require sponsorship?', 'New York, NY')?.value).toBe('Yes')
  })

  it('flags a Remote job when the country is unknown and the owner is authorized in one country', () => {
    const got = run(CANADA_ONLY, 'Will you now or in the future require sponsorship to work for us?', 'Remote')
    expect(got?.needsUser).toBe(true)
    expect(got?.value).toBe('')
    expect(run(CANADA_ONLY, 'Do you require visa sponsorship?', 'Remote')?.needsUser).toBe(true)
  })

  it('flags region names', () => {
    for (const label of [
      'Are you legally authorized to work in North America?',
      'Are you authorized to work in Latin America?',
      'Are you authorized to work in South America?',
      'Do you require sponsorship to work in North America?',
      'Are you authorized to work anywhere in Europe?'
    ]) {
      const got = run(US_ONLY, label)
      expect(got?.needsUser, label).toBe(true)
      expect(got?.value).toBe('')
    }
  })

  it('does not read South Africa as a region', () => {
    expect(run(US_ONLY, 'Are you authorized to work in South Africa?', 'Remote')?.value).toBe('No')
  })
})

describe('degrees in progress', () => {
  const bs: Education = { school: 'State University', degree: 'BS', field: 'Computer Science', start: '2018', end: '2022' }
  const ms: Education = { school: 'Tech Institute', degree: 'MS', field: 'Computer Science', start: '2025', end: '2027' }
  const both: Profile = { ...BASE, education: [bs, ms] }
  const options = ['High School', "Bachelor's Degree", "Master's Degree", 'Doctorate']

  it('highestDegree skips an entry that ends in the future', () => {
    expect(highestDegree(both, NOW)).toBe('BS')
    expect(highestDegree({ ...BASE, education: [ms] }, NOW)).toBeNull()
  })

  it('skips entries that say present or expected', () => {
    expect(highestDegree({ ...BASE, education: [bs, { ...ms, end: 'Present' }] }, NOW)).toBe('BS')
    expect(highestDegree({ ...BASE, education: [bs, { ...ms, end: 'Expected May 2026' }] }, NOW)).toBe('BS')
  })

  it('counts a degree that ended this year or earlier as earned', () => {
    expect(highestDegree({ ...BASE, education: [bs, { ...ms, end: '2026' }] }, NOW)).toBe('MS')
  })

  it('answers the highest degree earned with the bachelor when the master is in progress', () => {
    const got = run(both, 'Highest degree earned', 'Austin, TX', 'select', options)
    expect(got?.value).toBe("Bachelor's Degree")
    expect(run(both, 'Highest level of education completed', 'Austin, TX', 'select', options)?.value).toBe("Bachelor's Degree")
  })

  it('flags a plain Degree question when the latest entry is in progress', () => {
    const got = run(both, 'Degree', 'Austin, TX', 'select', options)
    expect(got?.needsUser).toBe(true)
    expect(got?.value).toBe('')
  })

  it('flags a highest degree question when nothing is earned yet', () => {
    const got = run({ ...BASE, education: [ms] }, 'Highest degree earned', 'Austin, TX', 'select', options)
    expect(got?.needsUser).toBe(true)
  })

  it('answers a plain Degree question when the latest entry is finished', () => {
    expect(run({ ...BASE, education: [bs] }, 'Degree', 'Austin, TX', 'select', options)?.value).toBe("Bachelor's Degree")
  })
})
