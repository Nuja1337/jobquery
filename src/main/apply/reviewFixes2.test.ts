import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, AuthorizationEntry, FieldType, FormField, Profile, Settings } from '@shared/types'
import { answerFields, type AnswerDeps, type JobForAnswers } from './answers'
import { mapApplicationField } from './applicationFacts'
import { demographicAnswer, demographicFamily } from './demographics'
import { mapInferredField, mapKnownField, type MapContext } from './fieldMap'

// Regression tests for the second code review (applicant facts, availability and self-ID).

const NOW = new Date(2026, 10, 7)

const field = (label: string, type: FieldType = 'select', options: string[] = ['Yes', 'No']): FormField =>
  ({ key: 'q', label, type, required: true, options: type === 'textarea' || type === 'text' ? [] : options, placeholder: null, maxLength: null, fileHint: null }) as FormField

const run = (f: FormField, profile: Profile, ctx: Partial<MapContext> = {}) => {
  const c: MapContext = { profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse', jobLocation: 'Redmond, WA', company: 'Acme', now: NOW, ...ctx }
  return mapKnownField(f, c) ?? mapInferredField(f, c)
}

describe('F1: sponsorship questions that say "any employer"', () => {
  const auth = (a: Partial<AuthorizationEntry>): Profile => ({
    ...EMPTY_PROFILE,
    fullName: 'Sam Rivera',
    location: 'Austin, TX',
    workAuthorization: { authorizedCountries: [], needsSponsorship: false, notes: '' },
    application: { ...structuredClone(EMPTY_APPLICATION_FACTS), authorization: [{ country: 'United States', notes: '', ...a } as AuthorizationEntry] }
  })
  const h1b = auth({ status: 'visa', needsSponsorship: true, visaType: 'h1b', expires: null, anyEmployer: false })
  const citizen = auth({ status: 'citizen', needsSponsorship: false })
  const ctx = { jobLocation: 'Austin, TX' }

  it.each([
    'Will you require sponsorship to work for any employer in the United States?',
    'Will you now or in the future require visa sponsorship to work for any employer in the US?',
    'Do you need sponsorship to work for any employer?'
  ])('answers Yes for an H-1B holder: %s', (label) => {
    expect(run(field(label), h1b, ctx)).toMatchObject({ value: 'Yes', needsUser: false })
  })

  it('answers No for a citizen asked whether they need sponsorship for any employer', () => {
    expect(run(field('Do you need sponsorship to work for any employer?'), citizen, ctx)).toMatchObject({ value: 'No', needsUser: false })
    expect(run(field('Will you require sponsorship to work for any employer in the United States?'), citizen, ctx)).toMatchObject({ value: 'No' })
  })
})

describe('F2: background, drug and credit check questions', () => {
  const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Sam R' }
  const flagged = (f: FormField) => {
    const got = run(f, profile, { jobLocation: 'Austin, TX' })
    expect(got).toMatchObject({ needsUser: true })
  }

  it('flags a text area about a background check', () => {
    flagged(field('Is there anything in your background check we should know about?', 'textarea'))
  })
  it('flags a non-Yes/No list about a background check, a drug test or a credit check', () => {
    flagged(field('Background check', 'select', ['I agree', 'I do not agree']))
    flagged(field('Drug test', 'radio', ['Willing', 'Not willing']))
    flagged(field('Credit check', 'select', ['Consent', 'Decline']))
  })

  it('never sends such a question to the model', async () => {
    const llm = { json: vi.fn(async () => ({ costUsd: 0, value: { answers: [] } })), text: vi.fn(async () => ({ value: 'Nothing to report.', costUsd: 0 })) }
    const deps = { llm, settings: DEFAULT_SETTINGS, profile, samples: [], findSavedAnswer: () => null, markAnswerUsed: vi.fn(), resumePath: 'r.pdf' } as unknown as AnswerDeps
    const job = { id: 'j', company: 'Studio', title: 'Gameplay Programmer', location: 'Austin, TX', description: 'Onsite.', fit: null, source: 'greenhouse' } as JobForAnswers
    const fields = [field('Background check', 'select', ['I agree', 'I do not agree']), field('Is there anything in your background check we should know about?', 'textarea')]
    fields[0].key = 'a'
    fields[1].key = 'b'
    const out = await answerFields(deps, job, fields, null, {})
    expect(llm.json).not.toHaveBeenCalled()
    expect(llm.text).not.toHaveBeenCalled()
    expect(out.answers.every((a) => a.needsUser)).toBe(true)
  })
})

describe('F3, F4: commuting', () => {
  const facts = (patch: Partial<ApplicationFacts>): Profile => ({
    ...EMPTY_PROFILE,
    fullName: 'Sam Rivera',
    location: 'Seattle, WA',
    workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
    application: { ...structuredClone(EMPTY_APPLICATION_FACTS), ...patch }
  })
  const arrangement = (cities: string[]) => ({ remote: true, hybrid: true, onsite: true, maxOfficeDaysPerWeek: 5, commutableCities: cities })
  const seattle = facts({ workArrangement: arrangement(['Seattle, WA']), relocation: { willing: false, places: [] } })

  it('flags a place that is not on the commute list', () => {
    expect(run(field('Can you commute to Bellevue, WA?'), seattle)).toMatchObject({ needsUser: true })
    expect(run(field('Are you able to commute to the office?'), seattle)).toMatchObject({ needsUser: true })
  })

  it('still says Yes for a listed place and for a relocation place', () => {
    expect(run(field('Can you commute to Seattle, WA?'), seattle)).toMatchObject({ value: 'Yes' })
    const move = facts({ workArrangement: arrangement([]), relocation: { willing: true, places: ['Redmond'] } })
    expect(run(field('Are you able to commute to our office in Redmond, WA?'), move)).toMatchObject({ value: 'Yes' })
  })

  it('answers "relocate or commute" from the commute list when relocation is No', () => {
    const p = facts({ workArrangement: arrangement(['Redmond, WA']), relocation: { willing: false, places: [] } })
    expect(run(field('Are you willing to relocate or commute to Redmond, WA?'), p)).toMatchObject({ value: 'Yes', needsUser: false })
  })

  it('flags "relocate or commute" when neither fact covers the place', () => {
    expect(run(field('Are you willing to relocate or commute to Redmond, WA?'), seattle)).toMatchObject({ needsUser: true })
  })

  it('still answers a plain relocation question from the relocation fact', () => {
    expect(run(field('Are you willing to relocate?'), seattle)).toMatchObject({ value: 'No', needsUser: false })
  })
})

describe('F6: self-ID questions with an intro about games or representation', () => {
  const eth = ['White', 'Mixed or Multiple ethnic groups', 'Asian or Asian British', 'Prefer not to say']

  it('reads the question and not the intro', () => {
    expect(demographicFamily(field('We want to build a more diverse games industry. Which of the following best describes your ethnic group?', 'select', eth))).toBe('race')
    expect(demographicFamily(field('Do you have lived experience of disability?', 'select', ['Yes', 'No', 'Prefer not to say']))).toBe('disability')
    expect(demographicFamily(field('To help us improve representation, how would you describe your gender?', 'select', ['Man', 'Woman', 'Prefer not to say']))).toBe('gender')
    expect(demographicFamily(field('What is your sexual orientation? We ask so we can track representation across our studio.', 'select', ['Gay or lesbian', 'Prefer not to say']))).toBe('sexual_orientation')
  })

  it('answers such a question from the settings', () => {
    const got = run(field('We want to build a more diverse games industry. Which of the following best describes your ethnic group?', 'select', eth), { ...EMPTY_PROFILE, fullName: 'Sam R' }, { jobLocation: 'London, UK' })
    expect(got).toMatchObject({ source: 'settings', needsUser: false })
  })

  it.each([
    'Describe a race condition you fixed in a game.',
    'Do you have experience with players with disabilities?',
    'How many years of industry experience do you have?',
    'Which ESRB rating did your last game have?',
    'We build accessible games. Describe the accessibility features you shipped.'
  ])('still leaves out %s', (label) => {
    expect(demographicFamily(field(label, 'text', []))).toBeNull()
  })
})

describe('F9, F15: transgender and cisgender wording', () => {
  const S = (eeo: Partial<Settings['eeo']>): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), eeo: { ...structuredClone(DEFAULT_SETTINGS.eeo), ...eeo } })
  const ask = (f: FormField, s: Settings) => demographicAnswer(f, s, null, 2026)

  it('does not invert a question that names transgender', () => {
    const f = field('Do you identify as transgender or cisgender?', 'select', ['Transgender', 'Cisgender', 'Prefer not to say'])
    expect(ask(f, S({ transgender: 'no', gender: 'man' }))).toMatchObject({ value: 'Cisgender' })
    expect(ask(f, S({ transgender: 'yes', gender: 'woman' }))).toMatchObject({ value: 'Transgender' })
  })

  it('still inverts the "same as the sex assigned at birth" wording', () => {
    const f = field('Is your gender identity the same as the sex you were assigned at birth?', 'select', ['Yes', 'No', 'Prefer not to say'])
    expect(ask(f, S({ transgender: 'no' }))).toMatchObject({ value: 'Yes' })
    expect(ask(f, S({ transgender: 'yes' }))).toMatchObject({ value: 'No' })
  })

  it('does not invert a transgender question that explains itself with "does not match"', () => {
    const f = field('Do you identify as transgender, meaning your gender identity does not match the sex you were assigned at birth?', 'select', ['Yes', 'No', 'Prefer not to answer'])
    expect(ask(f, S({ transgender: 'no' }))).toMatchObject({ value: 'No' })
    expect(ask(f, S({ transgender: 'yes' }))).toMatchObject({ value: 'Yes' })
  })

  it('does not pick a cisgender option when transgender is set to decline', () => {
    const options = ['Cisgender man', 'Cisgender woman', 'Transgender man', 'Transgender woman', 'Non-binary', 'Prefer not to say']
    const got = ask(field('Gender', 'select', options), S({ gender: 'man', transgender: 'decline' }))
    expect(got?.value).toBe('Prefer not to say')
  })

  it('picks the plain option when transgender is decline and one exists', () => {
    const got = ask(field('Gender', 'select', ['Cisgender man', 'Man', 'Woman', 'Prefer not to say']), S({ gender: 'man', transgender: 'decline' }))
    expect(got?.value).toBe('Man')
  })

  it('still picks the cisgender option when the owner said they are not transgender', () => {
    const got = ask(field('Gender', 'select', ['Cisgender man', 'Cisgender woman', 'Transgender man', 'Prefer not to say']), S({ gender: 'man', transgender: 'no' }))
    expect(got?.value).toBe('Cisgender man')
  })
})

describe('F10: "this requirement" refers back to the sentences before it', () => {
  const profile: Profile = {
    ...EMPTY_PROFILE,
    fullName: 'Sam Rivera',
    location: 'Seattle, WA',
    workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
    application: {
      ...structuredClone(EMPTY_APPLICATION_FACTS),
      workArrangement: { remote: true, hybrid: true, onsite: true, maxOfficeDaysPerWeek: 5, commutableCities: [] },
      schedule: { evenings: true, weekends: true, nights: false, onCall: true, overtime: true, timeZones: ['Pacific'] }
    }
  }

  it('flags a question whose requirement has two parts', () => {
    const label = 'This role requires a valid U.S. passport and working weekends during launches. Are you able to meet this requirement?'
    expect(run(field(label), profile)).toMatchObject({ needsUser: true })
  })

  it('flags a requirement the facts do not cover', () => {
    expect(run(field('This role requires a valid U.S. passport. Are you able to meet this requirement?'), profile)).toMatchObject({ needsUser: true })
  })

  it('still answers one requirement the facts cover', () => {
    expect(run(field('This role requires working weekends during launches. Are you able to meet this requirement?'), profile)).toMatchObject({ value: 'Yes' })
  })
})

describe('F11: a salary list when the posted maximum applies', () => {
  const profile: Profile = {
    ...EMPTY_PROFILE,
    fullName: 'Sam Rivera',
    application: { ...structuredClone(EMPTY_APPLICATION_FACTS), salary: [{ currency: 'USD', min: 110000, target: 130000, period: 'year', answerStyle: 'range' }] }
  }
  const ctx = { profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse', jobLocation: 'Austin, TX', company: 'Acme', jobCurrency: 'USD', jobSalaryMin: 90000, jobSalaryMax: 120000 } as unknown as MapContext
  const options = ['$80,000 - $100,000', '$100,000 - $120,000', '$120,000 - $140,000', '$140,000+']

  it('picks the option that tops out at the posted maximum', () => {
    expect(mapApplicationField(field('Expected annual salary', 'select', options), ctx)).toMatchObject({ value: '$100,000 - $120,000' })
  })

  it('still picks the option that holds the target when the cap does not apply', () => {
    const open = { ...ctx, jobSalaryMax: 200000 } as MapContext
    expect(mapApplicationField(field('Expected annual salary', 'select', options), open)).toMatchObject({ value: '$120,000 - $140,000' })
  })
})

describe('F12: unpaid overtime', () => {
  const profile: Profile = {
    ...EMPTY_PROFILE,
    fullName: 'Sam Rivera',
    application: { ...structuredClone(EMPTY_APPLICATION_FACTS), schedule: { evenings: true, weekends: true, nights: true, onCall: true, overtime: true, timeZones: [] } }
  }
  it.each([
    'Are you open to working overtime during crunch periods without additional pay?',
    'Are you willing to work unpaid overtime during crunch?',
    'Are you willing to work extra hours without extra pay?',
    'Are you open to uncompensated overtime?'
  ])('flags %s', (label) => {
    expect(run(field(label), profile)).toMatchObject({ needsUser: true })
  })
  it('still answers a plain overtime question', () => {
    expect(run(field('Are you willing to work overtime when needed?'), profile)).toMatchObject({ value: 'Yes' })
  })
})
