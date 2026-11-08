import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField, PreparedAnswer, Settings } from '@shared/types'
import type { LlmService } from '../llm/service'
import { answerFields, type AnswerDeps, type SavedAnswer } from './answers'
import { declineOption, demographicAnswer, demographicFamily } from './demographics'
import { mapKnownField, pickOption } from './fieldMap'

// Self-identification questions are answered from settings, the decline option or an exact saved
// answer. A recording model stub proves the AI never sees them.

const field = (label: string, type: FieldType = 'select', options: string[] = [], required = true): FormField => ({
  key: label,
  label,
  type,
  required,
  options,
  placeholder: null,
  maxLength: null,
  fileHint: null
})

const DONT = "I don't wish to answer"

// Option lists from real Greenhouse and Ashby forms.
const GH_GENDER = ['Male', 'Female', DONT]
const GH_HISPANIC = ['Yes', 'No', DONT]
const GH_VET = ['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran', DONT]
const GH_DISABILITY = ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability and have not had one in the past', DONT]
const DISCORD_RACE = ['Black or of African descent', 'East Asian', 'Hispanic, Latine or of Spanish Origin', 'White or European', DONT]
const EPIC_RACE = ['Hispanic or Latino', 'Asian (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)', 'Two or More Races (Not Hispanic or Latino)', DONT]
const ROBLOX_GENDER = ['Man', 'Non-binary', 'Woman', 'I prefer to self-describe', DONT]
const ASHBY_GENDER = ['Male', 'Female', 'Decline to self-identify']
const ASHBY_RACE = ['Hispanic or Latino', 'White (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)', 'Decline to self-identify']
const CC305 = ['Yes, I have a disability (or previously had a disability)', 'No, I do not have a disability', 'I do not want to answer']
const VEVRAA_CHOOSE_NOT = [
  'I identify as one or more of the classifications of protected veteran listed above, but choose not to self-identify the classification(s)',
  'I am not a protected veteran',
  'I prefer not to answer'
]
const ASHBY_VET = ['I identify as one or more of the classifications of protected veteran listed above', 'I am not a protected veteran', 'I decline to self-identify for protected veteran status']
const UK_ETHNICITY = ['Asian or Asian British - Indian', 'Black, Black British, Caribbean or African - African', 'Mixed - White and Asian', 'White - Irish', 'Prefer not to say']

const eeo = (patch: Partial<Settings['eeo']>): Settings => ({ ...DEFAULT_SETTINGS, eeo: { ...DEFAULT_SETTINGS.eeo, ...patch } })

const job = { id: 'j1', company: 'Acme', title: 'Engineer', location: null, description: '', fit: null, source: 'greenhouse' as const }

/** A model stub that records every prompt it is sent and says it does not know. */
function recorder() {
  const prompts: string[] = []
  const llm = {
    json: (req: { task: string; prompt: string }) => {
      prompts.push(`${req.task}\n${req.prompt}`)
      return Promise.resolve({ value: { answers: [] }, costUsd: 0 })
    },
    text: () => Promise.reject(new Error('No text call expected'))
  } as unknown as LlmService
  return { llm, prompts }
}

async function run(
  fields: FormField[],
  settings: Settings = DEFAULT_SETTINGS,
  options: { saved?: SavedAnswer | null; regenerate?: boolean; used?: string[] } = {}
): Promise<{ answers: PreparedAnswer[]; prompts: string[] }> {
  const { llm, prompts } = recorder()
  const deps: AnswerDeps = {
    llm,
    settings,
    profile: EMPTY_PROFILE,
    samples: [],
    findSavedAnswer: () => options.saved ?? null,
    markAnswerUsed: (id) => options.used?.push(id),
    resumePath: null
  }
  const regenerateKeys = options.regenerate ? new Set(fields.map((f) => f.key)) : undefined
  const res = await answerFields(deps, job, fields, null, { regenerateKeys })
  return { answers: res.answers, prompts }
}

const one = async (f: FormField, settings?: Settings, options?: Parameters<typeof run>[2]) => (await run([f], settings, options)).answers[0]

describe('demographicFamily', () => {
  const positives: Array<[string, FieldType, string]> = [
    ['Gender', 'select', 'gender'],
    ['Gender Identity (optional)', 'select', 'gender'],
    ['How would you describe your gender identity?', 'select', 'gender'],
    ['Sex', 'text', 'gender'],
    ['What are your personal pronouns?', 'select', 'pronouns'],
    ['Gender Pronouns', 'select', 'pronouns'],
    ['Transgender Status', 'select', 'transgender'],
    ['Do you identify as transgender?', 'select', 'transgender'],
    ['Is your gender identity the same as the sex you were assigned at birth?', 'select', 'transgender'],
    ['Sexual Orientation', 'select', 'sexual_orientation'],
    ['I consider myself a member of the LGBTQ+ community. (optional)', 'select', 'lgbtq'],
    ['Race', 'select', 'race'],
    ['Race/Ethnicity', 'select', 'race'],
    ['Please identify your race/ethnicity', 'select', 'race'],
    ['How would you describe your racial/ethnic background? (mark all that apply)', 'multiselect', 'race'],
    ['What is your ethnic group?', 'select', 'race'],
    ['Are you Hispanic/Latinx?', 'select', 'hispanic'],
    ['Veteran Status', 'select', 'veteran'],
    ['VeteranStatus', 'select', 'veteran'],
    ['Are you a protected veteran?', 'select', 'veteran'],
    ['Are you a veteran, active member or reservist of the United States Armed Forces?', 'radio', 'veteran'],
    ['Are you a veteran/have you served in the military?', 'radio', 'veteran'],
    ['Are you a military spouse?', 'select', 'military_spouse'],
    ['Disability Status', 'select', 'disability'],
    ['Do you have a disability?', 'select', 'disability'],
    [
      'Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, other) that substantially limits 1 or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning?',
      'select',
      'disability'
    ],
    ['Do you consider yourself neurodivergent?', 'select', 'neurodivergent'],
    ['What is your religion or belief?', 'select', 'religion'],
    ['What is your marital status?', 'select', 'marital'],
    ['Are you pregnant or on maternity leave?', 'select', 'pregnancy'],
    ['Do you have caring responsibilities?', 'select', 'caring'],
    ['Did you receive free school meals?', 'select', 'socioeconomic'],
    ['What type of school did you attend?', 'select', 'school_type'],
    ['Did either of your parents attend university?', 'select', 'parent_degree'],
    ['Age band', 'select', 'age'],
    ['Date of birth', 'date', 'age'],
    ['How do you identify?', 'select', 'identity']
  ]
  it.each(positives)('recognizes "%s"', (label, type, family) => {
    expect(demographicFamily(field(label, type, ['A', 'B']))).toBe(family)
  })

  const negatives: Array<[string, FieldType]> = [
    ['Describe a race condition you debugged', 'text'],
    ['Describe a race condition you debugged', 'textarea'],
    ['Have you ever fixed a data race in a lock-free queue?', 'select'],
    ['How do you design for players with disabilities?', 'text'],
    ['How do you design for players with disabilities?', 'textarea'],
    ['Describe how you would rate content with sex and violence for ESRB', 'text'],
    ['What is the ESRB rating of the last game you shipped?', 'text'],
    ['How do you approach gender representation in character design?', 'text'],
    ['Are you an industry veteran?', 'select'],
    ['Are you a veteran of the games industry?', 'select'],
    ['Do you have experience localizing games for Hispanic or Latino markets?', 'select'],
    ['Have you shipped a racing game or race mode?', 'select'],
    ['Tell us about a game you worked on with LGBTQ+ inclusive storylines', 'textarea'],
    ['Describe your experience with accessibility features', 'text'],
    ['Gender', 'textarea'],
    ['Veteran status', 'textarea'],
    ['Favorite game engine', 'text'],
    ['Are you at least 18 years of age?', 'select']
  ]
  it.each(negatives)('does not recognize "%s" (%s)', (label, type) => {
    expect(demographicFamily(field(label, type, ['Yes', 'No']))).toBeNull()
  })
})

describe('questions that only look demographic', () => {
  const settings = eeo({ gender: 'man', race: ['white'], veteran: 'not_protected', disability: 'no', pronouns: 'he' })
  const looks: Array<[string, FieldType, string[]]> = [
    ['Describe a race condition you debugged', 'text', []],
    ['How do you design for players with disabilities?', 'text', []],
    ['Describe how you would rate content with sex and violence for ESRB', 'text', []],
    ['How do you approach gender representation in character design?', 'text', []],
    ['Are you an industry veteran?', 'select', ['Yes', 'No']],
    ['Do you require any accommodations due to a disability during the interview process?', 'select', ['Yes', 'No', 'Prefer not to say']]
  ]

  it.each(looks)('never gives "%s" a demographic setting value', async (label, type, options) => {
    const f = field(label, type, options)
    const settingValues = ['Male', 'Man', 'White', 'I am not a protected veteran', 'No', 'he/him']
    const mapped = mapKnownField(f, { profile: EMPTY_PROFILE, settings, jobSource: 'greenhouse', jobLocation: null, company: 'Acme' })
    expect(settingValues).not.toContain(mapped?.value)
    // Open questions go to the writing model, which the stub does not serve. Reaching it proves the gate let go of the field.
    const answered = await one(f, settings).catch(() => null)
    if (answered) {
      expect(answered.rule).toBeUndefined()
      if (answered.source === 'settings') expect(settingValues).not.toContain(answered.value)
    }
  })

  it('sends accommodation questions to the person, not the disability setting', async () => {
    const f = field('Do you require any accommodations due to a disability during the interview process?', 'select', ['Yes', 'No'])
    expect(await one(f, settings)).toMatchObject({ needsUser: true, value: '' })
    expect(await one({ ...f, required: false }, settings)).toMatchObject({ needsUser: false, value: '' })
  })
})

describe('declineOption', () => {
  it('picks "I do not want to answer" on the CC-305 list', () => {
    expect(declineOption(CC305)).toBe('I do not want to answer')
  })

  it('does not pick the VEVRAA option that states a status and then chooses not to self-identify', () => {
    expect(declineOption(VEVRAA_CHOOSE_NOT)).toBe('I prefer not to answer')
    expect(declineOption([VEVRAA_CHOOSE_NOT[0], VEVRAA_CHOOSE_NOT[1]])).toBeNull()
  })

  it('returns null when more than one candidate is left', () => {
    expect(declineOption(['Prefer not to say', 'Decline to state'])).toBeNull()
  })

  it.each(["I don't wish to answer", 'I don’t wish to answer', 'Decline to state', 'Decline To Self Identify', 'No answer', 'I do not want to answer', "I don't want to answer", 'Prefer not to disclose', 'I decline to self-identify for protected veteran status'])(
    'finds "%s"',
    (text) => {
      expect(declineOption(['Yes', 'No', text])).toBe(text)
    }
  )

  it('is what pickOption uses for "decline"', () => {
    expect(pickOption(VEVRAA_CHOOSE_NOT, 'decline')).toBe('I prefer not to answer')
    expect(pickOption(ASHBY_VET, 'decline')).toBe('I decline to self-identify for protected veteran status')
  })
})

describe('answers on default settings (decline)', () => {
  it('picks the decline option on every real list', async () => {
    const cases: Array<[FormField, string]> = [
      [field('Gender', 'select', GH_GENDER), DONT],
      [field('Gender', 'select', ASHBY_GENDER), 'Decline to self-identify'],
      [field('How would you describe your gender identity?', 'select', ROBLOX_GENDER), DONT],
      [field('Are you Hispanic/Latinx?', 'select', GH_HISPANIC), DONT],
      [field('Race/Ethnicity', 'select', EPIC_RACE), DONT],
      [field('Race and Ethnicity', 'select', DISCORD_RACE), DONT],
      [field('Race', 'select', ASHBY_RACE), 'Decline to self-identify'],
      [field('Veteran Status', 'select', GH_VET), DONT],
      [field('Veteran Status', 'select', VEVRAA_CHOOSE_NOT), 'I prefer not to answer'],
      [field('Veteran Status', 'select', ASHBY_VET), 'I decline to self-identify for protected veteran status'],
      [field('Disability Status', 'select', GH_DISABILITY), DONT],
      [field('Disability Status', 'select', CC305), 'I do not want to answer'],
      [field('What is your ethnic group?', 'select', UK_ETHNICITY), 'Prefer not to say']
    ]
    const { answers, prompts } = await run(cases.map(([f], i) => ({ ...f, key: `k${i}` })))
    answers.forEach((a, i) => expect(a, cases[i][0].label).toMatchObject({ value: cases[i][1], source: 'settings', needsUser: false, rule: 'demographic' }))
    expect(prompts).toHaveLength(0)
  })

  it('ticks nothing and leaves optional text blank, and flags the required ones', async () => {
    const { answers } = await run([
      field('I consider myself a member of the LGBTQ+ community', 'checkbox', [], false),
      field('Pronouns', 'text', [], false),
      field('Pronouns', 'text', [], true),
      field('Gender', 'select', ['Man', 'Woman'], false),
      field('Gender', 'select', ['Man', 'Woman'], true)
    ].map((f, i) => ({ ...f, key: `k${i}` })))
    expect(answers[0]).toMatchObject({ value: 'false', needsUser: false })
    expect(answers[1]).toMatchObject({ value: '', needsUser: false })
    expect(answers[2]).toMatchObject({ value: '', needsUser: true })
    expect(answers[3]).toMatchObject({ value: '', needsUser: false })
    expect(answers[4]).toMatchObject({ value: '', needsUser: true })
    expect(answers[4].note).toMatch(/no option to decline/)
  })

  it('treats a self-describe setting with blank text as decline', async () => {
    const a = await one(field('Gender', 'select', ROBLOX_GENDER), eeo({ gender: 'self_describe', genderText: '  ' }))
    expect(a).toMatchObject({ value: DONT, source: 'settings' })
  })

  it('leaves pronouns blank on an optional text field with the empty default', async () => {
    expect(await one(field('Pronouns', 'text', [], false))).toMatchObject({ value: '', needsUser: false })
  })

  it('never calls the model for any family, required or optional', async () => {
    const labels: Array<[string, FieldType]> = [
      ['Gender', 'select'],
      ['Gender Pronouns', 'text'],
      ['Transgender Status', 'select'],
      ['Sexual Orientation', 'select'],
      ['I consider myself a member of the LGBTQ+ community', 'select'],
      ['Race/Ethnicity', 'multiselect'],
      ['Are you Hispanic/Latino?', 'radio'],
      ['Veteran Status', 'select'],
      ['Are you a military spouse?', 'select'],
      ['Disability Status', 'select'],
      ['Age band', 'select'],
      ['Date of birth', 'date'],
      ['Age', 'number'],
      ['What is your religion or belief?', 'select'],
      ['What is your marital status?', 'select'],
      ['Are you pregnant or on maternity leave?', 'select'],
      ['Do you have caring responsibilities?', 'select'],
      ['Did you receive free school meals?', 'select'],
      ['What type of school did you attend?', 'select'],
      ['Did either of your parents attend university?', 'select'],
      ['Do you consider yourself neurodivergent?', 'select'],
      ['How do you identify?', 'text']
    ]
    for (const required of [true, false]) {
      const fields = labels.map(([label, type], i) => ({ ...field(label, type, type === 'select' || type === 'multiselect' || type === 'radio' ? ['Yes', 'No'] : [], required), key: `k${i}` }))
      const { answers, prompts } = await run(fields)
      expect(prompts).toHaveLength(0)
      answers.forEach((a) => {
        expect(a.rule).toBe('demographic')
        expect(a.source).toBe('settings')
        expect(a.value === '' || a.value === 'false').toBe(true)
        expect(a.needsUser).toBe(required)
      })
    }
  })
})

describe('no form_map call contains a demographic field', () => {
  it('keeps every self-identification label out of the prompt while other fields still reach the model', async () => {
    const demographic = [
      field('Gender', 'select', GH_GENDER),
      field('Gender Identity (optional)', 'select', ROBLOX_GENDER, false),
      field('What are your personal pronouns?', 'select', ['He/Him', 'She/Her', 'They/Them', DONT]),
      field('Sexual Orientation', 'select', ['Gay/Lesbian', 'Heterosexual', DONT]),
      field('Transgender Status', 'select', GH_HISPANIC),
      field('Please identify your race/ethnicity', 'select', EPIC_RACE),
      field('Are you Hispanic/Latinx?', 'select', GH_HISPANIC),
      field('Are you a protected veteran?', 'select', GH_VET),
      field('Do you have a disability?', 'select', GH_DISABILITY),
      field('Age band', 'select', ['18-24', '25-34', 'Prefer not to say']),
      field('Date of birth', 'date'),
      field('What is your religion or belief?', 'text', [], false),
      field('How do you identify?', 'text'),
      field('Race', 'text', [], false),
      field('Pronouns', 'text', [], false)
    ]
    const ordinary = field('Which game engine do you use most?', 'text')
    const lookalike = field('How do you design for players with disabilities?', 'text')
    const { prompts, answers } = await run([...demographic, ordinary, lookalike])
    expect(prompts.filter((p) => p.startsWith('form_map')).length).toBeGreaterThan(0)
    const sent = prompts.join('\n')
    expect(sent).toContain('Which game engine do you use most?')
    for (const f of demographic) expect(sent, f.label).not.toContain(f.label)
    for (const f of demographic) expect(answers.find((a) => a.fieldKey === f.key)?.rule, f.label).toBe('demographic')
  })

  it('makes zero model calls when Regenerate runs on Gender', async () => {
    const f = field('Gender', 'select', GH_GENDER)
    const { answers, prompts } = await run([f], DEFAULT_SETTINGS, { regenerate: true })
    expect(prompts).toHaveLength(0)
    expect(answers[0]).toMatchObject({ value: DONT, rule: 'demographic' })
    const text = await run([field('Pronouns', 'text', [], false)], eeo({ pronouns: 'she' }), { regenerate: true })
    expect(text.prompts).toHaveLength(0)
    expect(text.answers[0].value).toBe('she/her')
  })
})

describe('owner settings', () => {
  it('uses a setting that matches an option', async () => {
    expect(await one(field('Gender', 'select', GH_GENDER), eeo({ gender: 'man' }))).toMatchObject({ value: 'Male', source: 'settings', confidence: 0.9 })
    expect(await one(field('Disability Status', 'select', CC305), eeo({ disability: 'no' }))).toMatchObject({ value: 'No, I do not have a disability' })
    expect(await one(field('Race/Ethnicity', 'select', EPIC_RACE), eeo({ hispanicLatino: 'yes' }))).toMatchObject({ value: 'Hispanic or Latino' })
    expect(await one(field('Race', 'multiselect', DISCORD_RACE, false), eeo({ race: ['white'] }))).toMatchObject({ value: JSON.stringify(['White or European']) })
  })

  it('answers a Hispanic yes/no question from the Hispanic setting, not from the race', async () => {
    const f = field('Are you Hispanic/Latino?', 'select', ['Yes', 'No', 'Decline To Self Identify'])
    expect(await one(f, eeo({ hispanicLatino: 'yes' }))).toMatchObject({ value: 'Yes' })
    expect(await one(f, eeo({ hispanicLatino: 'no' }))).toMatchObject({ value: 'No' })
    expect(await one(f, eeo({ race: ['white'] }))).toMatchObject({ value: 'Decline To Self Identify' })
  })

  it('declines, with a note, when the setting fits none of the options', async () => {
    const a = await one(field('Gender', 'select', GH_GENDER), eeo({ gender: 'non_binary' }))
    expect(a).toMatchObject({ value: DONT, needsUser: false })
    expect(a.note).toMatch(/matched none/)
  })

  it('reads pronouns before gender', () => {
    expect(demographicFamily(field('What are your gender pronouns?', 'text'))).toBe('pronouns')
    const mapped = demographicAnswer(field('Gender Pronouns', 'text', [], false), eeo({ pronouns: 'they', gender: 'man' }), null)
    expect(mapped.value).toBe('they/them')
  })

  it('never reads the settings for a family that has no setting', async () => {
    const a = await one(field('Sexual Orientation', 'select', ['Heterosexual', DONT]), eeo({ gender: 'man', race: ['white'], lgbtq: 'yes' }))
    expect(a.value).toBe(DONT)
  })
})

describe('exact saved answers', () => {
  const saved: SavedAnswer = { id: 's1', answer: 'Man', kind: 'fact' }

  it('fills a required question with no decline option from the saved answer', async () => {
    const used: string[] = []
    const a = await one(field('Gender', 'select', ['Man', 'Woman']), DEFAULT_SETTINGS, { saved, used })
    expect(a).toMatchObject({ value: 'Man', source: 'answer_bank', needsUser: false, rule: 'demographic' })
    expect(used).toEqual(['s1'])
  })

  it('prefers the decline option to a saved answer', async () => {
    const used: string[] = []
    const a = await one(field('Gender', 'select', GH_GENDER), DEFAULT_SETTINGS, { saved, used })
    expect(a).toMatchObject({ value: DONT, source: 'settings' })
    expect(used).toEqual([])
  })

  it('ignores a saved answer that is not an option, and a saved template', async () => {
    expect(await one(field('Gender', 'select', ['Man', 'Woman']), DEFAULT_SETTINGS, { saved: { id: 's', answer: 'Dragon', kind: 'fact' } })).toMatchObject({ value: '', needsUser: true })
    expect(await one(field('Gender', 'select', ['Man', 'Woman']), DEFAULT_SETTINGS, { saved: { id: 's', answer: 'Man', kind: 'template' } })).toMatchObject({ value: '', needsUser: true })
  })

  it('never returns null', () => {
    expect(demographicAnswer(field('Gender', 'text'), DEFAULT_SETTINGS, null)).toMatchObject({ needsUser: true })
    expect(demographicAnswer(field('Gender', 'text', [], false), DEFAULT_SETTINGS, null)).toMatchObject({ needsUser: false, value: '' })
  })
})

describe('UK and EU families', () => {
  const SPOTIFY_ETHNICITY = [
    'Any other ethnic group',
    'Arab',
    'Asian/Asian British: Any other Asian background',
    'Asian/Asian British: Bangladeshi ',
    'Asian/Asian British: Chinese ',
    'Asian/Asian British: Indian',
    'Asian/Asian British: Pakistani ',
    'Black/Black British: African',
    'Black/Black British: Caribbean',
    'Mixed: White and Asian',
    'Prefer not to disclose',
    'White: English/Welsh/Scottish/Northern Irish/British',
    'White: Irish'
  ]
  const YNP = ['Yes', 'No', 'Prefer not to say']
  const OCCUPATIONS = ['Modern professional occupations (e.g. teacher, nurse)', 'Retired', 'I prefer not to say']

  const longPositives: Array<[string, string]> = [
    ['What was the occupation of your main household earner when you were aged about 14?', 'socioeconomic'],
    ['Were you eligible for free school meals at any point during your school years?', 'socioeconomic'],
    ['What type of school did you attend for most of your time between the ages of 11 and 16?', 'school_type'],
    ['Did either of your parents attend university and complete a degree, such as a BA or BSc, by the time you were 18?', 'parent_degree'],
    ['Are you the first in your family to go to university?', 'parent_degree'],
    ['Do you have any caring responsibilities for a child, a disabled adult or an older person?', 'caring'],
    ['Please select your Asian background', 'race'],
    ['Which of the following best describes your ethnic group?', 'race'],
    ['What is your age band?', 'age']
  ]
  it.each(longPositives)('recognizes "%s"', (label, family) => {
    expect(demographicFamily(field(label, 'select', ['A', 'B']))).toBe(family)
  })

  it.each([
    ['White box testing background', 'text'],
    ['Describe your Asian market experience and background', 'text'],
    ['Describe your background in black box testing', 'textarea'],
    ['What religion is the main character in your game?', 'text']
  ] as Array<[string, FieldType]>)('does not recognize "%s" (%s)', (label, type) => {
    expect(demographicFamily(field(label, type, []))).toBeNull()
  })

  const settingsAllSet = eeo({
    ukEthnicity: 'asian_indian',
    religion: 'sikh',
    caring: 'yes',
    neurodivergent: 'no',
    birthYear: 1990,
    socioeconomic: { householdOccupation: 'retired', schoolType: 'state_non_selective', freeSchoolMeals: 'no', parentDegree: 'yes' }
  })

  it('picks the right Spotify option for an owner with every UK setting, with zero model calls', async () => {
    const { answers, prompts } = await run(
      [
        field('What best describes your ethnicity?', 'radio', SPOTIFY_ETHNICITY, false),
        field('What is your religion or belief?', 'select', ['No religion', 'Christian', 'Sikh', 'Prefer not to say'], false),
        field('Do you have caring responsibilities?', 'select', YNP, false),
        field('Do you consider yourself neurodivergent?', 'select', YNP, false),
        field('Were you eligible for free school meals at any point during your school years?', 'select', YNP, false),
        field('What was the occupation of your main household earner when you were aged about 14?', 'select', OCCUPATIONS, false),
        field('Did either of your parents attend university and complete a degree?', 'select', YNP, false),
        field('Marital status', 'select', ['Single', 'Married', 'Prefer not to say'], false),
        field('Are you pregnant or on maternity leave?', 'select', YNP, false)
      ].map((f, i) => ({ ...f, key: `k${i}` })),
      settingsAllSet
    )
    expect(answers.map((a) => a.value)).toEqual([
      'Asian/Asian British: Indian',
      'Sikh',
      'Yes',
      'No',
      'No',
      'Retired',
      'Yes',
      'Prefer not to say',
      'Prefer not to say'
    ])
    answers.forEach((a) => expect(a).toMatchObject({ source: 'settings', needsUser: false, rule: 'demographic' }))
    expect(prompts).toHaveLength(0)
  })

  it('declines every new family on default settings, with zero model calls', async () => {
    const { answers, prompts } = await run(
      [
        field('What best describes your ethnicity?', 'radio', SPOTIFY_ETHNICITY, true),
        field('What is your religion or belief?', 'select', ['No religion', 'Sikh', 'Prefer not to say'], true),
        field('Do you have caring responsibilities?', 'select', YNP, true),
        field('Do you consider yourself neurodivergent?', 'select', YNP, true),
        field('Were you eligible for free school meals?', 'select', YNP, true),
        field('What was the occupation of your main household earner when you were aged about 14?', 'select', OCCUPATIONS, true),
        field('What type of school did you attend?', 'select', ['State school', 'Independent school', 'Prefer not to say'], true),
        field('Did either of your parents attend university?', 'select', YNP, true),
        field('Marital status', 'select', ['Single', 'Married', 'Prefer not to say'], true),
        field('Are you pregnant or on maternity leave?', 'select', YNP, true),
        field('What is your age band?', 'select', ['16-24', '25-34', 'Prefer not to say'], true)
      ].map((f, i) => ({ ...f, key: `k${i}` }))
    )
    expect(answers.map((a) => a.value)).toEqual([
      'Prefer not to disclose',
      'Prefer not to say',
      'Prefer not to say',
      'Prefer not to say',
      'Prefer not to say',
      'I prefer not to say',
      'Prefer not to say',
      'Prefer not to say',
      'Prefer not to say',
      'Prefer not to say',
      'Prefer not to say'
    ])
    answers.forEach((a) => expect(a).toMatchObject({ source: 'settings', needsUser: false, rule: 'demographic' }))
    expect(prompts).toHaveLength(0)
  })

  it('flags a required UK question with no decline option instead of guessing', async () => {
    const a = await one(field('What is your ethnic group?', 'select', ['Asian or Asian British - Indian', 'White - Irish'], true))
    expect(a).toMatchObject({ needsUser: true, value: '' })
    const b = await one(field('What is your religion or belief?', 'select', ['No religion', 'Sikh'], true), eeo({ religion: 'muslim' }))
    expect(b).toMatchObject({ needsUser: true, value: '' })
  })

  it('does not use US race settings on a UK list or UK settings on a US list', async () => {
    const uk = await one(field('What is your ethnic group?', 'select', UK_ETHNICITY), eeo({ race: ['asian_south'], hispanicLatino: 'no' }))
    expect(uk.value).toBe('Prefer not to say')
    const us = await one(field('Race/Ethnicity', 'select', EPIC_RACE), eeo({ ukEthnicity: 'white_british' }))
    expect(us.value).toBe(DONT)
  })

  it('leaves marital status and pregnancy unanswered whatever is set', async () => {
    const marital = await one(field('Marital status', 'text', [], false), settingsAllSet)
    expect(marital).toMatchObject({ value: '', needsUser: false })
    const pregnancy = await one(field('Are you pregnant?', 'select', ['Yes', 'No'], true), settingsAllSet)
    expect(pregnancy).toMatchObject({ needsUser: true, value: '' })
  })

  it('does not let a saved answer replace a UK setting', async () => {
    const f = field('Do you have caring responsibilities?', 'select', YNP, false)
    const a = await one(f, eeo({ caring: 'no' }), { saved: { id: 's1', answer: 'Yes', kind: 'fact' } })
    expect(a.value).toBe('No')
  })
})
