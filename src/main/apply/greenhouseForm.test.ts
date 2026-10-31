import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Profile } from '@shared/types'
import fixture from './__fixtures__/greenhouse-questions.json'
import { mapKnownField } from './fieldMap'
import { greenhouseFields } from './greenhouseForm'

const profile: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  phone: '555-0100',
  links: { ...EMPTY_PROFILE.links, linkedin: 'https://linkedin.com/in/sam', website: 'https://sam.dev' },
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' }
}

describe('greenhouseFields (real job board API response)', () => {
  const fields = greenhouseFields(fixture as never)
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]))
  const ctx = { profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse' as const, jobLocation: 'San Francisco, CA', company: 'Anthropic' }
  const byLabel = (re: RegExp) => fields.find((f) => re.test(f.label))!

  it('converts questions, keeping the file upload over the paste-in alternative', () => {
    expect(byKey.first_name).toMatchObject({ type: 'text', required: true })
    expect(byKey.email.type).toBe('email')
    expect(byKey.phone.type).toBe('tel')
    expect(byKey.resume).toMatchObject({ type: 'file', fileHint: 'resume' })
    expect(byKey.resume_text).toBeUndefined()
    expect(byKey.veteran_status).toMatchObject({ type: 'select', label: 'Veteran status' })
  })

  it('answers the standard questions from the profile', () => {
    expect(mapKnownField(byKey.first_name, ctx)?.value).toBe('Sam')
    expect(mapKnownField(byLabel(/^Do you require visa sponsorship/), ctx)?.value).toBe('No')
    expect(mapKnownField(byLabel(/^LinkedIn/), ctx)?.value).toContain('linkedin.com')
    expect(mapKnownField(byKey.veteran_status, ctx)?.value).toMatch(/don't wish/i)
  })

  it('leaves the AI policy and arbitration questions to the person', () => {
    const ai = mapKnownField(byLabel(/AI Policy/), ctx)
    expect(ai?.needsUser).toBe(true)
    expect(ai?.note).toMatch(/AI use/)
    expect(mapKnownField(byLabel(/Agreement to Arbitrate/), ctx)?.needsUser).toBe(true)
  })
})
