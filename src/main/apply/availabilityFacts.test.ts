import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, FormField, Profile } from '@shared/types'
import { answerFields, type AnswerDeps, type JobForAnswers } from './answers'
import { mapAvailabilityField, placeMatches } from './availabilityFacts'
import { mapKnownField, type MapContext } from './fieldMap'
import { renderApplicationFacts } from './factsSummary'
import { willingnessFamily } from './questionFamilies'

const FILLED: ApplicationFacts = {
  ...EMPTY_PROFILE.application,
  authorization: [{ country: 'United States', status: 'citizen', needsSponsorship: false, notes: '' }],
  relocation: { willing: true, places: [] },
  travel: 'some',
  clearance: 'None',
  driversLicense: true,
  over18: true,
  workArrangement: { remote: true, hybrid: true, onsite: true, maxOfficeDaysPerWeek: null, commutableCities: [] },
  employment: {
    types: ['full_time', 'contract'],
    hoursPerWeek: 40,
    currentlyEmployed: true,
    desiredTitle: 'Gameplay Programmer',
    currentPay: { stance: 'amount', amount: 120000, currency: 'USD', period: 'year' }
  },
  schedule: { evenings: true, weekends: true, nights: false, onCall: false, overtime: true, timeZones: ['America/Los_Angeles', 'ET'] },
  screening: { backgroundCheck: true, drugTest: true, creditCheck: false }
}

const profileWith = (patch: Partial<ApplicationFacts> = {}): Profile => ({
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  location: 'Austin, TX',
  application: { ...FILLED, ...patch }
})

const ctxFor = (profile: Profile, patch: Partial<MapContext> = {}): MapContext => ({
  profile,
  settings: DEFAULT_SETTINGS,
  jobSource: 'greenhouse',
  jobLocation: 'Irvine, CA',
  company: 'Studio',
  ...patch
})

const yesNoField = (label: string, patch: Partial<FormField> = {}): FormField =>
  ({ key: 'q', label, type: 'select', required: true, options: ['Yes', 'No'], placeholder: null, maxLength: null, fileHint: null, ...patch }) as FormField
const textField = (label: string, type: 'text' | 'number' = 'text'): FormField =>
  ({ key: 'q', label, type, required: true, options: [], placeholder: null, maxLength: null, fileHint: null }) as FormField

const run = (label: string, patch: Partial<ApplicationFacts> = {}, ctxPatch: Partial<MapContext> = {}) =>
  mapAvailabilityField(yesNoField(label), ctxFor(profileWith(patch), ctxPatch))

const PROBE_LABELS = [
  'Are you able to commute to our office in Irvine, CA?',
  'Are you located within commuting distance of our Seattle office?',
  'This role requires working onsite 3 days per week. Are you able to meet this requirement?',
  'Are you willing to work in-office 5 days a week?',
  'Are you open to a hybrid schedule?',
  'Are you available to work evenings and weekends?',
  'Are you able to work overtime during crunch periods?',
  'Are you available to work full-time (40 hours per week)?',
  'Are you open to a 6-month contract?',
  'Are you willing to submit to a pre-employment drug screen?',
  'Are you willing to relocate to Irvine, CA?',
  'Are you willing to undergo a background check?'
]
// These two belong to the authorization package. They must still wait for the owner.
const AUTHORIZATION_LABELS = [
  'Are you a U.S. person as defined by ITAR?',
  'Will you now or in the future require the company to commence an immigration case in order to employ you?'
]

function setup(application: ApplicationFacts) {
  const calls: string[] = []
  const llm = {
    json: vi.fn(async (req: { prompt: string }) => {
      calls.push(req.prompt)
      const fields = JSON.parse(req.prompt.split('FIELDS\n')[1]) as Array<{ key: string }>
      return { costUsd: 0, value: { answers: fields.map((f) => ({ key: f.key, value: 'Yes', confidence: 0.9, needsUser: false, note: '' })) } }
    })
  }
  const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Sam Rivera', email: 'sam@example.com', location: 'Austin, TX', application }
  const deps = { llm, settings: DEFAULT_SETTINGS, profile, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: 'resume.pdf' } as unknown as AnswerDeps
  const job = { id: 'j', company: 'Studio', title: 'Gameplay Programmer', location: 'Irvine, CA', description: 'Onsite.', fit: null, source: 'greenhouse' } as JobForAnswers
  const fields = [...PROBE_LABELS, ...AUTHORIZATION_LABELS].map((label, i) => yesNoField(label, { key: `q${i}` }))
  return { calls, run: () => answerFields(deps, job, fields, null) }
}

describe('the knockout probe labels', () => {
  it('are answered from the facts with no form_map call', async () => {
    const env = setup(FILLED)
    const { answers } = await env.run()
    expect(env.calls).toHaveLength(0)
    const byLabel = new Map(answers.map((a) => [a.label, a]))
    for (const label of PROBE_LABELS) {
      const a = byLabel.get(label)
      expect(a, label).toMatchObject({ value: 'Yes', source: 'profile', needsUser: false })
    }
    for (const label of AUTHORIZATION_LABELS) expect(byLabel.get(label), label).toMatchObject({ value: '', needsUser: true })
  })

  it('flag when the facts are not answered', async () => {
    const env = setup(EMPTY_PROFILE.application)
    const { answers } = await env.run()
    expect(env.calls).toHaveLength(0)
    const flagged = answers.filter((a) => a.needsUser).map((a) => a.label)
    // Relocation is a separate fact and also reads null here.
    expect(flagged).toEqual([...PROBE_LABELS, ...AUTHORIZATION_LABELS])
  })
})

describe('on site, hybrid and remote', () => {
  it('answers a day count against the most office days', () => {
    expect(run('Are you willing to work in-office 4 days a week?', { workArrangement: { ...FILLED.workArrangement, maxOfficeDaysPerWeek: 3 } })?.value).toBe('No')
    expect(run('Are you willing to work in-office 3 days a week?', { workArrangement: { ...FILLED.workArrangement, maxOfficeDaysPerWeek: 3 } })?.value).toBe('Yes')
    expect(run('Are you willing to work hybrid, 2-4 days a week in the office?', { workArrangement: { ...FILLED.workArrangement, maxOfficeDaysPerWeek: 3 } })?.value).toBe('No')
  })

  it('treats 0 days as a real answer', () => {
    const wa = { ...FILLED.workArrangement, onsite: null, maxOfficeDaysPerWeek: 0 }
    expect(run('Are you willing to work onsite?', { workArrangement: wa })?.value).toBe('No')
  })

  it('answers No when the fact says No', () => {
    expect(run('Are you willing to work onsite?', { workArrangement: { ...FILLED.workArrangement, onsite: false } })?.value).toBe('No')
    expect(run('Are you open to working remotely?', { workArrangement: { ...FILLED.workArrangement, remote: false } })?.value).toBe('No')
  })

  it('flags when the fact is null', () => {
    const wa = { remote: null, hybrid: null, onsite: null, maxOfficeDaysPerWeek: null, commutableCities: [] }
    for (const label of ['Are you willing to work onsite?', 'Are you open to a hybrid schedule?', 'Are you open to working remotely?']) {
      expect(run(label, { workArrangement: wa }), label).toMatchObject({ needsUser: true, source: 'profile' })
    }
  })

  it('leaves an on-site interview and a remote-from-a-place condition alone', () => {
    expect(run('Are you able to attend an onsite interview?')).toBeNull()
    expect(run('Are you willing to work remotely from Canada?')).toMatchObject({ needsUser: true })
  })

  it('picks the way the job works for a work arrangement choice', () => {
    const choice = yesNoField('Preferred work arrangement', { type: 'select', options: ['Remote', 'Hybrid', 'On-site'] })
    expect(mapAvailabilityField(choice, ctxFor(profileWith(), { jobRemote: 'hybrid' }))?.value).toBe('Hybrid')
    expect(mapAvailabilityField(choice, ctxFor(profileWith(), { jobRemote: null }))).toMatchObject({ needsUser: true })
    const onlyRemote = profileWith({ workArrangement: { ...FILLED.workArrangement, hybrid: false, onsite: false } })
    expect(mapAvailabilityField(choice, ctxFor(onlyRemote, { jobRemote: null }))?.value).toBe('Remote')
  })
})

describe('commuting', () => {
  const none = { ...FILLED.workArrangement, commutableCities: [] as string[] }

  it('is Yes for a city on the commute list', () => {
    const p = { workArrangement: { ...none, commutableCities: ['Seattle, WA'] }, relocation: { willing: false, places: [] } }
    expect(run('Are you located within commuting distance of our Seattle office?', p)?.value).toBe('Yes')
  })

  it('is Yes when relocation is on and the place passes the list', () => {
    const p = { workArrangement: none, relocation: { willing: true, places: ['Irvine'] } }
    const got = run('Are you able to commute to our office in Irvine, CA?', p)
    expect(got).toMatchObject({ value: 'Yes', source: 'profile', needsUser: false })
    expect(got?.note).toMatch(/relocate/)
  })

  it('treats an empty places list as anywhere', () => {
    expect(run('Can you commute to Seattle?', { workArrangement: none, relocation: { willing: true, places: [] } })?.value).toBe('Yes')
  })

  it('flags a place that is not on the commute list, since the list holds examples', () => {
    const cities = { ...none, commutableCities: ['Austin'] }
    expect(run('Can you commute to Seattle?', { workArrangement: cities, relocation: { willing: false, places: [] } })).toMatchObject({ needsUser: true })
    expect(run('Can you commute to Seattle?', { workArrangement: cities, relocation: { willing: true, places: ['Denver'] } })).toMatchObject({ needsUser: true })
  })

  it('flags when the facts are silent', () => {
    const cities = { ...none, commutableCities: ['Austin'] }
    expect(run('Can you commute to Seattle?', { workArrangement: none, relocation: { willing: false, places: [] } })).toMatchObject({ needsUser: true })
    expect(run('Can you commute to Seattle?', { workArrangement: cities, relocation: { willing: null, places: [] } })).toMatchObject({ needsUser: true })
    expect(run('Can you commute to Seattle?', { workArrangement: none, relocation: { willing: null, places: [] } })).toMatchObject({ needsUser: true })
  })

  it('does not count a move for a question about where the person lives now', () => {
    const p = { workArrangement: { ...none, commutableCities: ['Austin'] }, relocation: { willing: true, places: [] } }
    expect(run('Are you currently located within commuting distance of our Seattle office?', p)?.value).toBe('No')
  })

  it('uses the job location when the question names no place, and flags a remote job', () => {
    const p = { workArrangement: { ...none, commutableCities: ['Irvine'] }, relocation: { willing: false, places: [] } }
    expect(run('Are you able to commute to the office?', p, { jobLocation: 'Irvine, CA' })?.value).toBe('Yes')
    expect(run('Are you able to commute to the office?', p, { jobLocation: 'Remote' })).toMatchObject({ needsUser: true })
    expect(run('Are you able to commute to the office?', p, { jobLocation: 'Irvine, CA', jobRemote: 'remote' })).toMatchObject({ needsUser: true })
  })

  it('matches places by city, state and country', () => {
    expect(placeMatches('Irvine, CA', 'Irvine')).toBe(true)
    expect(placeMatches('Irvine, CA', 'Irvine, California')).toBe(true)
    expect(placeMatches('Irvine, CA', 'California')).toBe(true)
    expect(placeMatches('Irvine, CA', 'United States')).toBe(true)
    expect(placeMatches('Irvine, CA', 'Seattle')).toBe(false)
    expect(placeMatches('York', 'New York')).toBe(false)
  })
})

describe('employment type and hours', () => {
  it('answers a type from the list and No for one that is not on it', () => {
    expect(run('Are you open to a 6-month contract?')?.value).toBe('Yes')
    expect(run('Are you open to a part-time role?')?.value).toBe('No')
    expect(run('Are you looking for full-time or part-time work?')?.value).toBe('Yes')
  })

  it('flags an empty type list', () => {
    expect(run('Are you open to a 6-month contract?', { employment: { ...FILLED.employment, types: [] } })).toMatchObject({ needsUser: true })
  })

  it('does not confuse contract with contract to hire', () => {
    const onlyContract = { employment: { ...FILLED.employment, types: ['contract' as const] } }
    expect(run('Are you open to a contract-to-hire position?', onlyContract)).toMatchObject({ needsUser: true })
    expect(run('Are you open to a contract-to-hire position?', { employment: { ...FILLED.employment, types: ['contract_to_hire' as const] } })?.value).toBe('Yes')
  })

  it('compares hours per week', () => {
    expect(run('Are you available to work 30 hours per week?')?.value).toBe('Yes')
    expect(run('Are you available to work 50 hours per week?')?.value).toBe('No')
    expect(run('Are you available to work 20 hours per week?', { employment: { ...FILLED.employment, hoursPerWeek: null } })).toMatchObject({ needsUser: true })
  })

  it('flags a limit on hours and hours without a period', () => {
    expect(run('Are you able to work no more than 20 hours per week?')).toMatchObject({ needsUser: true })
    expect(run('Are you available to work 8 hours?')).toMatchObject({ needsUser: true })
  })

  it('fills an hours-per-week number', () => {
    expect(mapAvailabilityField(textField('Hours per week available', 'number'), ctxFor(profileWith()))?.value).toBe('40')
    expect(mapAvailabilityField(textField('Hours per week available', 'number'), ctxFor(profileWith({ employment: { ...FILLED.employment, hoursPerWeek: null } })))).toMatchObject({ needsUser: true })
  })

  it('does not answer a permanent role from full-time', () => {
    expect(run('Are you looking for a permanent role?')).toMatchObject({ needsUser: true })
    expect(run('Are you looking for a permanent full-time role?')?.value).toBe('Yes')
  })
})

describe('evenings, weekends, nights, on call and overtime', () => {
  it('needs every part to hold', () => {
    expect(run('Are you available to work evenings and weekends?')?.value).toBe('Yes')
    expect(run('Are you available to work evenings and nights?')?.value).toBe('No')
  })

  it('takes either part when the question says or', () => {
    expect(run('Are you available to work nights or weekends?')?.value).toBe('Yes')
    expect(run('Are you available to work nights or on call?')?.value).toBe('No')
  })

  it('treats false as an answer and null as a flag', () => {
    expect(run('Are you willing to be on call?')?.value).toBe('No')
    expect(run('Are you willing to be on call?', { schedule: { ...FILLED.schedule, onCall: null } })).toMatchObject({ needsUser: true })
  })

  it('flags schedules the facts do not cover', () => {
    expect(run('Are you available to work weekends and holidays?')).toMatchObject({ needsUser: true })
    expect(run('Are you comfortable with a rotating schedule that includes weekends?')).toMatchObject({ needsUser: true })
  })
})

describe('time zones', () => {
  it('is Yes when every named zone is on the list', () => {
    expect(run('Are you able to work during Pacific time hours?')?.value).toBe('Yes')
    expect(run('Can you overlap with at least 4 hours of ET working hours?')?.value).toBe('Yes')
  })

  it('flags a zone that is not on the list and an empty list', () => {
    expect(run('Are you able to work in the CET time zone?')).toMatchObject({ needsUser: true })
    expect(run('Are you able to work during Pacific time hours?', { schedule: { ...FILLED.schedule, timeZones: [] } })).toMatchObject({ needsUser: true })
  })

  it('does not read a state code as a zone', () => {
    expect(run('Are you available to work in Helena, MT?')).toBeNull()
  })
})

describe('background, drug and credit checks', () => {
  it('answers willingness wording from the fact', () => {
    expect(run('Are you willing to undergo a background check?')?.value).toBe('Yes')
    expect(run('Would you be willing to submit to a credit check?')?.value).toBe('No')
    expect(run('Are you willing to take a drug test?', { screening: { ...FILLED.screening, drugTest: null } })).toMatchObject({ needsUser: true })
  })

  it('leaves history, passing and polarity wording to the owner', () => {
    for (const label of [
      'Have you ever failed a drug test?',
      'Is there any reason you could not pass a background check?',
      'Are you able to pass a drug test?',
      'Would you object to a background check?',
      'Do you have any concerns about undergoing a background check?',
      'Are you unwilling to undergo a credit check?'
    ]) {
      expect(run(label), label).toMatchObject({ value: '', needsUser: true })
    }
  })

  it('leaves consent and authorization wording to the owner', () => {
    for (const label of [
      'Do you authorize us to run a background check?',
      'Do you consent to a background check?',
      'Do you agree to a drug test?',
      'Do you allow us to run a credit check?'
    ]) {
      expect(run(label), label).toMatchObject({ value: '', needsUser: true })
    }
  })

  it('needs every named check to be a Yes', () => {
    expect(run('Are you willing to undergo a background check and a drug test?')?.value).toBe('Yes')
    expect(run('Are you willing to undergo a background check and a credit check?')?.value).toBe('No')
    expect(run('Are you willing to undergo a background check or a drug test?')).toMatchObject({ needsUser: true })
  })
})

describe('polarity variants of the other families', () => {
  it('flag instead of answering', () => {
    for (const label of [
      'Are you unable to work weekends?',
      'Do you mind working evenings?',
      'Would you have any problem working onsite?',
      'Are you unwilling to work overtime?',
      'Are you not able to commute to our office in Irvine, CA?'
    ]) {
      expect(run(label), label).toMatchObject({ value: '', needsUser: true })
    }
  })

  it('does not take a question about two things at once', () => {
    expect(run('Are you willing to work onsite and undergo a background check?')).toMatchObject({ needsUser: true })
    expect(run('Are you able to commute to our office in Irvine, CA and work evenings?')).toMatchObject({ needsUser: true })
  })

  it('leaves questions that are not willingness questions alone', () => {
    for (const label of ['Describe your experience working onsite.', 'Do you have a reliable car to commute?', 'Is this role remote?', 'What is your favorite game?']) {
      expect(mapAvailabilityField(textField(label), ctxFor(profileWith())), label).toBeNull()
    }
    const area = { ...yesNoField('Are you willing to work onsite?'), type: 'textarea' as const, options: [] }
    expect(mapAvailabilityField(area, ctxFor(profileWith()))).toBeNull()
  })
})

describe('current job, desired title and current pay', () => {
  it('answers whether the person is currently employed', () => {
    expect(run('Are you currently employed?')?.value).toBe('Yes')
    expect(run('Are you currently employed?', { employment: { ...FILLED.employment, currentlyEmployed: false } })?.value).toBe('No')
    expect(run('Are you currently employed?', { employment: { ...FILLED.employment, currentlyEmployed: null } })).toMatchObject({ needsUser: true })
  })

  it('does not read an employer question as the person\'s own job', () => {
    expect(run('Are you currently employed by Stripe?')).toBeNull()
    expect(run('Are you currently employed full-time as a student?')).toBeNull()
  })

  it('fills the desired title and flags an empty one', () => {
    expect(mapAvailabilityField(textField('Desired position'), ctxFor(profileWith()))?.value).toBe('Gameplay Programmer')
    expect(mapAvailabilityField(textField('Desired job title'), ctxFor(profileWith({ employment: { ...FILLED.employment, desiredTitle: '' } })))).toMatchObject({ needsUser: true })
  })

  it('answers current pay by the stance', () => {
    const ask = (label: string, patch: Partial<ApplicationFacts> = {}, type: 'text' | 'number' = 'text', ctx: Partial<MapContext> = {}) =>
      mapAvailabilityField(textField(label, type), ctxFor(profileWith(patch), ctx))
    expect(ask('Current salary')?.value).toBe('120,000 USD')
    expect(ask('Current salary', {}, 'number')?.value).toBe('120000')
    expect(ask('Current salary (monthly)', {}, 'number')?.value).toBe('10000')
    const decline = { employment: { ...FILLED.employment, currentPay: { ...FILLED.employment.currentPay, stance: 'decline' as const } } }
    expect(ask('Current salary', decline)?.value).toBe('Prefer not to say')
    expect(ask('Current salary', decline, 'number')).toMatchObject({ needsUser: true })
    const unset = { employment: { ...FILLED.employment, currentPay: { stance: '' as const, amount: null, currency: '', period: 'year' as const } } }
    expect(ask('Current salary', unset)).toMatchObject({ needsUser: true })
  })

  it('flags a current pay in another currency than the form', () => {
    const ask = (label: string, ctx: Partial<MapContext> = {}) => mapAvailabilityField(textField(label, 'number'), ctxFor(profileWith(), ctx))
    expect(ask('Current salary (SEK)')).toMatchObject({ needsUser: true })
    expect(ask('Current salary', { jobCurrency: 'SEK' })).toMatchObject({ needsUser: true })
    expect(ask('Current salary', { jobCurrency: 'USD' })?.value).toBe('120000')
  })

  it('leaves an expected salary question to the salary rules', () => {
    expect(mapAvailabilityField(textField('Current salary expectations'), ctxFor(profileWith()))).toBeNull()
  })
})

describe('through the field map', () => {
  it('answers after the free-form facts and before the "never guess" flags', () => {
    const ctx = ctxFor(profileWith())
    expect(mapKnownField(yesNoField('Are you willing to undergo a background check?'), ctx)).toMatchObject({ value: 'Yes', source: 'profile' })
    const withFact: Profile = { ...ctx.profile, facts: [{ question: 'Are you willing to undergo a background check?', answer: 'Yes' }] }
    expect(mapKnownField(yesNoField('Are you willing to undergo a background check?'), { ...ctx, profile: withFact })?.value).toBe('Yes')
  })

  it('flags a background check question with no facts and no polarity match', () => {
    const empty = ctxFor({ ...EMPTY_PROFILE, fullName: 'Sam Rivera' })
    expect(mapKnownField(yesNoField('Are you willing to undergo a background check?'), empty)).toMatchObject({ needsUser: true })
  })

  it('reads names from profile.name with a fallback to the full name', () => {
    const named: Profile = { ...EMPTY_PROFILE, fullName: 'Sam Rivera', name: { first: 'Samuel', middle: 'Lee', last: 'Rivera-Cho', preferred: 'Sam', pronunciation: 'SAM riv-AIR-uh' } }
    const ask = (label: string, profile: Profile) => mapKnownField(textField(label), ctxFor(profile))?.value
    expect(ask('First name', named)).toBe('Samuel')
    expect(ask('Last name', named)).toBe('Rivera-Cho')
    expect(ask('Preferred name', named)).toBe('Sam')
    expect(ask('Middle name', named)).toBe('Lee')
    expect(ask('Middle initial', named)).toBe('L')
    expect(ask('Name pronunciation', named)).toBe('SAM riv-AIR-uh')
    const split: Profile = { ...EMPTY_PROFILE, fullName: 'Sam Rivera' }
    expect(ask('First name', split)).toBe('Sam')
    expect(ask('Last name', split)).toBe('Rivera')
    expect(ask('Preferred name', split)).toBe('Sam')
  })
})

describe('the model context and the willingness families', () => {
  it('lists the work and availability facts', () => {
    const text = renderApplicationFacts(FILLED, DEFAULT_SETTINGS.preferences)
    expect(text).toContain('Would work on site: yes')
    expect(text).toContain('Hours a week they can work: 40')
    expect(text).toContain('Would work nights: no')
    expect(text).toContain('Willing to take a drug test: yes')
    const empty = renderApplicationFacts(EMPTY_PROFILE.application, DEFAULT_SETTINGS.preferences)
    expect(empty).toContain('Would work on site: not stated')
    expect(empty).toContain('Cities they can commute to: not stated')
    expect(empty).toContain('Current pay: not stated')
  })

  it('reads a profile saved before these facts existed', () => {
    const { workArrangement: _w, employment: _e, schedule: _s, screening: _c, ...old } = FILLED
    const profile = { ...EMPTY_PROFILE, application: old as unknown as ApplicationFacts }
    expect(() => renderApplicationFacts(profile.application, DEFAULT_SETTINGS.preferences)).not.toThrow()
    expect(mapAvailabilityField(yesNoField('Are you willing to work onsite?'), ctxFor(profile))).toMatchObject({ needsUser: true })
  })

  it('knows the remote and time zone families', () => {
    expect(willingnessFamily('Are you willing to work remotely?')).toBe('remote')
    expect(willingnessFamily('Are you able to work during Pacific time hours?')).toBe('time_zone')
    expect(willingnessFamily('Are you available to work Saturdays?')).toBe('schedule')
    expect(willingnessFamily('Do you have experience working remotely?')).toBeNull()
    expect(willingnessFamily('What is your time zone?')).toBeNull()
  })

  it('keeps an unanswered remote question away from the model', async () => {
    const env = setup(EMPTY_PROFILE.application)
    void env
    const llm = { json: vi.fn(async () => ({ costUsd: 0, value: { answers: [] } })) }
    const deps = { llm, settings: DEFAULT_SETTINGS, profile: { ...EMPTY_PROFILE, fullName: 'Sam Rivera' }, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: null } as unknown as AnswerDeps
    const job = { id: 'j', company: 'Studio', title: 'Dev', location: null, description: '', fit: null, source: 'greenhouse' } as JobForAnswers
    const { answers } = await answerFields(deps, job, [yesNoField('Are you willing to work remotely?', { key: 'r' })], null)
    expect(llm.json).not.toHaveBeenCalled()
    expect(answers[0]).toMatchObject({ needsUser: true })
  })
})

describe('flags and optional questions', () => {
  const empty = ctxFor({ ...EMPTY_PROFILE, fullName: 'Sam Rivera' })

  it('uses the willingness note for a required question whose fact is missing', () => {
    expect(mapAvailabilityField(yesNoField('Are you open to a hybrid schedule?'), empty)?.note).toBe('This asks about a hybrid schedule. Your profile does not answer it, so answer it yourself.')
  })

  it('leaves an optional question blank without a flag', () => {
    expect(mapAvailabilityField(yesNoField('Are you open to a hybrid schedule?', { required: false }), empty)).toMatchObject({ value: '', needsUser: false })
    expect(mapAvailabilityField(yesNoField('Have you ever failed a drug test?', { required: false }), ctxFor(profileWith()))).toMatchObject({ value: '', needsUser: false })
  })

  it('keeps the specific note for a polarity flag', () => {
    expect(mapAvailabilityField(yesNoField('Have you ever failed a drug test?'), ctxFor(profileWith()))?.note).toMatch(/history question/)
  })

  it('does not read a question about a past contractor job as a kind of work', () => {
    const label = 'Have you ever worked for Figma before, as an employee or a contractor/consultant?'
    expect(mapAvailabilityField(yesNoField(label), ctxFor(profileWith()))).toBeNull()
  })
})

describe('share of the week in the office', () => {
  it('reads a percentage as days', () => {
    const limited = { workArrangement: { ...FILLED.workArrangement, maxOfficeDaysPerWeek: 1 } }
    expect(run('Are you open to working in-person in one of our offices 20% of the time?', limited)?.value).toBe('Yes')
    expect(run('Are you open to working in-person in one of our offices 60% of the time?', limited)?.value).toBe('No')
  })
})
