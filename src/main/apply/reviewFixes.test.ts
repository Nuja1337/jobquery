import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField, PreparedAnswer, Profile, Settings } from '@shared/types'
import { regionOf } from '../util/geo'
import { normalizeQuestion } from '../util/text'
import { answerFields, COVER_LETTER_PDF, companiesToCheck, HELD_UPLOAD_NOTE, otherCompanyNamed, type AnswerDeps, type SavedAnswer } from './answers'
import { demographicAnswer, demographicFamily } from './demographics'
import { mapKnownField, matchFact, mustAskUser } from './fieldMap'
import { chooseSuggestion } from './fill'
import { letterInUse, syncOptionalLetterUploads } from './readiness'

// Regression tests for the review of the first five build waves.

const NOW = new Date(2026, 10, 8)

const field = (label: string, type: FieldType = 'select', options: string[] = ['Yes', 'No'], patch: Partial<FormField> = {}): FormField => ({
  key: 'q1', label, type, required: true, options, placeholder: null, maxLength: null, fileHint: null, ...patch
})
const withFacts = (facts: Array<{ question: string; answer: string }>): Profile => ({
  ...EMPTY_PROFILE,
  fullName: 'Sam Lee',
  yearsExperience: 6,
  facts: facts.map((x, i) => ({ id: `f${i}`, ...x })) as Profile['facts'],
  application: { ...structuredClone(EMPTY_APPLICATION_FACTS), over18: true } as Profile['application']
})
const ctx = (profile: Profile, jobCountry: string | null = 'United States', jobLocation = 'Austin, TX') => ({
  profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse' as const, jobLocation, company: 'Acme', jobCountry, jobCurrency: null, now: NOW
})

describe('C1: facts answer only their own question', () => {
  const cases: Array<[string, string, string]> = [
    ['Are you willing to work onsite?', 'Yes', 'Are you willing to work weekends?'],
    ['Are you willing to work onsite?', 'Yes', 'Are you willing to work night shifts?'],
    ['Are you willing to work onsite?', 'Yes', 'Are you willing to work nights?'],
    ['Do you have a Bachelor degree?', 'Yes', 'Do you have a Master degree?'],
    ['Are you willing to travel?', 'Yes', 'Are you willing to relocate?'],
    ['Are you a US citizen?', 'No', 'Are you a Canadian citizen?'],
    ['Are you comfortable working hybrid?', 'Yes', 'Are you comfortable working overtime?']
  ]
  it.each(cases)('the fact "%s" does not answer a different question', (question, answer, label) => {
    const p = withFacts([{ question, answer }])
    expect(matchFact(p, label)).toBeNull()
    const known = mapKnownField(field(label), ctx(p))
    expect(known === null || known.needsUser || known.source !== 'profile' || known.value !== answer).toBe(true)
  })

  it('still answers the same question in other words with the same content words', () => {
    const p = withFacts([{ question: 'Are you willing to work onsite?', answer: 'Yes' }])
    expect(matchFact(p, 'Are you willing to work onsite?')).toBe('Yes')
    expect(matchFact(p, 'Would you be willing to work onsite')).toBe('Yes')
    expect(matchFact(withFacts([{ question: 'Notice period', answer: '2 weeks' }]), 'What is your notice period?')).toBe('2 weeks')
  })

  it('the short background check fact no longer answers the longer wording', () => {
    expect(matchFact(withFacts([{ question: 'Background check', answer: 'Yes' }]), 'Are you willing to undergo a background check?')).toBeNull()
  })

  it('the model is asked, not the facts, on the full answer path', async () => {
    const p: Profile = { ...withFacts([{ question: 'Do you have a Bachelor degree?', answer: 'Yes' }, { question: 'Are you willing to work onsite?', answer: 'Yes' }]) }
    const prompts: string[] = []
    const llm = { async json(req: { prompt: string }) { prompts.push(req.prompt); return { value: { answers: [] }, costUsd: 0 } }, async text() { return { value: '', costUsd: 0 } } }
    const deps: AnswerDeps = { llm: llm as never, settings: DEFAULT_SETTINGS, profile: p, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: null }
    const job = { id: 'j', company: 'Acme', title: 'Gameplay Engineer', location: 'Austin, TX', description: 'x', fit: null, source: 'greenhouse', country: 'United States' }
    const out = await answerFields(deps, job as never, [field('Do you have a Master degree?'), { ...field('Are you willing to work weekends?'), key: 'q2' }], null)
    for (const a of out.answers) expect(a.source === 'profile' && a.value === 'Yes' && !a.needsUser).toBe(false)
  })
})

describe('H1: a saved answer does not clear a flag that stands for an unknown country', () => {
  const profile: Profile = {
    ...EMPTY_PROFILE,
    fullName: 'Sam Lee',
    workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
    application: { ...structuredClone(EMPTY_APPLICATION_FACTS), over18: true } as Profile['application']
  }
  const sponsorQ = 'Do you require visa sponsorship?'
  const authQ = 'Are you legally authorized to work in the country where this job is located?'
  const startQ = 'When can you start?'
  const bank: Record<string, SavedAnswer> = {
    [normalizeQuestion(sponsorQ)]: { id: 's1', answer: 'No', kind: 'fact', topic: 'sponsorship' },
    [normalizeQuestion(authQ)]: { id: 's2', answer: 'Yes', kind: 'fact', topic: 'authorization' },
    [normalizeQuestion(startQ)]: { id: 's3', answer: 'March 3, 2026', kind: 'fact', topic: 'start_date' }
  }
  const run = async (fields: FormField[], location: string) => {
    const llm = { async json() { throw new Error('no model') }, async text() { throw new Error('no model') } }
    const deps: AnswerDeps = { llm: llm as never, settings: DEFAULT_SETTINGS, profile, samples: [], findSavedAnswer: (q) => bank[normalizeQuestion(q)] ?? null, markAnswerUsed: () => {}, resumePath: null }
    return answerFields(deps, { id: 'j', company: 'Acme', title: 'Engineer', location, description: 'x', fit: null, source: 'greenhouse', country: null } as never, fields, null)
  }

  it.each(['Remote - Europe', 'Remote'])('keeps both questions flagged on a "%s" job', async (location) => {
    const out = await run([field(sponsorQ), { ...field(authQ), key: 'q2' }], location)
    for (const a of out.answers) {
      expect(a.needsUser).toBe(true)
      expect(a.source).not.toBe('answer_bank')
    }
  })

  it('never clears a start date flag from a saved date', async () => {
    const out = await run([field(startQ, 'text', [])], 'Austin, TX')
    expect(out.answers[0].source).not.toBe('answer_bank')
  })
})

describe('H1 follow-up: a saved Yes or No fills a checkbox as true or false', () => {
  it('turns the saved answer into the checkbox form', async () => {
    const question = 'I am willing to relocate'
    const profile = withFacts([])
    const make = (answer: string) => {
      const llm = { async json() { throw new Error('no model') }, async text() { throw new Error('no model') } }
      const deps: AnswerDeps = { llm: llm as never, settings: DEFAULT_SETTINGS, profile, samples: [], findSavedAnswer: () => ({ id: 's', answer, kind: 'fact', topic: null }), markAnswerUsed: () => {}, resumePath: null }
      return answerFields(deps, { id: 'j', company: 'Acme', title: 'Engineer', location: 'Austin, TX', description: 'x', fit: null, source: 'greenhouse', country: 'United States' } as never, [field(question, 'checkbox', [], { required: false })], null)
    }
    const yes = (await make('Yes')).answers[0]
    expect(yes).toMatchObject({ value: 'true', source: 'answer_bank', needsUser: false })
    const no = (await make('No')).answers[0]
    expect(no).toMatchObject({ value: 'false', source: 'answer_bank', needsUser: false })
  })
})

describe('H2 and H3: accommodation questions', () => {
  it.each([
    'Do you require any accommodations due to a disability?',
    'Do you need an accommodation for your disability during the interview?',
    'Will you require any assistance or accommodation?',
    'Please tell us about any impairment that needs an accommodation.',
    'Do you need accommodation during the recruitment process?'
  ])('"%s" goes to the person', (label) => {
    expect(mustAskUser({ label, type: 'select' })).toMatch(/accommodations/)
  })

  it.each([
    'Can you perform the essential functions of the job with or without reasonable accommodation?',
    'Are you able to perform the essential functions of this position, with or without reasonable accommodation?',
    'Are you able to lift 25 pounds with or without reasonable accommodation?',
    'Can you do the work with or without accommodations?'
  ])('"%s" is an ability question and is not held back', (label) => {
    expect(mustAskUser({ label, type: 'select' })).toBeNull()
  })

  it('a plain request for a reasonable accommodation still goes to the person', () => {
    expect(mustAskUser({ label: 'Do you need a reasonable accommodation to apply?', type: 'select' })).not.toBeNull()
  })
})

describe('M1: other company names', () => {
  const profile = {
    ...EMPTY_PROFILE,
    skills: ['C++', 'Unity', 'Unreal Engine', 'Amazon Web Services', 'Google Cloud Platform', 'Meta Quest'],
    experience: [{ company: 'Ledgerly', title: 'Engineer' }],
    projects: [],
    education: []
  } as unknown as Profile
  const companies = ['Amazon', 'Google', 'Unity Technologies', 'Epic Games', 'Apple', 'Meta', 'Riot Games', 'Valve', 'Discord', 'Notion', 'Figma', 'Stripe']
  const check = companiesToCheck(companies, profile)

  it('tools and platforms the owner names are not other employers', () => {
    for (const text of [
      'I deployed the matchmaking service on Amazon Web Services and cut costs by a third.',
      'I shipped a VR title for Meta Quest and profiled it on device.',
      'I host my side projects on Google Cloud Platform.',
      'I built the payment flow with Stripe and wrote the retry logic.',
      'Our team ran on Discord and Notion for planning.',
      'I prototyped the UI in Figma before writing any code.',
      'Unreal Engine is where I do most of my work, and I know Epic tooling.'
    ]) {
      expect(otherCompanyNamed(text, 'Acme', check)).toBeNull()
    }
  })

  it('a product company counts when its full name is written', () => {
    expect(otherCompanyNamed('I would love to join Epic Games next.', 'Acme', ['Epic Games'])).toBe('Epic Games')
    expect(otherCompanyNamed('My time at Unity Technologies taught me a lot.', 'Acme', ['Unity Technologies'])).toBe('Unity Technologies')
  })

  it('a real other employer still counts', () => {
    expect(otherCompanyNamed('I want to work at Riot Games because of the live service.', 'Acme', check)).toBe('Riot Games')
    expect(otherCompanyNamed('I want to work at Valve because of Steam Deck.', 'Acme', check)).toBe('Valve')
  })

  it('a one-word name at the start of a sentence does not count', () => {
    for (const [text, name] of [
      ['Remote work suits me, and I shipped two games while fully remote.', 'Remote'],
      ['Scale was the hard part of that project.', 'Scale'],
      ['Clear ownership helped the team ship.', 'Clear'],
      ['Current tooling made the build slow, so I rewrote it.', 'Current']
    ]) {
      expect(otherCompanyNamed(text, 'Acme', [name])).toBeNull()
    }
    expect(otherCompanyNamed('I like it. Remote work suits me.', 'Acme', ['Remote'])).toBeNull()
  })

  it('a one-word name in the middle of a sentence still counts', () => {
    expect(otherCompanyNamed('I spent three years at Ubisoft working on tools.', 'Acme', ['Ubisoft'])).toBe('Ubisoft')
  })
})

describe('M2: school questions are not self-ID', () => {
  it.each(['What school did you attend?', 'Which school did you attend?', 'Name of the school you attended'])('"%s" is not self-ID', (label) => {
    expect(demographicFamily(field(label, 'text', []))).toBeNull()
  })
  it.each(['What type of school did you attend?', 'Did you attend a state-funded school?', 'Which school did you attend, state or private?'])('"%s" still is', (label) => {
    expect(demographicFamily(field(label, 'select'))).toBe('school_type')
  })
})

describe('M4: years of experience with "or more" anywhere', () => {
  const run = (label: string) => mapKnownField(field(label), ctx(withFacts([])))
  it.each([
    'Do you have 5 years of experience or more?',
    'Do you have 5 years of experience or longer?',
    'Do you have 5 years of experience and above?',
    'Do you have 5 years of experience plus?',
    'Do you have 3+ years of experience?'
  ])('"%s" is answered from the total', (label) => {
    expect(run(label)).toMatchObject({ value: 'Yes', needsUser: false, source: 'profile' })
  })
  it('compares against the threshold', () => {
    expect(run('Do you have 10 years of experience or more?')).toMatchObject({ value: 'No', needsUser: false })
  })
})

describe('veteran setting never picks an option that says "I am a veteran"', () => {
  const vet = ['I am not a veteran', 'I am a veteran, but not a protected veteran', 'I identify as one or more of the classifications of protected veteran', "I don't wish to answer"]
  const settings = (eeo: Partial<Settings['eeo']>) => ({ ...DEFAULT_SETTINGS, eeo: { ...DEFAULT_SETTINGS.eeo, ...eeo } })
  it('"I am not a protected veteran" does not pick the veteran option', () => {
    const got = demographicAnswer(field('Veteran Status', 'select', vet), settings({ veteran: 'not_protected' }), null)
    expect(got.value).not.toBe(vet[1])
    expect(got.value).not.toBe(vet[2])
  })
  it('a person who served but is not a protected veteran still gets that option', () => {
    expect(demographicAnswer(field('Veteran Status', 'select', vet), settings({ veteran: 'not_protected', militaryService: 'yes' }), null).value).toBe(vet[1])
  })
})

describe('locations: region comes from the part after the comma', () => {
  it('reads the region after the comma first', () => {
    expect(regionOf('Kansas City, Missouri, United States')).toBe('MO')
    expect(regionOf('Kansas City, Kansas, United States')).toBe('KS')
    expect(regionOf('Washington, District of Columbia, United States')).toBe('DC')
    expect(regionOf('Seattle, Washington, United States')).toBe('WA')
    expect(regionOf('Charleston, West Virginia')).toBe('WV')
    expect(regionOf('Austin, TX')).toBe('TX')
  })
  it('picks the right Kansas City and Washington', () => {
    expect(chooseSuggestion(['Kansas City, Missouri, United States', 'Kansas City, Kansas, United States'], 'Kansas City, MO', true)).toBe('Kansas City, Missouri, United States')
    expect(chooseSuggestion(['Kansas City, Kansas, United States'], 'Kansas City, MO', true)).toBeNull()
    expect(chooseSuggestion(['Washington, District of Columbia, United States'], 'Washington, DC', true)).toBe('Washington, District of Columbia, United States')
    expect(chooseSuggestion(['Washington, District of Columbia, United States'], 'Washington, WA', true)).toBeNull()
    expect(chooseSuggestion(['Seattle, Washington, United States'], 'Seattle, WA', true)).toBe('Seattle, Washington, United States')
  })
  it('accepts a metro area for its own city and nobody else', () => {
    expect(chooseSuggestion(['San Francisco Bay Area'], 'San Francisco, CA', true)).toBe('San Francisco Bay Area')
    expect(chooseSuggestion(['San Francisco Bay Area'], 'Oakland, CA', true)).toBeNull()
    expect(chooseSuggestion(['San Francisco Bay Area'], 'San Francisco, TX', true)).toBeNull()
    expect(chooseSuggestion(['Greater Seattle Area'], 'Seattle, WA', true)).toBe('Greater Seattle Area')
  })
  it('keeps the earlier picks', () => {
    expect(chooseSuggestion(['Athens, Georgia, United States', 'Athens, Alabama, United States'], 'Athens, GA', true)).toBe('Athens, Georgia, United States')
    expect(chooseSuggestion(['Athens, Alabama, United States'], 'Athens, GA', true)).toBeNull()
    expect(chooseSuggestion(['Brooklyn, New York, United States'], 'Brooklyn, NY', true)).toBe('Brooklyn, New York, United States')
  })
})

describe('a held letter and an optional upload', () => {
  const letterBox = (required: boolean): FormField => field('Cover letter', 'file', [], { key: 'cl', required, fileHint: 'cover_letter' })
  const pdf = (required: boolean, patch: Partial<PreparedAnswer> = {}): PreparedAnswer => ({
    fieldKey: 'cl', label: 'Cover letter', type: 'file', required, options: [], value: COVER_LETTER_PDF, source: 'file', confidence: 1, needsUser: false, note: null, lint: null, ...patch
  })

  it('an optional upload does not hold the application, a required one does', () => {
    expect(letterInUse([letterBox(false)], [pdf(false)])).toBe(false)
    expect(letterInUse([letterBox(true)], [pdf(true)])).toBe(true)
    expect(letterInUse([field('Cover letter', 'textarea', [], { key: 'cb', required: false })], [])).toBe(true)
  })

  it('drops the optional upload while the letter is held, and puts it back when it passes', () => {
    const fields = [letterBox(false)]
    const dropped = syncOptionalLetterUploads(fields, [pdf(false)], 'A letter.', true)
    expect(dropped[0]).toMatchObject({ value: '', note: HELD_UPLOAD_NOTE, needsUser: false })
    const restored = syncOptionalLetterUploads(fields, dropped, 'A better letter.', false)
    expect(restored[0].value).toBe(COVER_LETTER_PDF)
  })

  it('leaves a required upload alone and does nothing without a letter', () => {
    const required = [pdf(true)]
    expect(syncOptionalLetterUploads([letterBox(true)], required, 'A letter.', true)).toBe(required)
    const optional = [pdf(false)]
    expect(syncOptionalLetterUploads([letterBox(false)], optional, '', true)).toBe(optional)
  })

  it('answerFields leaves an optional upload empty when the draft letter fails the check', async () => {
    const bad = 'I am excited to leverage my passion to deliver a seamless, cutting-edge synergy in this dynamic role. '.repeat(3)
    const llm = { async json() { return { value: { answers: [] }, costUsd: 0 } }, async text() { return { value: '', costUsd: 0 } } }
    const deps: AnswerDeps = { llm: llm as never, settings: { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, minLintScore: 100 } }, profile: withFacts([]), samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: null }
    const job = { id: 'j', company: 'Acme', title: 'Engineer', location: 'Austin, TX', description: 'x', fit: null, source: 'greenhouse', country: 'United States' }
    const optional = await answerFields(deps, job as never, [letterBox(false)], bad)
    expect(optional.answers[0]).toMatchObject({ value: '', note: HELD_UPLOAD_NOTE, needsUser: false })
    const required = await answerFields(deps, job as never, [letterBox(true)], bad)
    expect(required.answers[0].value).toBe(COVER_LETTER_PDF)
  })
})
