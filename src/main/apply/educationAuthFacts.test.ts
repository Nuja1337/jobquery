import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, AuthorizationEntry, FieldType, FormField, Profile } from '@shared/types'
import { mapApplicationField } from './applicationFacts'
import { answerFields, type AnswerDeps, type JobForAnswers } from './answers'
import { mapInferredField, mapKnownField, type MapContext, type MappedAnswer } from './fieldMap'

// Education, experience, certification and authorization questions answer from a fact the person gave,
// or they flag. Nothing here reaches the model.

const NOW = new Date(2026, 10, 7)

const US_CITIZEN: AuthorizationEntry = { country: 'United States', status: 'citizen', needsSponsorship: false, notes: '' }
const baseFacts = (patch: Partial<ApplicationFacts> = {}): ApplicationFacts => ({
  ...structuredClone(EMPTY_APPLICATION_FACTS),
  authorization: [US_CITIZEN],
  salary: [{ currency: 'USD', min: 110000, target: 130000, period: 'year', answerStyle: 'range' }],
  clearance: 'None',
  driversLicense: true,
  over18: true,
  ...patch
})
const profileWith = (patch: Partial<ApplicationFacts> = {}, rest: Partial<Profile> = {}): Profile => ({
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  location: 'Austin, TX',
  yearsExperience: 8,
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
  application: baseFacts(patch),
  ...rest
})
const edu = (patch: Partial<ApplicationFacts['education']>): Partial<ApplicationFacts> => ({
  education: { ...EMPTY_APPLICATION_FACTS.education, ...patch }
})
const exp = (patch: Partial<ApplicationFacts['experience']>): Partial<ApplicationFacts> => ({
  experience: { ...EMPTY_APPLICATION_FACTS.experience, ...patch }
})

const field = (label: string, type: FieldType = 'select', patch: Partial<FormField> = {}): FormField =>
  ({ key: 'q', label, type, required: true, options: type === 'select' ? ['Yes', 'No'] : [], placeholder: null, maxLength: null, fileHint: null, ...patch }) as FormField
const ctxOf = (profile: Profile, patch: Partial<MapContext> = {}): MapContext => ({
  profile,
  settings: DEFAULT_SETTINGS,
  jobSource: 'greenhouse',
  jobLocation: 'Austin, TX',
  company: 'Acme',
  now: NOW,
  ...patch
})

/** What the fact branches alone say. */
const facts = (label: string, profile = profileWith(), type: FieldType = 'select', patch: Partial<FormField> = {}, ctx: Partial<MapContext> = {}): MappedAnswer | null =>
  mapApplicationField(field(label, type, patch), ctxOf(profile, ctx))
/** What the whole mapper says, as the filler sees it. */
const mapped = (label: string, profile = profileWith(), type: FieldType = 'select', patch: Partial<FormField> = {}): MappedAnswer | null => {
  const f = field(label, type, patch)
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

describe('degree held', () => {
  const bachelor = profileWith(edu({ highestCompleted: 'bachelor' }))

  it('says No to a master\'s degree when only a bachelor\'s is held', () => {
    expectValue(facts("Do you have a Master's degree?", bachelor), 'No')
    expectValue(facts('Have you earned a PhD?', bachelor), 'No')
  })

  it('says Yes to the level held and to the levels below it', () => {
    expectValue(facts("Do you have a Bachelor's degree?", bachelor), 'Yes')
    expectValue(facts('Do you have an associate degree?', bachelor), 'Yes')
    expectValue(facts('Do you have a high school diploma or GED?', bachelor), 'Yes')
    expectValue(facts("Do you hold a Bachelor's degree or higher?", profileWith(edu({ highestCompleted: 'master' }))), 'Yes')
  })

  it('flags when no level is given', () => {
    expectFlag(facts("Do you have a Bachelor's degree?", profileWith()))
  })

  it('uses the profile\'s education entries when the fact is empty', () => {
    const entries = profileWith({}, { education: [{ school: 'UT Austin', degree: 'BS', field: 'Computer Science', end: '2018' }] })
    expectValue(facts("Do you have a Bachelor's degree?", entries), 'Yes')
    expectValue(facts("Do you have a Master's degree?", entries), 'No')
  })

  it('does not count a degree in progress as earned', () => {
    const inProgress = profileWith({}, { education: [{ school: 'UT Austin', degree: 'MS', end: '2028' }] })
    expectFlag(facts("Do you have a Master's degree?", inProgress))
  })

  it('flags a No when a master\'s is in progress next to a bachelor\'s', () => {
    const both = profileWith(edu({ highestCompleted: 'bachelor' }), {
      education: [
        { school: 'UT Austin', degree: 'BS', end: '2018' },
        { school: 'Georgia Tech', degree: 'MS Computer Science', end: 'present' }
      ]
    })
    expectFlag(facts("Do you have a Master's degree?", both))
    expectValue(facts("Do you have a Bachelor's degree?", both), 'Yes')
  })

  it('flags a No when entries show a completed master\'s the fact does not', () => {
    const conflict = profileWith(edu({ highestCompleted: 'bachelor' }), { education: [{ school: 'MIT', degree: 'MS', end: '2020' }] })
    expectFlag(facts("Do you have a Master's degree?", conflict))
  })

  it('flags a No when the person is enrolled in something the profile does not name', () => {
    expectFlag(facts("Do you have a Master's degree?", profileWith(edu({ highestCompleted: 'bachelor', currentlyEnrolled: true }))))
    expectValue(facts("Do you have a Master's degree?", profileWith(edu({ highestCompleted: 'bachelor', currentlyEnrolled: false }))), 'No')
  })

  it('flags equivalent experience instead of saying No', () => {
    expectFlag(facts("Do you have a Master's degree or equivalent experience?", bachelor))
    expectValue(facts("Do you have a Bachelor's degree or equivalent experience?", bachelor), 'Yes')
  })

  it('flags wording it could misread', () => {
    expectFlag(facts("Do you have a Bachelor's degree and 3 years of experience?", bachelor))
    expectFlag(facts("Do you have a Bachelor's degree from an accredited university?", bachelor))
    expectFlag(facts("Are you not pursuing a Bachelor's degree?", bachelor))
    expectFlag(facts("Do you have a Bachelor's degree in progress?", bachelor))
  })

  it('reads a bare degree as a bachelor\'s', () => {
    expectValue(facts('Do you have a college degree?', bachelor), 'Yes')
    expectFlag(facts('Do you have a college degree?', profileWith(edu({ highestCompleted: 'associate' }))))
  })
})

describe('degree in a field', () => {
  const label = "Do you have a Bachelor's degree in Computer Science or a related field?"
  const cs = profileWith(edu({ highestCompleted: 'bachelor', fields: ['Computer Science'], relatedFields: ['Game Design'] }))

  it('says Yes when the field is one of the person\'s fields', () => {
    expectValue(facts(label, cs), 'Yes')
    expectValue(facts("Do you have a Bachelor's in CS?", cs), 'Yes')
  })

  it('says Yes when the field is a related field on the profile', () => {
    expectValue(facts("Do you have a Bachelor's degree in Game Design?", cs), 'Yes')
    expectValue(facts("Do you have a Bachelor's degree in Game Design, Art or a related field?", cs), 'Yes')
  })

  it('flags when the field is unknown', () => {
    expectFlag(facts(label, profileWith(edu({ highestCompleted: 'bachelor' }))))
    expectFlag(facts("Do you have a Bachelor's degree in Mechanical Engineering?", cs))
  })

  it('does not take a part of a field name for the field', () => {
    expectFlag(facts("Do you have a Bachelor's degree in Science?", profileWith(edu({ highestCompleted: 'bachelor', fields: ['Computer Science'] }))))
    expectValue(facts("Do you have a Bachelor's degree in Computer Science?", profileWith(edu({ highestCompleted: 'bachelor', fields: ['Computer Science and Engineering'] }))), 'Yes')
  })

  it('says No when the degree is not held, whatever the field', () => {
    expectValue(facts("Do you have a Master's degree in Computer Science?", cs), 'No')
  })

  it('flags a bare "related field"', () => {
    expectFlag(facts("Do you have a Bachelor's degree in a related field?", cs))
  })
})

describe('enrolled and graduating', () => {
  it('answers a plain enrollment question from the fact', () => {
    expectValue(facts('Are you currently enrolled in a degree program?', profileWith(edu({ currentlyEnrolled: true }))), 'Yes')
    expectValue(facts('Are you currently a student?', profileWith(edu({ currentlyEnrolled: false }))), 'No')
    expectFlag(facts('Are you currently enrolled in school?', profileWith()))
  })

  it('flags an enrollment question that names more', () => {
    expectFlag(facts("Are you currently enrolled in a Master's program?", profileWith(edu({ currentlyEnrolled: false }))))
    expectFlag(facts('Are you a full-time student?', profileWith(edu({ currentlyEnrolled: true }))))
  })

  it('does not take "pursuing" in a job question for enrollment', () => {
    expect(facts('Are you pursuing other opportunities?', profileWith(edu({ currentlyEnrolled: true })))).toBeNull()
  })

  const grad = profileWith(edu({ expectedGraduation: '2027-05' }))
  it('writes the expected graduation the way the field asks', () => {
    expectValue(facts('Expected graduation date', grad, 'text'), 'May 2027')
    expectValue(facts('Expected graduation year', grad, 'text'), '2027')
    expectValue(facts('Expected graduation month', grad, 'text'), 'May')
    expectValue(facts('Expected graduation date', grad, 'text', { placeholder: 'MM/YYYY' }), '05/2027')
    expectValue(facts('When do you expect to graduate?', grad, 'select', { options: ['Spring 2027', 'May 2027', 'Fall 2027'] }), 'May 2027')
    expectValue(facts('Expected graduation year', grad, 'select', { options: ['2026', '2027', '2028'] }), '2027')
  })

  it('writes a full date when the fact has one', () => {
    expectValue(facts('Anticipated graduation date', profileWith(edu({ expectedGraduation: '2027-05-15' })), 'date'), '2027-05-15')
  })

  it('flags when the date is missing or the field needs a day the fact lacks', () => {
    expectFlag(facts('Expected graduation date', profileWith(), 'text'))
    expectFlag(facts('Expected graduation date', grad, 'date'))
    expectFlag(facts('Expected graduation date', grad, 'text', { placeholder: 'MM/DD/YYYY' }))
    expectFlag(facts('Expected graduation date', grad, 'select', { options: ['Spring 2028', 'Fall 2028'] }))
  })
})

describe('highest level of education', () => {
  const pick = (profile: Profile, options: string[]) => mapInferredField(field('Highest level of education completed', 'select', { options }), ctxOf(profile))

  it('picks the level from the education fact first', () => {
    const profile = profileWith(edu({ highestCompleted: 'master' }), { education: [{ school: 'UT', degree: 'BS', end: '2018' }] })
    expect(pick(profile, ["High School", "Bachelor's Degree", "Master's Degree", 'Doctorate'])).toMatchObject({ value: "Master's Degree", source: 'profile', needsUser: false })
  })

  it('works without any education entry', () => {
    expect(pick(profileWith(edu({ highestCompleted: 'bachelor' })), ["Bachelor's Degree", "Master's Degree"])).toMatchObject({ value: "Bachelor's Degree", needsUser: false })
  })

  it('flags when no option matches', () => {
    expectFlag(pick(profileWith(edu({ highestCompleted: 'master' })), ['Some College', 'Graduate School']))
  })

  it('still reads the entries when the fact is empty', () => {
    const profile = profileWith({}, { education: [{ school: 'UT', degree: 'BS', end: '2018' }] })
    expect(pick(profile, ["Bachelor's Degree", "Master's Degree"])).toMatchObject({ value: "Bachelor's Degree" })
  })
})

describe('years of a kind of work', () => {
  const years = profileWith(exp({ professionalSoftware: 6, gamesIndustry: 4, teamLead: 2, peopleManagement: 0 }))

  it('answers software and engineering questions from the software years', () => {
    expectValue(facts('Do you have 3+ years of software engineering experience?', years), 'Yes')
    expectValue(facts('Do you have at least 8 years of professional software development experience?', years), 'No')
    expectValue(facts('How many years of experience do you have in software engineering?', years, 'number'), '6')
    expectValue(facts('Years of professional software experience', years, 'text'), '6 years')
  })

  it('answers the games industry from its own years', () => {
    expectValue(facts('Do you have 3+ years of experience in the games industry?', years), 'Yes')
    expectValue(facts('Do you have 5+ years of experience in the video game industry?', years), 'No')
    expectValue(facts('How many years of experience do you have in the games industry?', years, 'number'), '4')
  })

  it('answers leading a team and managing people, and keeps 0 as an answer', () => {
    expectValue(facts('Do you have at least 2 years of experience leading a team?', years), 'Yes')
    expectValue(facts('Do you have at least 3 years of experience leading a team?', years), 'No')
    expectValue(facts('Do you have 1+ years of experience managing people?', years), 'No')
    expectValue(facts('How many years of experience do you have managing direct reports?', years, 'number'), '0')
  })

  it('flags a kind with no answered fact', () => {
    const empty = profileWith()
    expectFlag(facts('Do you have 3+ years of software engineering experience?', empty))
    expectFlag(facts('Do you have 3+ years of experience in the games industry?', empty))
    expectFlag(facts('Do you have at least 3 years of experience leading a team?', empty))
    expectFlag(facts('How many years of experience do you have managing people?', empty, 'number'))
  })

  it('flags kinds the facts hold no years for', () => {
    const flagged = [
      'Do you have 2+ years shipping AAA titles?',
      'Do you have 2+ years of experience shipping AAA titles?',
      'Do you have 3 years of experience in a lead role?',
      'Do you have 5 years of experience in a senior role?',
      'Do you have 3 years of console experience?',
      'Do you have 4+ years of experience with mobile games?',
      'Do you have 3+ years of game development experience?',
      'Do you have 3+ years of backend software engineering experience?',
      'Do you have 3+ years of experience leading a team of 10 engineers?'
    ]
    for (const label of flagged) expectFlag(facts(label, years))
    expectFlag(facts('How many years of experience do you have shipping AAA titles?', years, 'number'))
  })

  it('still answers general experience from the total and a named skill from its years', () => {
    expectValue(facts('Do you have 5 years of professional experience?', years), 'Yes')
    const withSkill = profileWith({ skillYears: { 'C++': 6 }, ...exp({ professionalSoftware: null }) })
    expectValue(facts('Do you have 5+ years of experience with C++?', withSkill), 'Yes')
  })

  it('leaves a written answer to the writer', () => {
    expect(facts('Describe your years of experience leading teams', years, 'textarea')).toBeNull()
  })
})

describe('titles shipped', () => {
  const shipped = profileWith(exp({ shippedTitles: 3, aaaTitles: 1, platforms: ['pc', 'console'] }))

  it('answers "at least one AAA title" from the AAA count', () => {
    expectValue(facts('Have you shipped at least one AAA title?', shipped), 'Yes')
    expectValue(facts('Have you shipped at least two AAA titles?', shipped), 'No')
    expectValue(facts('Have you shipped a AAA title?', profileWith(exp({ shippedTitles: 3, aaaTitles: 0 }))), 'No')
  })

  it('answers other counts from the shipped titles', () => {
    expectValue(facts('Have you shipped at least 3 titles?', shipped), 'Yes')
    expectValue(facts('Have you shipped more than 3 games?', shipped), 'No')
    expectValue(facts('Have you ever shipped a game?', shipped), 'Yes')
    expectValue(facts('Have you ever shipped a game?', profileWith(exp({ shippedTitles: 0 }))), 'No')
  })

  it('answers a count question with a number', () => {
    expectValue(facts('How many titles have you shipped?', shipped, 'number'), '3')
    expectValue(facts('How many AAA titles have you shipped?', shipped, 'text'), '1')
  })

  it('answers a platform question from the platforms', () => {
    expectValue(facts('Have you shipped on console?', shipped), 'Yes')
    expectValue(facts('Have you shipped a game on mobile?', shipped), 'No')
    expectValue(facts('Have you shipped on mobile?', profileWith(exp({ shippedTitles: 0 }))), 'No')
    expectFlag(facts('Have you shipped on console?', profileWith()))
  })

  it('flags when the count is not answered', () => {
    expectFlag(facts('Have you shipped at least one AAA title?', profileWith()))
    expectFlag(facts('How many titles have you shipped?', profileWith(), 'number'))
  })

  it('flags counts of AAA plus a platform and questions that add conditions', () => {
    expectFlag(facts('Have you shipped an AAA title on console?', shipped))
    expectFlag(facts('Have you shipped a game that sold over a million copies?', shipped))
    expectFlag(facts('Have you shipped at least 3 titles on console?', shipped))
  })

  it('does not take years of shipping for a count', () => {
    expectFlag(facts('Do you have 2+ years of experience shipping games?', shipped))
  })
})

describe('certifications', () => {
  const certified = profileWith({}, { certifications: ['PMP', 'AWS Certified Solutions Architect - Associate', 'Certified ScrumMaster (CSM)'] })

  it('says Yes on a clear name match', () => {
    expectValue(facts('Do you hold a PMP certification?', certified), 'Yes')
    expectValue(facts('Are you PMP certified?', certified), 'Yes')
    expectValue(facts('Do you have an AWS Certified Solutions Architect - Associate certification?', certified), 'Yes')
    expectValue(facts('Are you a Certified Scrum Master?', certified), 'Yes')
    expectValue(facts('Do you hold a CSM certification?', certified), 'Yes')
  })

  it('flags a certification the profile does not list by name', () => {
    expectFlag(facts('Do you hold a CISSP certification?', certified))
    expectFlag(facts('Do you hold an AWS Certified Solutions Architect - Professional certification?', certified))
    expectFlag(facts('Do you hold an AWS Certified Solutions Architect certification?', certified))
    expectFlag(facts('Do you hold a PMP certification?', profileWith()))
  })

  it('flags wording it could misread', () => {
    expectFlag(facts('Do you hold a PMP certification and a CSM certification?', certified))
    expectFlag(facts('Are you willing to obtain a PMP certification?', certified))
    expectFlag(facts('Has your PMP certification ever lapsed?', certified))
    expectFlag(facts('Do you have any relevant certifications?', certified))
  })

  it('answers "any certifications" from the list', () => {
    expectValue(facts('Do you have any certifications?', certified), 'Yes')
    expectFlag(facts('Do you have any certifications?', profileWith()))
  })

  it('does not take a consent for a certification', () => {
    expect(facts('Do you certify that the information above is true?', certified)).toBeNull()
  })
})

describe('export control and immigration', () => {
  it('answers a U.S. person question from the fact', () => {
    const yes = profileWith({ exportControlUsPerson: true })
    const no = profileWith({ exportControlUsPerson: false })
    expectValue(facts('Are you a U.S. person as defined by ITAR?', yes), 'Yes')
    expectValue(facts('Are you a U.S. person as defined by ITAR?', no), 'No')
    expectValue(facts('Are you a U.S. person (U.S. citizen, lawful permanent resident, or protected individual) under export control regulations?', yes), 'Yes')
    expectValue(facts('Are you a foreign person under the EAR?', yes), 'No')
    expectValue(facts('Are you a non-U.S. person?', no), 'Yes')
  })

  it('flags with the family note when the fact is not answered', () => {
    const r = facts('Are you a U.S. person as defined by ITAR?', profileWith())
    expectFlag(r)
    expect(r?.note).toMatch(/^This asks about export control rules\./)
  })

  it('flags other export control wording', () => {
    const yes = profileWith({ exportControlUsPerson: true })
    expectFlag(facts('Are you a U.S. person and willing to obtain a clearance?', yes))
    expectFlag(facts('Will you require an export license to access this technology under ITAR?', yes))
    expectFlag(facts('Are you able to access ITAR controlled data?', yes))
    expectFlag(facts('Are you not a U.S. person?', yes))
  })

  it('keeps an immigration case with the person', () => {
    const profile = profileWith({ exportControlUsPerson: true })
    const r = facts('Will you now or in the future require the company to commence an immigration case in order to employ you?', profile)
    expectFlag(r)
    expect(r?.note).toMatch(/^This asks about an immigration case\./)
    expectFlag(facts('Do you have a pending immigration petition?', profile))
  })

  it('leaves a sponsorship question that mentions immigration to the sponsorship rules', () => {
    expect(facts('Will you require immigration sponsorship?', profileWith())).toBeNull()
    expectValue(mapped('Will you require immigration sponsorship?'), 'No')
  })
})

describe('citizenships', () => {
  const dual = profileWith({ citizenships: ['United States', 'Canada'] })
  const single = profileWith({ citizenships: ['United States'] })

  it('answers dual citizenship from the list', () => {
    expectValue(facts('Do you hold dual citizenship?', dual), 'Yes')
    expectValue(facts('Do you hold dual citizenship?', single), 'No')
    expectValue(facts('Are you a citizen of more than one country?', dual), 'Yes')
    expectValue(facts('Do you have a second citizenship?', single), 'No')
  })

  it('answers citizenship of a country other than the one named', () => {
    expectValue(facts('Are you a citizen of a country other than the United States?', dual), 'Yes')
    expectValue(facts('Are you a citizen of a country other than the United States?', single), 'No')
    expectValue(facts('Do you hold dual citizenship with Canada?', dual), 'Yes')
    expectValue(facts('Are you a dual citizen of the US and Canada?', dual), 'Yes')
  })

  it('flags an empty list, because it could mean not answered', () => {
    expectFlag(facts('Do you hold dual citizenship?', profileWith()))
    expectFlag(facts('Do you hold dual citizenship?', profileWith({ authorization: [US_CITIZEN] })))
  })

  it('reads citizen entries in the authorization list too', () => {
    const entries = profileWith({ authorization: [US_CITIZEN, { ...US_CITIZEN, country: 'Canada' }] })
    expectValue(facts('Do you hold dual citizenship?', entries), 'Yes')
  })

  it('flags a country the list does not hold and wording it could misread', () => {
    expectFlag(facts('Are you a dual citizen of the US and Germany?', dual))
    expectFlag(facts('Do you plan to obtain a second citizenship?', single))
    expectFlag(facts('Are you a dual citizen and authorized to work in the US?', dual))
  })

  it('does not change the plain citizen question', () => {
    expectValue(mapped('Are you a U.S. citizen?', dual), 'Yes')
  })
})

describe('visa types', () => {
  const visaProfile = (visaType: AuthorizationEntry['visaType'], status: AuthorizationEntry['status'] = 'visa') =>
    profileWith({ authorization: [{ country: 'United States', status, needsSponsorship: false, notes: '', visaType }] })

  it('answers OPT and STEM OPT questions from the visa type', () => {
    expectValue(facts('Are you currently on OPT?', visaProfile('f1_opt')), 'Yes')
    expectValue(facts('Are you currently on F-1 OPT?', visaProfile('f1_opt')), 'Yes')
    expectValue(facts('Are you currently on STEM OPT?', visaProfile('f1_opt')), 'No')
    expectValue(facts('Are you currently on STEM OPT?', visaProfile('stem_opt')), 'Yes')
    expectValue(facts('Are you currently on OPT?', visaProfile('stem_opt')), 'Yes')
    expectValue(facts('Are you currently on OPT?', visaProfile('h1b')), 'No')
  })

  it('answers H-1B and TN questions from the visa type', () => {
    expectValue(facts('Do you currently hold an H-1B visa?', visaProfile('h1b')), 'Yes')
    expectValue(facts('Are you currently in H-1B status?', visaProfile('tn')), 'No')
    expectValue(facts('Are you currently working on a TN visa?', visaProfile('tn')), 'Yes')
    expectValue(facts('Are you on a TN visa?', visaProfile('other')), 'No')
    expectValue(facts('Do you currently hold an H-1B visa?', visaProfile('', 'citizen')), 'No')
  })

  it('answers either of two visas', () => {
    expectValue(facts('Are you currently on OPT or STEM OPT?', visaProfile('stem_opt')), 'Yes')
    expectValue(facts('Are you on an H-1B or TN visa?', visaProfile('f1_opt')), 'No')
  })

  it('flags when the visa type is not set', () => {
    expectFlag(facts('Are you currently on OPT?', visaProfile('')))
    expectFlag(facts('Are you on an F-1 visa?', visaProfile('other')))
  })

  it('flags a missing U.S. entry and wording it could misread', () => {
    expectFlag(facts('Are you currently on OPT?', profileWith({ authorization: [] })))
    expectFlag(facts('Have you ever held an H-1B visa?', visaProfile('h1b')))
    expectFlag(facts('Are you not on an H-1B visa?', visaProfile('h1b')))
    expectFlag(facts('Are you on OPT and do you need an extension?', visaProfile('f1_opt')))
    expectFlag(facts('Are you on CPT or OPT?', visaProfile('f1_opt')))
    expectFlag(facts('Do you require H-1B transfer?', visaProfile('h1b')))
  })

  it('leaves sponsorship questions and "opt in" to their own rules', () => {
    expect(facts('Will you require H-1B sponsorship?', visaProfile('h1b'))).toBeNull()
    expect(facts('Do you opt in to receive texts?', visaProfile('h1b'))).toBeNull()
    expect(facts('Nashville, TN office: can you attend?', visaProfile('h1b'))).toBeNull()
  })
})

describe('authorized to work for any employer', () => {
  const entryProfile = (patch: Partial<AuthorizationEntry>) => profileWith({ authorization: [{ country: 'United States', status: 'visa', needsSponsorship: false, notes: '', ...patch }] })
  const label = 'Are you legally authorized to work in the United States for any employer?'

  it('reads anyEmployer on a visa entry', () => {
    expectValue(facts(label, entryProfile({ visaType: 'f1_opt', anyEmployer: false })), 'No')
    expectValue(facts(label, entryProfile({ visaType: 'tn', anyEmployer: true })), 'Yes')
  })

  it('flags when anyEmployer is not answered', () => {
    expectFlag(facts(label, entryProfile({ visaType: 'h1b', anyEmployer: null })))
    expectFlag(facts(label, entryProfile({ visaType: 'h1b' })))
  })

  it('answers Yes to a citizen and a permanent resident, and No to no authorization', () => {
    expectValue(facts(label, profileWith()), 'Yes')
    expectValue(facts(label, entryProfile({ status: 'permanent_resident' })), 'Yes')
    expectValue(facts(label, entryProfile({ status: 'none' })), 'No')
  })

  it('reads the opposite wording the opposite way', () => {
    expectValue(facts('Is your work authorization tied to a specific employer?', entryProfile({ visaType: 'h1b', anyEmployer: false })), 'Yes')
    expectValue(facts('Is your work authorization tied to a specific employer?', profileWith()), 'No')
  })

  it('flags a country with no entry and wording it could misread', () => {
    expectFlag(facts('Are you authorized to work in Germany for any employer?', profileWith()))
    expectFlag(facts('Are you authorized to work for any employer, without sponsorship?', entryProfile({ visaType: 'tn', anyEmployer: true })))
    expectFlag(facts('Are you not authorized to work for any employer?', profileWith()))
  })

  it('says No to "any employer without sponsorship" when the permit is tied to one', () => {
    expectValue(facts('Are you authorized to work for any employer without sponsorship?', entryProfile({ visaType: 'h1b', anyEmployer: false })), 'No')
  })

  it('beats the general authorization rule', () => {
    expectValue(mapped(label, entryProfile({ visaType: 'h1b', anyEmployer: false })), 'No')
    expectValue(mapped('Are you legally authorized to work in the United States?', entryProfile({ visaType: 'h1b', anyEmployer: false })), 'Yes')
  })
})

describe('clearance eligibility', () => {
  const label = 'Are you eligible to obtain a security clearance?'

  it('answers from the eligibility fact', () => {
    expectValue(facts(label, profileWith({ clearanceEligible: true })), 'Yes')
    expectValue(facts(label, profileWith({ clearanceEligible: false })), 'No')
    expectValue(facts('Are you able to obtain and maintain a U.S. government security clearance?', profileWith({ clearanceEligible: true })), 'Yes')
  })

  it('flags when the fact is not answered', () => {
    expectFlag(facts(label, profileWith({ clearanceEligible: null })))
  })

  it('flags a named level and compound or history wording', () => {
    const eligible = profileWith({ clearanceEligible: true })
    expectFlag(facts('Are you eligible to obtain a Top Secret clearance?', eligible))
    expectValue(facts('Are you eligible to obtain a Top Secret clearance?', profileWith({ clearanceEligible: false })), 'No')
    expectFlag(facts('Are you a U.S. citizen eligible to obtain a security clearance?', eligible))
    expectFlag(facts('Have you ever been denied a security clearance?', eligible))
    expectFlag(facts('Are you willing to undergo the investigation required to obtain a security clearance?', eligible))
  })

  it('keeps the held-clearance answers', () => {
    expectValue(facts('Do you hold an active security clearance?', profileWith({ clearance: 'None', clearanceEligible: true })), 'No')
  })
})

describe('salary against the posted range', () => {
  const label = 'Expected salary (USD)'
  const ranged = (min: number | null, target: number | null, patch: Partial<ApplicationFacts['salary'][number]> = {}) =>
    profileWith({ salary: [{ currency: 'USD', min, target, period: 'year', answerStyle: 'number', ...patch }] })
  const posted = (max: number | null, currency: string | null = 'USD'): Partial<MapContext> => ({ jobSalaryMin: 90000, jobSalaryMax: max, jobCurrency: currency })

  it('sends the posted maximum when the target is above it and the minimum fits', () => {
    const r = facts(label, ranged(110000, 130000), 'number', {}, posted(120000))
    expectValue(r, '120000')
    expect(r?.note).toMatch(/posted maximum/)
  })

  it('flags when the minimum does not fit under the posted maximum', () => {
    expectFlag(facts(label, ranged(125000, 130000), 'number', {}, posted(120000)))
    expectFlag(facts(label, ranged(null, 130000), 'number', {}, posted(120000)))
  })

  it('leaves the target alone when it fits under the maximum', () => {
    expectValue(facts(label, ranged(110000, 130000), 'number', {}, posted(150000)), '130000')
    expectValue(facts(label, ranged(110000, 130000), 'number', {}, posted(130000)), '130000')
  })

  it('ignores a range in another currency or one with no currency', () => {
    expectValue(facts(label, ranged(110000, 130000), 'number', {}, posted(100000, 'EUR')), '130000')
    expectValue(facts(label, ranged(110000, 130000), 'number', {}, posted(100000, null)), '130000')
    expectValue(facts(label, ranged(110000, 130000), 'number', {}, posted(null)), '130000')
  })

  it('keeps the minimum when the question asks for it and it fits', () => {
    expectValue(facts('Minimum salary (USD)', ranged(110000, 130000), 'number', {}, posted(120000)), '110000')
  })

  it('writes a range as the minimum up to the posted maximum', () => {
    const r = facts(label, ranged(110000, 130000, { answerStyle: 'range' }), 'text', {}, posted(120000))
    expect(r?.value).toBe('110,000 to 120,000 USD')
    expect(r?.needsUser).toBe(false)
  })

  it('compares in the entry\'s pay period', () => {
    const monthly = profileWith({ salary: [{ currency: 'USD', min: 9000, target: 11000, period: 'month', answerStyle: 'number' }] })
    expectValue(facts('Expected monthly salary (USD)', monthly, 'number', {}, posted(120000)), '10000')
  })

  it('picks the option for the capped figure', () => {
    const r = facts('Expected salary (USD)', ranged(110000, 130000), 'select', { options: ['$100,000-$115,000', '$115,001-$125,000', '$125,001+'] }, posted(120000))
    expect(r?.value).toBe('$115,001-$125,000')
  })

  it('does not flag a negotiable answer', () => {
    const r = facts(label, ranged(125000, 130000, { answerStyle: 'negotiable' }), 'text', {}, posted(120000))
    expect(r?.needsUser).toBe(false)
  })
})

describe('through the whole mapper', () => {
  it('leaves the review fixes and the availability answers alone', () => {
    const profile = profileWith({ workArrangement: { remote: true, hybrid: true, onsite: true, maxOfficeDaysPerWeek: null, commutableCities: [] }, screening: { backgroundCheck: true, drugTest: true, creditCheck: false } })
    expectValue(mapped('Are you open to a hybrid schedule?', profile), 'Yes')
    expectValue(mapped('Are you willing to undergo a background check?', profile), 'Yes')
    expectFlag(mapped('Have you ever failed a background check?', profile))
  })
})

describe('the knockout probe labels', () => {
  const labels = [
    'Are you a U.S. person as defined by ITAR?',
    'Will you now or in the future require the company to commence an immigration case in order to employ you?',
    "Do you have a Master's degree?",
    "Do you have a Bachelor's degree in Computer Science or a related field?",
    'Do you have 2+ years shipping AAA titles?',
    'Do you have 3+ years of software engineering experience?',
    'Do you hold a PMP certification?',
    'Are you currently on OPT?',
    'Do you hold dual citizenship?',
    'Are you legally authorized to work in the United States for any employer?',
    'Are you eligible to obtain a security clearance?',
    'Have you shipped at least one AAA title?',
    'Have you shipped on console?'
  ]

  it.each([
    ['empty facts', profileWith()],
    ['filled facts', profileWith({ ...edu({ highestCompleted: 'bachelor', fields: ['Computer Science'] }), ...exp({ professionalSoftware: 5, shippedTitles: 2, aaaTitles: 0, platforms: ['pc'] }), citizenships: ['United States'], exportControlUsPerson: true, clearanceEligible: true }, { certifications: ['PMP'] })]
  ])('answers from a fact or flags, never from the model, with %s', async (_name, profile) => {
    const llm = { json: vi.fn(async () => ({ costUsd: 0, value: { answers: [] } })) }
    const deps = { llm, settings: DEFAULT_SETTINGS, profile, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: 'resume.pdf' } as unknown as AnswerDeps
    const job = { id: 'j', company: 'Studio', title: 'Gameplay Programmer', location: 'Irvine, CA', description: 'Onsite.', fit: null, source: 'greenhouse' } as JobForAnswers
    const fields = labels.map((label, i) => field(label, 'select', { key: `q${i}` }))
    const { answers } = await answerFields(deps, job, fields, null)
    expect(llm.json).not.toHaveBeenCalled()
    expect(answers).toHaveLength(labels.length)
    for (const a of answers) {
      if (a.needsUser) expect(a.value).toBe('')
      else expect(a.source).toBe('profile')
    }
    // With no facts only the two that a U.S. citizen entry settles are answered.
    if (_name === 'empty facts') {
      const answered = answers.filter((a) => !a.needsUser).map((a) => a.label)
      expect(answered).toEqual(['Are you currently on OPT?', 'Are you legally authorized to work in the United States for any employer?'])
    }
  })
})

describe('a profile saved before these facts existed', () => {
  const { education: _e, experience: _x, citizenships: _c, exportControlUsPerson: _u, clearanceEligible: _l, ...old } = baseFacts()
  const profile = { ...profileWith(), application: old as ApplicationFacts }

  it('flags instead of failing', () => {
    expectFlag(facts("Do you have a Master's degree?", profile))
    expectFlag(facts('Are you currently enrolled in school?', profile))
    expectFlag(facts('Do you have 3+ years of software engineering experience?', profile))
    expectFlag(facts('Have you shipped at least one AAA title?', profile))
    expectFlag(facts('Do you hold dual citizenship?', profile))
    expectFlag(facts('Are you a U.S. person as defined by ITAR?', profile))
    expectFlag(facts('Expected graduation date', profile, 'text'))
  })

  it('still answers what an authorization entry settles', () => {
    expectValue(facts('Are you currently on OPT?', profile), 'No')
    expectFlag(mapped('Are you eligible to obtain a security clearance?', profile))
  })
})
