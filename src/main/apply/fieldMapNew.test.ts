import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField, Profile } from '@shared/types'
import { agreeAnswer, isOptIn, mapInferredField, mapKnownField, optInAnswer, pickOption } from './fieldMap'

// Demographic, country, education, previous employment and opt-in questions seen on live forms.

const PROFILE: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
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
const optional = (f: FormField): FormField => ({ ...f, required: false })

// The known mappings first, then the inferred ones, as answerFields runs them (minus the saved answers).
const map = (f: FormField, profile: Profile = PROFILE, company = 'Acme') => {
  const ctx = { profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse' as const, jobLocation: 'New York, NY', company }
  return mapKnownField(f, ctx) ?? mapInferredField(f, ctx)
}

const DECLINE_OPTIONS = ['Male', 'Female', 'Non-binary', 'Decline To Self Identify']

describe('demographic questions', () => {
  it('declines gender, race, ethnicity, veteran and disability when a decline option exists', () => {
    expect(map(field('Gender', 'select', DECLINE_OPTIONS))?.value).toBe('Decline To Self Identify')
    expect(map(field('Gender Identity (optional)', 'select', DECLINE_OPTIONS))?.value).toBe('Decline To Self Identify')
    expect(map(field('Race or Ethnicity (optional)', 'select', ['Asian', 'White', "I don't wish to answer"]))?.value).toBe("I don't wish to answer")
    expect(map(field('Race and Ethnicity', 'select', ['Asian', 'White', 'Decline To Self Identify']))?.value).toBe('Decline To Self Identify')
    expect(map(field('Are you Hispanic/Latino?', 'select', ['Yes', 'No', 'Decline To Self Identify']))?.value).toBe('Decline To Self Identify')
    expect(map(field('Veteran Status', 'select', ['I am a veteran', 'I am not a veteran', "I don't wish to answer"]))?.value).toBe("I don't wish to answer")
    expect(map(field('Disability Status', 'select', ['Yes', 'No', "I don't wish to answer"]))?.value).toBe("I don't wish to answer")
  })

  it('declines sexual orientation, LGBTQ and transgender questions', () => {
    for (const label of ['Sexual Orientation', 'I consider myself a member of the LGBTQ+ community. (optional)', 'Do you identify as transgender?']) {
      expect(map(field(label, 'select', ['Yes', 'No', 'Decline To Self Identify'])), label).toMatchObject({ value: 'Decline To Self Identify', needsUser: false, source: 'settings' })
    }
  })

  it('leaves an optional question blank when there is no decline option, without asking the AI', () => {
    expect(map(optional(field('Gender', 'select', ['Male', 'Female'])))).toMatchObject({ value: '', needsUser: false })
    expect(map(optional(field('Sexual Orientation', 'text')))).toMatchObject({ value: '', needsUser: false })
    expect(map(optional(field('LGBTQ+', 'select', ['Yes', 'No'])))).toMatchObject({ value: '', needsUser: false })
    expect(map(optional(field('Gender', 'combobox')))).toMatchObject({ value: '', needsUser: false })
  })

  it('asks the person when a required question has no decline option', () => {
    const mapped = map(field('Gender', 'select', ['Male', 'Female']))
    expect(mapped).toMatchObject({ value: '', needsUser: true })
    expect(mapped?.note).toMatch(/no option to decline/)
    expect(map(field('Race', 'text'))).toMatchObject({ needsUser: true })
  })

  it('leaves a box for these questions unticked', () => {
    expect(map(optional(field('I consider myself a member of the LGBTQ+ community', 'checkbox')))).toMatchObject({ value: 'false', needsUser: false })
  })
})

const PHONE_CODES = ['United Kingdom +44', 'United States Minor Outlying Islands +1', 'United States +1', 'Canada +1']

describe('country and location', () => {
  const home: Profile = { ...PROFILE, location: 'Austin, TX' }

  it('treats a dial code as noise when picking an option', () => {
    expect(pickOption(PHONE_CODES, 'United States')).toBe('United States +1')
    expect(pickOption(PHONE_CODES, 'United Kingdom')).toBe('United Kingdom +44')
    expect(pickOption(PHONE_CODES, 'Canada')).toBe('Canada +1')
    expect(pickOption(PHONE_CODES, 'France')).toBeNull()
    expect(pickOption(['United States +1', 'United States +1'], 'United States')).toBeNull()
  })

  it('answers the phone country dropdown and residence questions from the profile location', () => {
    expect(map(field('Country', 'select', PHONE_CODES), home)?.value).toBe('United States +1')
    expect(map(field('Country', 'combobox', PHONE_CODES), home)?.value).toBe('United States +1')
    expect(map(field('Please select the country where you currently reside.', 'select', ['Canada', 'United States']), home)?.value).toBe('United States')
    expect(map(field('Country of residence', 'text'), home)?.value).toBe('United States')
    expect(map(field('Country', 'select', PHONE_CODES), { ...home, location: 'London, UK' })?.value).toBe('United Kingdom +44')
  })

  it('does not answer when the country is unknown or the question is about work rights', () => {
    expect(map(field('Country', 'select', PHONE_CODES), { ...home, location: '' })).toBeNull()
    expect(map(field('Country of citizenship', 'text'), home)).toBeNull()
  })

  it('answers yes or no to "are you located in" by comparing countries', () => {
    const yesNo = (label: string) => field(label, 'select', ['Yes', 'No'])
    expect(map(yesNo('Are you currently located in the US?'), home)?.value).toBe('Yes')
    expect(map(yesNo('Are you currently located in the US?'), { ...home, location: 'Berlin, Germany' })?.value).toBe('No')
    expect(map(yesNo('Do you currently reside in Canada?'), home)?.value).toBe('No')
    expect(map(yesNo('Do you currently reside in Canada?'), { ...home, location: 'Toronto, ON' })?.value).toBe('Yes')
    expect(map(yesNo('Do you currently reside in the United States?'), home)?.value).toBe('Yes')
  })

  it('stays out of it when either country is unknown or the place is a city', () => {
    const yesNo = (label: string) => field(label, 'select', ['Yes', 'No'])
    expect(map(yesNo('Are you currently located in the US?'), { ...home, location: '' })).toBeNull()
    expect(map(yesNo('Do you currently reside in Toronto?'), home)).toBeNull()
    expect(map(yesNo('Are you currently located in the US or Canada?'), home)).toBeNull()
  })

  it('keeps filling the city from the location', () => {
    expect(map(field('Location (City)'), home)?.value).toBe('Austin, TX')
  })
})

describe('education', () => {
  const withEducation = (...education: Profile['education']): Profile => ({ ...PROFILE, education })
  const bs = withEducation({ school: 'Georgia Tech', degree: 'BS', field: 'Computer Science', end: '2015' })
  const DEGREES = ["Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Doctor of Philosophy (Ph.D.)', 'Master of Business Administration (M.B.A.)', 'High School']

  it('fills school and discipline as plain text', () => {
    expect(map(field('School', 'combobox'), bs)?.value).toBe('Georgia Tech')
    expect(map(field('School', 'text'), bs)?.value).toBe('Georgia Tech')
    expect(map(field('Discipline', 'combobox'), bs)?.value).toBe('Computer Science')
    expect(map(field('Field of study', 'text'), bs)?.value).toBe('Computer Science')
    expect(map(field('Major', 'text'), bs)?.value).toBe('Computer Science')
  })

  it('maps degree abbreviations to the form options', () => {
    const degree = (text: string) => map(field('Degree', 'select', DEGREES), withEducation({ school: 'X', degree: text }))?.value
    for (const text of ['BS', 'B.Sc.', 'BA', "Bachelor's", 'Bachelor of Science']) expect(degree(text), text).toBe("Bachelor's Degree")
    for (const text of ['MS', 'MSc', 'M.S.', 'MA', 'Master of Science']) expect(degree(text), text).toBe("Master's Degree")
    for (const text of ['PhD', 'Ph.D.', 'Doctor of Philosophy']) expect(degree(text), text).toBe('Doctor of Philosophy (Ph.D.)')
    expect(degree('MBA')).toBe('Master of Business Administration (M.B.A.)')
    expect(degree('Associate of Arts')).toBe("Associate's Degree")
    expect(degree('AA')).toBe("Associate's Degree")
    expect(degree('High School Diploma')).toBe('High School')
  })

  it('prefers the specific option when the form has one', () => {
    const options = ['Bachelor of Science (B.S.)', 'Bachelor of Arts (B.A.)', 'Master of Science (M.S.)']
    expect(map(field('Degree', 'select', options), withEducation({ school: 'X', degree: 'BS' }))?.value).toBe('Bachelor of Science (B.S.)')
    expect(map(field('Degree', 'select', options), withEducation({ school: 'X', degree: 'B.A.' }))?.value).toBe('Bachelor of Arts (B.A.)')
    expect(map(field('Degree', 'select', options), withEducation({ school: 'X', degree: 'MSc' }))?.value).toBe('Master of Science (M.S.)')
  })

  it('answers only when the profile has the value and the option exists', () => {
    expect(map(field('School', 'text'), PROFILE)).toBeNull()
    expect(map(field('Discipline', 'text'), withEducation({ school: 'X' }))).toBeNull()
    expect(map(field('Degree', 'select', DEGREES), withEducation({ school: 'X' }))).toBeNull()
    expect(map(field('Degree', 'select', ['Certificate', 'Diploma']), bs)).toBeNull()
    expect(map(field('Degree', 'text'), withEducation({ school: 'X', degree: 'BS' }))?.value).toBe('BS')
  })

  it('uses the entry with the latest end date', () => {
    const two = withEducation({ school: 'Old U', degree: 'BS', end: '2010' }, { school: 'New U', degree: 'MS', end: '2014' })
    expect(map(field('School', 'text'), two)?.value).toBe('New U')
    const ongoing = withEducation({ school: 'Old U', degree: 'BS', end: '2010' }, { school: 'Now U', degree: 'PhD', end: 'present' })
    expect(map(field('School', 'text'), ongoing)?.value).toBe('Now U')
    const undated = withEducation({ school: 'First', degree: 'BS' }, { school: 'Second', degree: 'MS' })
    expect(map(field('School', 'text'), undated)?.value).toBe('First')
  })
})

describe('previous employment', () => {
  const worked = (company: string): Profile => ({ ...PROFILE, experience: [{ company, title: 'Engineer', start: '2018', end: '2020', highlights: [] }] })
  const at = (company: string, label: string, profile: Profile) => map(field(label, 'select', ['Yes', 'No']), profile, company)

  it('answers Yes when the profile lists the company and No otherwise', () => {
    const figma = 'Have you ever worked for Figma before, as an employee or a contractor/consultant?'
    expect(at('Figma', figma, worked('Figma, Inc.'))).toMatchObject({ value: 'Yes', confidence: 0.85, source: 'profile' })
    expect(at('Figma', figma, worked('Acme'))).toMatchObject({ value: 'No', confidence: 0.85 })
    const stripe = 'Have you ever been employed by Stripe or a Stripe affiliate?'
    expect(at('Stripe', stripe, worked('stripe'))?.value).toBe('Yes')
    expect(at('Stripe', stripe, PROFILE)?.value).toBe('No')
  })

  it('ignores questions that do not name the company or ask about someone else', () => {
    expect(at('Figma', 'Have you ever worked for the government?', worked('Acme'))).toBeNull()
    // Not a question about the person's own jobs. With no fact about family or friends, it waits for the person.
    expect(at('Figma', 'Do any family members work for Figma?', worked('Acme'))).toMatchObject({ needsUser: true, value: '' })
  })
})

describe('opt-ins to messages and marketing', () => {
  it('recognizes them', () => {
    for (const label of [
      'Yes - I consent to receiving SMS text messages',
      'Yes - I consent to receiving WhatsApp messages',
      'Do you opt-in to receive WhatsApp messages from Stripe Recruiting?',
      'Sign me up for the newsletter',
      'Join our talent community',
      'I would like to receive job alerts'
    ]) {
      expect(isOptIn(label), label).toBe(true)
    }
    for (const label of ['Do you have marketing experience?', 'Years of experience in marketing', 'Phone number', 'Unsubscribe from marketing emails']) {
      expect(isOptIn(label), label).toBe(false)
    }
  })

  it('leaves an optional box unticked and answers a required Yes/No with No', () => {
    expect(optInAnswer(optional(field('Yes - I consent to receiving SMS text messages', 'checkbox')))).toMatchObject({ value: 'false', needsUser: false })
    expect(optInAnswer(field('Do you opt-in to receive WhatsApp messages from Stripe Recruiting?', 'select', ['Yes', 'No']))).toMatchObject({ value: 'No', needsUser: false })
    expect(optInAnswer(field('Join our talent community', 'radio', ['Yes, add me', 'No, thanks']))?.value).toBe('No, thanks')
  })

  it('leaves a required box that must be ticked to opt in for the person', () => {
    expect(optInAnswer(field('I consent to receiving SMS text messages', 'checkbox'))).toMatchObject({ value: '', needsUser: true })
  })
})

describe('required privacy and truthfulness boxes', () => {
  const on = { ...DEFAULT_SETTINGS, autopilot: { ...DEFAULT_SETTINGS.autopilot, tickRequiredConsent: true } }
  const DISCORD = 'By checking this box, I consent to Discord collecting, storing, and processing my demographic data for the purpose of reviewing applications.'
  const WORKABLE = 'Can you confirm that everything in this application is true, accurate and complete?'

  it('agrees to the examples when the setting is on', () => {
    expect(agreeAnswer(field(DISCORD, 'checkbox'), on, 'Discord')).toMatchObject({ value: 'true', source: 'settings', confidence: 1, needsUser: false, note: 'Agreed because Settings allows it.' })
    expect(agreeAnswer(field(WORKABLE, 'select', ['Yes', 'No']), on)).toMatchObject({ value: 'Yes', source: 'settings', confidence: 1, note: 'Agreed because Settings allows it.' })
    for (const label of [
      'I have read and agree to the Privacy Policy',
      'I acknowledge the privacy notice',
      'I consent to the processing of my personal data under the GDPR',
      'I consent to Acme retaining my data for 12 months',
      'I confirm that the information provided is true, accurate and complete'
    ]) {
      expect(agreeAnswer(field(label, 'checkbox'), on, 'Acme'), label).toMatchObject({ value: 'true' })
    }
  })

  it('does nothing when the setting is off, or the field is optional or has no Yes option', () => {
    expect(agreeAnswer(field(DISCORD, 'checkbox'), DEFAULT_SETTINGS)).toBeNull()
    expect(agreeAnswer(optional(field(DISCORD, 'checkbox')), on)).toBeNull()
    expect(agreeAnswer(field(WORKABLE, 'select', ['I agree', 'I do not agree']), on)).toBeNull()
    expect(agreeAnswer(field(WORKABLE, 'text'), on)).toBeNull()
  })

  it('never agrees to arbitration, restrictions, waivers, terms, background checks, penalty wording or AI use', () => {
    for (const label of [
      'I agree to the Agreement to Arbitrate',
      'I agree to the non-compete and non-solicitation terms',
      'I waive my right to a jury trial',
      'I agree to the Terms of Service and the Privacy Policy',
      'I agree to the terms and conditions',
      'I have read the Terms of Use',
      'I authorize a background check',
      'I authorize the company to obtain a consumer report',
      'I certify under penalty of perjury that the information is true and complete',
      'I confirm that I did not use AI to write this application, and that everything in it is true',
      'I consent to AI tools processing my data',
      'I consent to my data being shared with third parties for processing',
      'I agree to the Privacy Policy and to receive marketing emails'
    ]) {
      expect(agreeAnswer(field(label, 'checkbox'), on, 'Acme'), label).toBeNull()
    }
  })

  it('does not match unrelated labels', () => {
    for (const label of ['First name', 'Why do you want to work here?', 'Are you authorized to work in the US?', 'Do you have experience with data processing pipelines?']) {
      expect(agreeAnswer(field(label, 'checkbox'), on, 'Acme'), label).toBeNull()
    }
  })
})

describe('more live labels', () => {
  const SF: Profile = {
    ...PROFILE,
    location: 'San Francisco, CA',
    experience: [{ company: 'Globex', title: 'Data Engineer', end: '2024', highlights: [] }],
    education: [{ school: 'Small Town College', degree: 'BS', field: 'Computer Science' }]
  }

  it('picks "US" from a list of short country names', () => {
    const options = ['Australia', 'Canada', 'The Netherlands', 'UAE', 'UK', 'US', 'Other']
    expect(map(field('Please select the country where you currently reside.', 'combobox', options), SF)?.value).toBe('US')
  })

  it('answers the city and state question for the country the person lives in', () => {
    expect(map(field('If located in the US, in what city and state do you reside?'), SF)?.value).toBe('San Francisco, CA')
    expect(map(field('If located in Canada, in what city do you reside?'), SF)).toBeNull()
    expect(map(field('Which city would you like to be based in?'), SF)).toBeNull()
  })

  it('uses the most recent job for "current or previous" questions', () => {
    expect(map(field('Who is your current or previous employer?'), SF)?.value).toBe('Globex')
    expect(map(field('What is your current or previous job title?'), SF)?.value).toBe('Data Engineer')
    // "Current" alone still needs a job without an end date.
    expect(map(field('Current company'), SF)).toBeNull()
  })

  it('types the school as written into a search box, even when it is not in the first page of options', () => {
    const firstPage = ['Aalborg University', 'Aalto University', 'Aarhus University']
    expect(map(field('School', 'combobox', firstPage), SF)).toMatchObject({ value: 'Small Town College', needsUser: false })
    expect(map(field('School', 'select', firstPage), SF)).toBeNull()
  })
})
