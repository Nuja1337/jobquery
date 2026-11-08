import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, FieldType, FormField, Profile, SourceKind } from '@shared/types'
import labels from './__fixtures__/application-labels.json'
import { canonicalSkill, formatDate, pickDialCode, yearsWith } from './applicationFacts'
import { mapInferredField, mapKnownField, mustAskUser } from './fieldMap'

// Every branch that answers from profile.application, driven by real labels in the fixture.

const FACTS: ApplicationFacts = {
  ...EMPTY_APPLICATION_FACTS,
  address: { street: '221 Baker Street', city: 'Austin', region: 'TX', postalCode: '78701', country: 'United States' },
  phoneCountryCode: '+1',
  authorization: [
    { country: 'United States', status: 'citizen', needsSponsorship: false, notes: '' },
    { country: 'Germany', status: 'visa', needsSponsorship: true, notes: '' },
    { country: 'United Kingdom', status: 'none', needsSponsorship: true, notes: '' }
  ],
  salary: [
    { currency: 'USD', min: 110000, target: 130000, period: 'year', answerStyle: 'range' },
    { currency: 'EUR', min: 90000, target: 100000, period: 'year', answerStyle: 'number' },
    { currency: 'GBP', min: 70000, target: 80000, period: 'year', answerStyle: 'negotiable' }
  ],
  noticeWeeks: 4,
  earliestStart: null,
  relocation: { willing: true, places: ['Germany', 'Austin'] },
  travel: 'some',
  skillYears: { React: 6, Python: 8, 'Node.js': 5, Kubernetes: 2.5, Go: 1, JavaScript: 9, PostgreSQL: 7, 'Amazon Web Services': 5 },
  languageLevels: { English: 'native', German: 'conversational', French: 'basic' },
  clearance: 'Secret',
  driversLicense: true,
  over18: true,
  references: 'Available on request.',
  gpa: '3.7',
  heardAbout: 'LinkedIn'
}

const FULL: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  location: 'Austin, TX',
  yearsExperience: 10,
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
  application: FACTS
}

const withFacts = (patch: Partial<ApplicationFacts>): Profile => ({ ...FULL, application: { ...FACTS, ...patch } })

const PROFILES: Record<string, Profile> = {
  full: FULL,
  empty: { ...FULL, application: structuredClone(EMPTY_APPLICATION_FACTS) },
  noAddress: withFacts({ address: EMPTY_APPLICATION_FACTS.address }),
  oneSalary: withFacts({ salary: [FACTS.salary[0]] }),
  asap: withFacts({ noticeWeeks: 0 }),
  earliest: withFacts({ earliestStart: '2027-01-15' }),
  relocNo: withFacts({ relocation: { willing: false, places: [] } }),
  travelFrequent: withFacts({ travel: 'frequent' }),
  travelNone: withFacts({ travel: 'none' }),
  clearNone: withFacts({ clearance: 'None' }),
  futureSource: FULL,
  minor: withFacts({ over18: false }),
  germanFluent: withFacts({ languageLevels: { English: 'native', German: 'fluent' } }),
  noStart: withFacts({ noticeWeeks: null, earliestStart: null }),
  earliestOnly: withFacts({ noticeWeeks: null, earliestStart: '2027-01-15' }),
  // Links, languages, skills and history for the rules that read them.
  linked: { ...FULL, links: { ...EMPTY_PROFILE.links, linkedin: 'https://linkedin.com/in/sam', github: 'https://github.com/sam', portfolio: 'https://sam.dev/work', website: 'https://sam.dev' } },
  fluentLanguages: withFacts({ languageLevels: { English: 'native', Spanish: 'fluent', German: 'conversational', French: 'basic' } }),
  listedLanguages: { ...FULL, languages: ['English', 'German (B1)', 'Japanese'], application: { ...FACTS, languageLevels: {} } },
  noLanguages: { ...FULL, application: { ...FACTS, languageLevels: {} } },
  skilled: { ...FULL, skills: ['C++', 'Unreal Engine 5', 'Python'], application: { ...FACTS, skillYears: {} } },
  family: withFacts({ relativesAtEmployers: false, referrals: 'none' }),
  chinaCitizen: withFacts({ authorization: [{ country: 'China', status: 'citizen', needsSponsorship: false, notes: '' }] }),
  noUkEntry: withFacts({ authorization: [{ country: 'United States', status: 'citizen', needsSponsorship: false, notes: '' }] }),
  noAuthorization: { ...FULL, workAuthorization: { authorizedCountries: [], needsSponsorship: false, notes: '' }, application: { ...FACTS, authorization: [] } },
  atRiot: { ...FULL, experience: [{ company: 'Riot Games, Inc.', title: 'Engineer', start: '2018', end: '2020', highlights: [] }] },
  atSony: { ...FULL, experience: [{ company: 'Sony', title: 'Engineer', start: '2018', end: '2020', highlights: [] }] },
  atTencent: { ...FULL, experience: [{ company: 'Tencent', title: 'Engineer', start: '2018', end: '2020', highlights: [] }] },
  atMetaPlatforms: { ...FULL, experience: [{ company: 'Meta Platforms', title: 'Engineer', start: '2018', end: '2020', highlights: [] }] }
}

const JOBS: Record<string, { location: string | null; currency: string | null }> = {
  us: { location: 'Austin, TX', currency: 'USD' },
  de: { location: 'Berlin, Germany', currency: 'EUR' },
  gb: { location: 'London, UK', currency: 'GBP' },
  se: { location: 'Stockholm, Sweden', currency: null },
  remote: { location: 'Remote', currency: null }
}

const NOW = new Date(2026, 10, 7) // 7 November 2026

const field = (label: string, type: FieldType = 'text', options: string[] = [], placeholder: string | null = null): FormField => ({
  key: 'q',
  label,
  type,
  required: true,
  options,
  placeholder,
  maxLength: null,
  fileHint: null
})

const map = (f: FormField, profile: Profile, job = 'us', source: SourceKind = 'greenhouse', company = 'Acme') => {
  const j = JOBS[job]
  const ctx = { profile, settings: DEFAULT_SETTINGS, jobSource: source, jobLocation: j.location, jobCurrency: j.currency, company, now: NOW }
  return mapKnownField(f, ctx) ?? mapInferredField(f, ctx)
}

interface Row {
  label: string
  type?: FieldType
  options?: string[]
  placeholder?: string
  job?: string
  profile?: string
  company?: string
  required?: boolean
  expect: string
}

describe('application facts on real labels', () => {
  for (const [branch, rows] of Object.entries(labels as unknown as Record<string, Row[] | string>)) {
    if (!Array.isArray(rows)) continue
    describe(branch, () => {
      for (const row of rows) {
        const name = `${row.label.trim()} [${row.type ?? 'text'}${row.job ? `, ${row.job}` : ''}${row.profile ? `, ${row.profile}` : ''}]`
        it(name, () => {
          const f = { ...field(row.label, row.type ?? 'text', row.options ?? [], row.placeholder ?? null), required: row.required ?? true }
          const source: SourceKind = row.profile === 'futureSource' ? ('somenewboard' as SourceKind) : 'greenhouse'
          const got = map(f, PROFILES[row.profile ?? 'full'], row.job ?? 'us', source, row.company ?? 'Acme')
          if (row.expect === '@needsUser') {
            expect(got?.needsUser).toBe(true)
            expect(got?.value).toBe('')
          } else if (row.expect === '@null') {
            // Nothing in the rules answers it, so it goes on to the saved answers and the model.
            expect(got).toBeNull()
          } else if (row.expect === '@empty') {
            // Answered as blank on purpose, and it does not need the person.
            expect(got).toMatchObject({ value: '', needsUser: false })
          } else if (row.expect === '@blank') {
            expect(got?.value ?? '').toBe('')
          } else {
            expect(got).toMatchObject({ value: row.expect, needsUser: false })
          }
        })
      }
    })
  }
})

describe('notes when a fact is missing', () => {
  const empty = PROFILES.empty
  it('tells the person where to add it', () => {
    expect(map(field('Street Address'), empty)?.note).toBe('Add your street address in Profile.')
    expect(map(field('Postal code'), empty)?.note).toBe('Add your postal code in Profile.')
    expect(map(field('What are your salary expectations?'), empty)?.note).toBe('Add your expected salary in USD in Profile.')
    expect(map(field('What is your notice period?'), empty)?.note).toBe('Add your notice period in Profile.')
    expect(map(field('How many years of experience do you have with Rust?', 'number'), FULL)?.note).toBe('Add your years with Rust in Profile.')
    expect(map(field('Are you willing to relocate?', 'select', ['Yes', 'No']), empty)?.needsUser).toBe(true)
    expect(map(field('Do you have a valid driver license?', 'select', ['Yes', 'No']), empty)?.needsUser).toBe(true)
    expect(map(field('Are you at least 18 years of age?', 'select', ['Yes', 'No']), empty)?.needsUser).toBe(true)
  })

  it('lets a free-form profile fact answer when the structured fact is empty', () => {
    const profile: Profile = { ...empty, facts: [{ question: 'Salary expectations', answer: '150k plus equity' }] }
    expect(map(field('Salary expectations'), profile)).toMatchObject({ value: '150k plus equity', needsUser: false })
  })

  it('uses the structured fact before a free-form one', () => {
    const profile: Profile = { ...FULL, facts: [{ question: 'Salary expectations', answer: '150k plus equity' }] }
    expect(map(field('Salary expectations'), profile)?.value).toBe('110,000 to 130,000 USD')
  })
})

describe('salary details', () => {
  it('takes the currency from the question before the job', () => {
    expect(map(field('Expected salary in EUR', 'number'), FULL, 'us')?.value).toBe('100000')
  })

  it('writes a range with its period when the entry is not yearly', () => {
    const profile = withFacts({ salary: [{ currency: 'USD', min: 5000, target: 6000, period: 'month', answerStyle: 'range' }] })
    expect(map(field('Salary expectations'), profile)?.value).toBe('5,000 to 6,000 USD per month')
  })

  it('refuses a number field for a negotiable answer', () => {
    expect(map(field('Compensation expectations', 'number'), FULL, 'gb')).toMatchObject({ needsUser: true, value: '' })
  })

  it('asks when a monthly entry meets a form that names no period', () => {
    const profile = withFacts({ salary: [{ currency: 'USD', min: 5000, target: 6000, period: 'month', answerStyle: 'number' }] })
    expect(map(field('Expected salary', 'number'), profile)?.needsUser).toBe(true)
    expect(map(field('Expected monthly salary', 'number'), profile)?.value).toBe('6000')
  })

  it('uses the board country when the location says Remote', () => {
    const ctx = { profile: FULL, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse' as const, jobLocation: 'Remote', jobCountry: 'Germany', company: 'Acme', now: NOW }
    expect(mapKnownField(field('Salary expectations', 'number'), ctx)?.value).toBe('100000')
  })

  it('names a note when the only entry is used for a job of unknown currency', () => {
    const got = map(field('Salary expectations'), PROFILES.oneSalary, 'remote')
    expect(got?.note).toMatch(/only salary entry/)
    expect(got?.confidence).toBeLessThan(0.85)
  })
})

describe('salary choice lists and pay periods', () => {
  const entry = (patch: Partial<ApplicationFacts['salary'][number]>) => withFacts({ salary: [{ currency: 'USD', min: 60000, target: 60000, period: 'year', answerStyle: 'range', ...patch }] })
  const pick = (label: string, options: string[], profile: Profile, job = 'us') => map(field(label, 'select', options), profile, job)

  it('turns a yearly entry into the monthly figure when the options are monthly', () => {
    const options = ['Under 4,000 per month', '4,000 - 6,000 per month', '6,000 - 8,000 per month', '8,000+ per month']
    expect(pick('What is your expected salary?', options, entry({ min: 66000, target: 66000 }))).toMatchObject({ value: '4,000 - 6,000 per month', needsUser: false })
    expect(pick('What is your expected salary?', options, entry({ min: 120000, target: 120000 }))?.value).toBe('8,000+ per month')
  })

  it('turns a yearly entry into the hourly figure when the options are hourly', () => {
    const options = ['$20-$30 per hour', '$30-$50 per hour', '$100+ per hour']
    expect(pick('Desired salary (USD)', options, entry({}))).toMatchObject({ value: '$20-$30 per hour', needsUser: false })
    // 100 an hour is about 208,000 a year, which the yearly entry of 60,000 does not reach.
    expect(pick('Desired salary (USD)', options, entry({ min: 210000, target: 210000 }))?.value).toBe('$100+ per hour')
  })

  it('turns a monthly entry into the yearly figure when the options are yearly', () => {
    const options = ['Under 40,000 per year', '40,000 - 60,000 per year', '60,000 - 80,000 per year']
    const profile = entry({ currency: 'EUR', min: 5500, target: 5500, period: 'month' })
    expect(pick('Expected salary (EUR)', options, profile, 'de')).toMatchObject({ value: '60,000 - 80,000 per year', needsUser: false })
  })

  it('turns an hourly entry into the yearly figure', () => {
    const options = ['Under 60,000', '60,000 - 90,000', '90,000+']
    const profile = entry({ min: 40, target: 40, period: 'hour' })
    // The question names the period, since the options do not.
    expect(pick('Expected annual salary (USD)', options, profile)?.value).toBe('60,000 - 90,000')
  })

  it('reads an option with no period in the period the question names', () => {
    const options = ['Under 4,000', '4,000 - 6,000', '6,000+']
    expect(pick('Expected monthly salary (USD)', options, entry({}))?.value).toBe('4,000 - 6,000')
  })

  it('keeps a yearly entry against options that name no period', () => {
    expect(pick('Expected salary (USD)', ['Under 50,000', '50,000 - 70,000', '70,000+'], entry({}))?.value).toBe('50,000 - 70,000')
  })

  it('asks when a monthly entry meets options that name no period', () => {
    const profile = entry({ currency: 'EUR', min: 5000, target: 5000, period: 'month' })
    const got = pick('Expected salary (EUR)', ['Under 40,000', '40,000 - 60,000', '60,000 - 80,000'], profile, 'de')
    expect(got).toMatchObject({ value: '', needsUser: true })
    expect(got?.note).toMatch(/pay period/)
  })

  it('asks when one option names two periods', () => {
    expect(pick('Expected salary (USD)', ['Under 5,000 per month (60,000 per year)', '5,000+ per month'], entry({}))?.needsUser).toBe(true)
  })

  it('asks when no option holds the amount', () => {
    expect(pick('Expected salary (USD)', ['Under 1,000 per month', '1,000 - 2,000 per month'], entry({}))).toMatchObject({ value: '', needsUser: true })
  })
})

describe('start date and notice period details', () => {
  it('formats dates the way the placeholder shows them', () => {
    const d = new Date(2026, 11, 5)
    expect(formatDate(d, null)).toBe('2026-12-05')
    expect(formatDate(d, 'MM/DD/YYYY')).toBe('12/05/2026')
    expect(formatDate(d, 'DD.MM.YYYY')).toBe('05.12.2026')
    expect(formatDate(d, 'YYYY/MM/DD')).toBe('2026/12/05')
    expect(formatDate(d, 'mm/dd/yy')).toBe('12/05/26')
    // The format may sit inside other words.
    expect(formatDate(d, 'Select date (MM/DD/YYYY)')).toBe('12/05/2026')
    expect(formatDate(d, 'e.g. DD.MM.YYYY')).toBe('05.12.2026')
    expect(formatDate(d, 'Pick a day')).toBe('2026-12-05')
  })

  it('says "as soon as possible" when notice is zero and no start date is set', () => {
    expect(map(field('Earliest start date'), PROFILES.asap)?.value).toBe('As soon as possible.')
  })

  it('picks the nearest longer option when none fits the notice period exactly', () => {
    expect(map(field('Notice period', 'select', ['Immediately', '1 week', '2 weeks', '6 weeks']), FULL)?.value).toBe('6 weeks')
  })

  it('never puts a past start date on the form', () => {
    const profile = withFacts({ earliestStart: '2020-01-01' })
    expect(map(field('Earliest start date', 'date'), profile)?.value).toBe('2026-12-05')
  })
})

describe('years with a skill', () => {
  it('matches skills through aliases', () => {
    const years = { 'Node.js': 5, TypeScript: 4, PostgreSQL: 7, Golang: 2, 'Amazon Web Services': 3, Kubernetes: 1 }
    expect(yearsWith(years, 'node')).toBe(5)
    expect(yearsWith(years, 'NodeJS')).toBe(5)
    expect(yearsWith(years, 'ts')).toBe(4)
    expect(yearsWith(years, 'postgres')).toBe(7)
    expect(yearsWith(years, 'go')).toBe(2)
    expect(yearsWith(years, 'AWS')).toBe(3)
    expect(yearsWith(years, 'k8s')).toBe(1)
    expect(yearsWith(years, 'rust')).toBeUndefined()
    expect(canonicalSkill('React.js')).toBe('react')
    expect(canonicalSkill('C#')).toBe('c#')
  })

  it('uses a singular for one year', () => {
    expect(map(field('Years of experience with Go'), FULL)?.value).toBe('1 year')
  })
})

describe('phone code options', () => {
  const options = ['Canada +1', 'United Kingdom +44', 'United States +1', 'United States Minor Outlying Islands +1']
  it('picks by the dial code and uses the country when several share it', () => {
    expect(pickDialCode(options, '+1', 'United States')).toBe('United States +1')
    expect(pickDialCode(options, '+1', 'Canada')).toBe('Canada +1')
    expect(pickDialCode(options, '+44', '')).toBe('United Kingdom +44')
    expect(pickDialCode(options, '+1', '')).toBeNull()
    expect(pickDialCode(options, '+49', 'Germany')).toBeNull()
    expect(pickDialCode(['+1', '+44'], '1', '')).toBe('+1')
  })

  it('asks when no option has the code', () => {
    const got = map(field('Phone country code', 'select', ['Germany +49', 'France +33']), FULL)
    expect(got).toMatchObject({ needsUser: true })
  })
})

describe('country questions use the address country', () => {
  it('prefers the address country over the profile location', () => {
    const profile = withFacts({ address: { ...FACTS.address, country: 'Germany' } })
    expect(map(field('Country', 'select', ['Canada', 'Germany', 'United States']), profile)?.value).toBe('Germany')
  })
})

describe('work authorization per country', () => {
  const yn = ['Yes', 'No']
  it('uses the entry for the country in the question over the job country', () => {
    const q = field('Are you legally authorized to work in Germany?', 'select', yn)
    expect(map(q, FULL, 'us')?.value).toBe('Yes')
    expect(map(field('Are you authorized to work in the United Kingdom?', 'select', yn), FULL, 'us')?.value).toBe('No')
  })

  it('treats a visa without sponsorship as no sponsorship needed', () => {
    const profile = withFacts({ authorization: [{ country: 'Germany', status: 'visa', needsSponsorship: false, notes: '' }] })
    expect(map(field('Do you require visa sponsorship?', 'select', yn), profile, 'de')?.value).toBe('No')
  })

  it('answers "authorized without sponsorship" from the entry', () => {
    const q = field('Are you authorized to work in the United Kingdom without sponsorship?', 'select', yn)
    expect(map(q, FULL, 'us')?.value).toBe('No')
  })

  it('keeps the older summary when no entry covers the country', () => {
    const profile = withFacts({ authorization: [] })
    expect(map(field('Do you require visa sponsorship?', 'select', yn), profile, 'de')?.value).toBe('Yes')
    expect(map(field('Do you require visa sponsorship?', 'select', yn), profile, 'us')?.value).toBe('No')
  })
})

describe('guards that stay as they were', () => {
  it('keeps AI-use, legal and consent questions for the person', () => {
    const ai = map(field('Did you use AI to write your application?', 'select', ['Yes', 'No']), FULL)
    expect(ai).toMatchObject({ needsUser: true, value: '' })
    const legal = map(field('Have you ever been convicted of a felony?', 'select', ['Yes', 'No']), FULL)
    expect(legal).toMatchObject({ needsUser: true, value: '' })
    const consent = map(field('I agree to the terms of the Agreement to Arbitrate', 'checkbox'), FULL)
    expect(consent).toMatchObject({ needsUser: true, value: '' })
  })

  it('still answers contact fields as before', () => {
    expect(map(field('Email'), FULL)?.value).toBe('sam@example.com')
  })
})

describe('criminal history is for the person', () => {
  it('flags the question with its own note', () => {
    expect(mustAskUser({ label: 'Have you ever been convicted of a felony?', type: 'select' })).toBe('This asks about legal history. Answer it yourself.')
    expect(mustAskUser({ label: 'Do you have any criminal convictions?', type: 'text' })).not.toBeNull()
    expect(mustAskUser({ label: 'Years of experience with Python', type: 'text' })).toBeNull()
  })
})
