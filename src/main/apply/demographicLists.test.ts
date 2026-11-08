import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField, Settings, YesNoDecline } from '@shared/types'
import type { LlmService } from '../llm/service'
import { answerFields } from './answers'
import { demographicAnswer } from './demographics'
import fixture from './__fixtures__/demographic-lists.json'

// Every setting value against the option lists of real forms (Greenhouse, Ashby, the OFCCP CC-305
// form). A recording model stub proves none of these questions reaches the AI.

interface Listed {
  source: string
  label: string
  type: 'select' | 'multiselect'
  options: string[]
}
const LISTS = fixture.lists as Listed[]

const list = (source: string, label: string): Listed => {
  const hit = LISTS.find((l) => l.source === source && l.label === label) ?? LISTS.find((l) => l.source === source && l.label.startsWith(label))
  if (!hit) throw new Error(`No fixture list ${source} / ${label}`)
  return hit
}

const field = (label: string, type: FieldType, options: string[] = [], required = false): FormField => ({
  key: label,
  label,
  type,
  required,
  options,
  placeholder: null,
  maxLength: null,
  fileHint: null
})
const fieldOf = (l: Listed): FormField => field(l.label, l.type, l.options)

const eeo = (patch: Partial<Settings['eeo']>): Settings => ({ ...DEFAULT_SETTINGS, eeo: { ...DEFAULT_SETTINGS.eeo, ...patch } })

const job = { id: 'j1', company: 'Acme', title: 'Engineer', location: null, description: '', fit: null, source: 'greenhouse' as const }

// Every prompt the stub sees, across the whole file.
const prompts: string[] = []
const llm = {
  json: (req: { task: string; prompt: string }) => {
    prompts.push(`${req.task}\n${req.prompt}`)
    return Promise.resolve({ value: { answers: [] }, costUsd: 0 })
  },
  text: () => {
    prompts.push('text')
    return Promise.reject(new Error('No text call expected'))
  }
} as unknown as LlmService

async function ask(f: FormField, patch: Partial<Settings['eeo']>) {
  const settings = eeo(patch)
  const res = await answerFields(
    { llm, settings, profile: EMPTY_PROFILE, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => undefined, resumePath: null },
    job,
    [f],
    null,
    {}
  )
  return res.answers[0]
}

const DECLINE_PICK = 'DECLINE'
const NO_MATCH = 'NO_MATCH'
type Expected = string | string[] | ((options: string[]) => string | string[])
type Case = [name: string, patch: Partial<Settings['eeo']>, expected: Expected | typeof DECLINE_PICK | typeof NO_MATCH]

/** The one option that matches a pattern. The test fails when none or several do. */
const opt =
  (re: RegExp) =>
  (options: string[]): string => {
    const hits = options.filter((o) => re.test(o))
    if (hits.length !== 1) throw new Error(`${re} matched ${hits.length} of ${JSON.stringify(options)}`)
    return hits[0]
  }

const DECLINE_WORDING = /decline|don['’]t wish|do not want to answer|prefer not/i
const declineOf = (l: Listed): string => {
  const hits = l.options.filter((o) => DECLINE_WORDING.test(o) && !/^i identify/i.test(o))
  if (hits.length !== 1) throw new Error(`No single decline option in ${l.label}`)
  return hits[0]
}

const covered = new Set<Listed>()

function runCases(l: Listed, cases: Case[]): void {
  covered.add(l)
  describe(`${l.source}: ${l.label}`, () => {
    it.each(cases)('%s', async (_name, patch, expected) => {
      const a = await ask(fieldOf(l), patch)
      const multi = l.type === 'multiselect'
      const values = multi ? (JSON.parse(a.value) as string[]) : [a.value]
      expect(a.needsUser).toBe(false)
      expect(a.source).toBe('settings')
      if (expected === DECLINE_PICK || expected === NO_MATCH) {
        expect(values).toEqual([declineOf(l)])
        if (expected === NO_MATCH) expect(a.note).toMatch(/matched none/)
        else expect(a.note).toBeNull()
        return
      }
      const want = typeof expected === 'function' ? expected(l.options) : expected
      expect(multi ? values : a.value).toEqual(want)
      expect(a.note).toBeNull()
    })
  })
}

// --- Gender -----------------------------------------------------------------

const maleFemale: Case[] = [
  ['man picks Male', { gender: 'man' }, 'Male'],
  ['woman picks Female', { gender: 'woman' }, 'Female'],
  ['non_binary has no option, so it declines with a note', { gender: 'non_binary' }, NO_MATCH],
  ['self_describe has no option, so it declines with a note', { gender: 'self_describe', genderText: 'Agender' }, NO_MATCH],
  ['decline picks the decline option', { gender: 'decline' }, DECLINE_PICK],
  ['the defaults decline', {}, DECLINE_PICK]
]
for (const [source, label] of [
  ['Ashby, Notion', 'Gender'],
  ['Greenhouse, Anthropic', 'Gender'],
  ['Greenhouse, Bungie', 'Gender'],
  ['Greenhouse, Databricks', 'Gender'],
  ['Greenhouse, Discord', 'Gender'],
  ['Greenhouse, Figma', 'Gender'],
  ['Greenhouse, GitLab', 'Gender']
] as const) {
  runCases(list(source, label), maleFemale)
}

runCases(list('Greenhouse, Discord', 'Gender Identity (optional)'), [
  ['man', { gender: 'man' }, 'Man'],
  ['woman', { gender: 'woman' }, 'Woman'],
  ['non_binary picks the non-binary option, not Genderqueer', { gender: 'non_binary' }, 'Non-binary or third gender'],
  ['self_describe has no option', { gender: 'self_describe', genderText: 'Agender' }, NO_MATCH],
  ['decline', { gender: 'decline' }, DECLINE_PICK]
])

runCases(list('Greenhouse, Epic Games', 'Gender Identity'), [
  ['man', { gender: 'man' }, 'Man'],
  ['woman', { gender: 'woman' }, 'Woman'],
  ['non_binary', { gender: 'non_binary' }, 'Non-Binary'],
  ['self_describe has no option', { gender: 'self_describe', genderText: 'Agender' }, NO_MATCH],
  ['decline', { gender: 'decline' }, DECLINE_PICK]
])

runCases(list('Greenhouse, Roblox', 'How would you describe your gender identity?'), [
  ['man', { gender: 'man' }, 'Man'],
  ['woman', { gender: 'woman' }, 'Woman'],
  ['non_binary', { gender: 'non_binary' }, 'Non-binary'],
  ['self_describe picks the self-describe option', { gender: 'self_describe', genderText: 'Agender' }, 'I prefer to self-describe'],
  ['self_describe with no text has nothing to say', { gender: 'self_describe', genderText: '' }, NO_MATCH],
  ['decline', { gender: 'decline' }, DECLINE_PICK]
])

runCases(list('Greenhouse, Bungie', 'Gender Identity'), [
  ['man picks Male, not Cisgender/Male', { gender: 'man' }, 'Male'],
  ['woman picks Female', { gender: 'woman' }, 'Female'],
  ['non_binary', { gender: 'non_binary' }, 'Non-binary/Gender Non-Conforming/Gender Variant'],
  ['self_describe with a text that is an option', { gender: 'self_describe', genderText: 'Agender' }, 'Agender'],
  ['self_describe with another text picks "Not Listed"', { gender: 'self_describe', genderText: 'Demigirl' }, 'Gender Identity Not Listed'],
  ['decline', { gender: 'decline' }, DECLINE_PICK]
])

// --- Transgender and pronouns -----------------------------------------------

runCases(list('Greenhouse, Epic Games', 'Transgender Status'), [
  ['yes', { transgender: 'yes' }, 'Yes'],
  ['no', { transgender: 'no' }, 'No'],
  ['decline', { transgender: 'decline' }, DECLINE_PICK]
])

runCases(list('Greenhouse, Bungie', 'What are your personal pronouns?'), [
  ['he', { pronouns: 'he' }, 'He/Him'],
  ['she', { pronouns: 'she' }, 'She/Her'],
  ['they', { pronouns: 'they' }, 'They/Them'],
  ['custom that is an option', { pronouns: 'custom', pronounsText: 'xe/xem' }, 'Xe/Xem'],
  ['custom that is not an option', { pronouns: 'custom', pronounsText: 'ey/em' }, 'Pronouns Not Listed'],
  ['name_only has no option', { pronouns: 'name_only' }, NO_MATCH],
  ['decline', { pronouns: 'decline' }, DECLINE_PICK]
])

// Figma's pronoun list has no decline option, so a pronoun setting that does not fit is left blank.
covered.add(list('Greenhouse, Figma', 'Pronouns'))
describe('Greenhouse, Figma: Pronouns', () => {
  const f = fieldOf(list('Greenhouse, Figma', 'Pronouns'))
  it.each([
    ['he', { pronouns: 'he' }, 'he/him/his'],
    ['she', { pronouns: 'she' }, 'she/her/hers'],
    ['they', { pronouns: 'they' }, 'they/them/theirs'],
    ['custom', { pronouns: 'custom', pronounsText: 'ey/em' }, 'self-describe'],
    ['name_only', { pronouns: 'name_only' }, ''],
    ['decline', { pronouns: 'decline' }, '']
  ] as Array<[string, Partial<Settings['eeo']>, string]>)('%s', async (_n, patch, expected) => {
    expect(await ask(f, patch)).toMatchObject({ value: expected, needsUser: false })
  })
})

describe('transgender wording', () => {
  const options = ['Yes', 'No', "I don't wish to answer"]
  it('inverts "same as the sex assigned at birth"', async () => {
    const f = field('Is your gender identity the same as the sex you were assigned at birth?', 'select', options)
    expect((await ask(f, { transgender: 'yes' })).value).toBe('No')
    expect((await ask(f, { transgender: 'no' })).value).toBe('Yes')
    expect((await ask(f, { transgender: 'decline' })).value).toBe("I don't wish to answer")
  })
  it('does not invert "Do you identify as transgender?"', async () => {
    const f = field('Do you identify as transgender?', 'select', options)
    expect((await ask(f, { transgender: 'yes' })).value).toBe('Yes')
    expect((await ask(f, { transgender: 'no' })).value).toBe('No')
  })
})

// --- Sexual orientation and LGBTQ+ ------------------------------------------

runCases(list('Greenhouse, Bungie', 'Sexual Orientation'), [
  ['heterosexual', { sexualOrientation: ['heterosexual'] }, 'Heterosexual'],
  ['gay picks Gay/Lesbian', { sexualOrientation: ['gay'] }, 'Gay/Lesbian'],
  ['lesbian picks Gay/Lesbian', { sexualOrientation: ['lesbian'] }, 'Gay/Lesbian'],
  ['asexual', { sexualOrientation: ['asexual'] }, 'Asexual'],
  ['queer', { sexualOrientation: ['queer'] }, 'Queer'],
  ['bisexual or pansexual cannot pick between two options', { sexualOrientation: ['bisexual_pansexual'] }, NO_MATCH],
  ['self_describe picks "Not Listed"', { sexualOrientation: ['self_describe'], sexualOrientationText: 'Demisexual' }, 'Sexual Orientation Not Listed'],
  ['two picks on a single-choice list decline with a note', { sexualOrientation: ['gay', 'queer'] }, NO_MATCH],
  ['nothing picked declines', { sexualOrientation: [] }, DECLINE_PICK]
])

describe('sexual orientation on a multi-pick list', () => {
  const options = ['Asexual', 'Bisexual or pansexual', 'Gay', 'Heterosexual', 'Lesbian', 'Queer', 'I prefer to self-describe', 'Prefer not to say']
  const f = field('Sexual orientation (select all that apply)', 'checkboxes', options)
  it('picks every selected orientation', async () => {
    const a = await ask(f, { sexualOrientation: ['bisexual_pansexual', 'gay', 'queer'] })
    expect(JSON.parse(a.value)).toEqual(['Bisexual or pansexual', 'Gay', 'Queer'])
  })
  it('adds the self-describe option', async () => {
    const a = await ask(f, { sexualOrientation: ['asexual', 'self_describe'], sexualOrientationText: 'Demisexual' })
    expect(JSON.parse(a.value)).toEqual(['Asexual', 'I prefer to self-describe'])
  })
  it('writes the self-described text into a text box', async () => {
    const t = field('Sexual orientation', 'text')
    expect((await ask(t, { sexualOrientation: ['gay', 'self_describe'], sexualOrientationText: 'Demisexual' })).value).toBe('Gay, Demisexual')
  })
})

runCases(list('Greenhouse, Discord', 'I consider myself a member of the LGBTQ+ community'), [
  ['yes', { lgbtq: 'yes' }, 'Yes'],
  ['no', { lgbtq: 'no' }, 'No'],
  ['decline', { lgbtq: 'decline' }, DECLINE_PICK]
])

describe('LGBTQ+ checkbox', () => {
  const f = field('I consider myself a member of the LGBTQ+ community', 'checkbox')
  it('ticks the box for yes and leaves it clear otherwise', async () => {
    expect((await ask(f, { lgbtq: 'yes' })).value).toBe('true')
    expect((await ask(f, { lgbtq: 'no' })).value).toBe('false')
    expect((await ask(f, { lgbtq: 'decline' })).value).toBe('false')
  })
})

// --- Race and Hispanic or Latino --------------------------------------------

runCases(list('Greenhouse, Bungie', 'Are you Hispanic/Latinx?'), [
  ['yes', { hispanicLatino: 'yes' }, 'Yes'],
  ['no', { hispanicLatino: 'no' }, 'No'],
  ['decline', { hispanicLatino: 'decline' }, DECLINE_PICK],
  ['the race setting does not answer it', { race: ['white'] }, DECLINE_PICK]
])

// Lists where every option says "(Not Hispanic or Latino)" next to a "Hispanic or Latino" option.
for (const l of [list('Greenhouse, Epic Games', 'Race/Ethnicity'), list('Ashby, Notion', 'Race')]) {
  runCases(l, [
    ['white', { race: ['white'] }, opt(/^White \(Not/)],
    ['black', { race: ['black'] }, opt(/^Black/)],
    ['asian', { race: ['asian'] }, opt(/^Asian/)],
    ['east asian falls back to Asian', { race: ['asian_east'] }, opt(/^Asian/)],
    ['two Asian groups are still one race', { race: ['asian_east', 'asian_south'] }, opt(/^Asian/)],
    ['american_indian', { race: ['american_indian'] }, opt(/^American Indian/)],
    ['pacific_islander', { race: ['pacific_islander'] }, opt(/^Native Hawaiian/)],
    ['mena has no option', { race: ['mena'] }, NO_MATCH],
    ['two races pick Two or More Races', { race: ['white', 'asian'] }, opt(/^Two or More/)],
    ['Hispanic or Latino outranks one race', { race: ['white'], hispanicLatino: 'yes' }, 'Hispanic or Latino'],
    ['Hispanic or Latino outranks two races', { race: ['white', 'black'], hispanicLatino: 'yes' }, 'Hispanic or Latino'],
    ['Hispanic or Latino alone', { hispanicLatino: 'yes' }, 'Hispanic or Latino'],
    ['not Hispanic with a race', { race: ['white'], hispanicLatino: 'no' }, opt(/^White \(Not/)],
    ['no picks decline', { race: [] }, DECLINE_PICK],
    ['no race with Hispanic set to no declines', { hispanicLatino: 'no' }, DECLINE_PICK]
  ])
}

// Lists with plain race names and a Hispanic or Latino option.
for (const [source, label] of [
  ['Greenhouse, Anthropic', 'Race'],
  ['Greenhouse, Databricks', 'Race'],
  ['Greenhouse, Figma', 'Race'],
  ['Greenhouse, GitLab', 'Race'],
  ['Greenhouse, Discord', 'Race and Ethnicity']
] as const) {
  runCases(list(source, label), [
    ['white', { race: ['white'] }, 'White'],
    ['black', { race: ['black'] }, 'Black or African American'],
    ['asian', { race: ['asian'] }, 'Asian'],
    ['south asian falls back to Asian', { race: ['asian_south'] }, 'Asian'],
    ['american_indian', { race: ['american_indian'] }, opt(/^American Indian/)],
    ['pacific_islander', { race: ['pacific_islander'] }, 'Native Hawaiian or Other Pacific Islander'],
    ['mena has no option', { race: ['mena'] }, NO_MATCH],
    ['two races pick Two or More Races', { race: ['black', 'white'] }, 'Two or More Races'],
    ['Hispanic or Latino outranks the race', { race: ['asian'], hispanicLatino: 'yes' }, 'Hispanic or Latino'],
    ['decline', { race: ['white'], hispanicLatino: 'decline' }, 'White'],
    ['nothing set', {}, DECLINE_PICK]
  ])
}

// A race list with no Hispanic option, next to its own Hispanic question.
runCases(list('Greenhouse, Bungie', 'Please identify your race/ethnicity'), [
  ['white', { race: ['white'] }, 'White'],
  ['two races', { race: ['white', 'black'] }, 'Two or More Races'],
  ['Hispanic yes does not change the race pick', { race: ['white'], hispanicLatino: 'yes' }, 'White'],
  ['Hispanic yes alone has no option here', { hispanicLatino: 'yes' }, NO_MATCH],
  ['american_indian', { race: ['american_indian'] }, 'American Indian or Alaskan Native'],
  ['decline', { race: [] }, DECLINE_PICK]
])

// Multi-pick lists.
for (const [source, label] of [
  ['Greenhouse, Discord', 'Race or Ethnicity (optional)'],
  ['Greenhouse, Roblox', 'How would you describe your racial/ethnic background? (mark all that apply)']
] as const) {
  runCases(list(source, label), [
    ['white', { race: ['white'] }, ['White or European']],
    ['several races are all picked', { race: ['asian_east', 'white'] }, ['East Asian', 'White or European']],
    ['south and southeast Asian stay separate', { race: ['asian_south', 'asian_southeast'] }, ['South Asian', 'Southeast Asian']],
    ['black', { race: ['black'] }, ['Black or of African descent']],
    ['american_indian', { race: ['american_indian'] }, (o) => [opt(/^Indigenous/)(o)]],
    ['mena', { race: ['mena'] }, (o) => [opt(/^Middle Eastern/)(o)]],
    ['pacific_islander', { race: ['pacific_islander'] }, (o) => [opt(/Pacific Islander/)(o)]],
    ['Hispanic or Latino is picked next to the races', { race: ['white'], hispanicLatino: 'yes' }, (o) => [opt(/^Hispanic/)(o), 'White or European']],
    ['plain asian is ambiguous between three Asian options', { race: ['asian'] }, NO_MATCH],
    ['nothing set', {}, DECLINE_PICK]
  ])
}

// --- Veteran status ---------------------------------------------------------

for (const [source, label] of [
  ['Greenhouse, Anthropic', 'VeteranStatus'],
  ['Greenhouse, Databricks', 'VeteranStatus'],
  ['Greenhouse, Figma', 'VeteranStatus'],
  ['Greenhouse, GitLab', 'VeteranStatus'],
  ['Greenhouse, Discord', 'Veteran Status'],
  ['Ashby, Notion', 'Veteran Status']
] as const) {
  runCases(list(source, label), [
    ['not_protected', { veteran: 'not_protected' }, 'I am not a protected veteran'],
    ['protected', { veteran: 'protected' }, opt(/^I identify as one or more of the classifications/)],
    ['protected with categories still picks the one option', { veteran: 'protected', veteranCategories: ['disabled'] }, opt(/^I identify as one or more/)],
    ['military service does not change a not_protected pick', { veteran: 'not_protected', militaryService: 'yes' }, 'I am not a protected veteran'],
    ['decline', { veteran: 'decline' }, DECLINE_PICK]
  ])
}

runCases(list('Greenhouse, Bungie', 'Are you a protected veteran?'), [
  ['protected', { veteran: 'protected' }, opt(/^I identify as one or more of the above categories/)],
  ['not_protected', { veteran: 'not_protected' }, opt(/^I do not fall into/)],
  ['not_protected who served', { veteran: 'not_protected', militaryService: 'yes' }, opt(/^I previously served/)],
  ['not_protected who never served', { veteran: 'not_protected', militaryService: 'no' }, opt(/^I do not fall into/)],
  ['decline', { veteran: 'decline' }, DECLINE_PICK]
])

// Yes or No "Veteran Status" lists follow military service, or protected status.
runCases(list('Greenhouse, Epic Games', 'Veteran Status'), [
  ['served', { militaryService: 'yes' }, 'Yes'],
  ['did not serve', { militaryService: 'no' }, 'No'],
  ['protected is a veteran', { veteran: 'protected' }, 'Yes'],
  ['not protected alone does not say whether they served', { veteran: 'not_protected' }, NO_MATCH],
  ['not protected and never served', { veteran: 'not_protected', militaryService: 'no' }, 'No'],
  ['decline', {}, DECLINE_PICK]
])

runCases(list('Greenhouse, Roblox', 'Are you a veteran, active member or reservist of the United States Armed Forces?'), [
  ['served', { militaryService: 'yes' }, opt(/^Yes/)],
  ['did not serve', { militaryService: 'no' }, opt(/^No/)],
  ['protected', { veteran: 'protected' }, opt(/^Yes/)],
  ['decline', { militaryService: 'decline' }, DECLINE_PICK]
])

describe('veteran lists that name the four categories', () => {
  const options = [
    'Disabled veteran',
    'Recently separated veteran',
    'Active duty wartime or campaign badge veteran',
    'Armed Forces service medal veteran',
    'None of the above',
    'I prefer not to answer'
  ]
  const f = field('Protected veteran categories (select all that apply)', 'checkboxes', options)
  it('picks the categories of a protected veteran', async () => {
    const a = await ask(f, { veteran: 'protected', veteranCategories: ['disabled', 'service_medal'] })
    expect(JSON.parse(a.value)).toEqual(['Disabled veteran', 'Armed Forces service medal veteran'])
  })
  it.each([
    ['recently_separated', 'Recently separated veteran'],
    ['active_wartime', 'Active duty wartime or campaign badge veteran']
  ] as const)('picks %s', async (id, option) => {
    expect(JSON.parse((await ask(f, { veteran: 'protected', veteranCategories: [id] })).value)).toEqual([option])
  })
  it('picks "None of the above" for a veteran who is not protected', async () => {
    expect(JSON.parse((await ask(f, { veteran: 'not_protected' })).value)).toEqual(['None of the above'])
  })
  it('declines when a protected veteran named no category', async () => {
    const a = await ask(f, { veteran: 'protected', veteranCategories: [] })
    expect(JSON.parse(a.value)).toEqual(['I prefer not to answer'])
    expect(a.note).toMatch(/matched none/)
  })
  it('declines on the defaults', async () => {
    expect(JSON.parse((await ask(f, {})).value)).toEqual(['I prefer not to answer'])
  })
  it('ticks one category checkbox only for a protected veteran with that category', async () => {
    const box = field('Disabled veteran', 'checkbox')
    expect((await ask(box, { veteran: 'protected', veteranCategories: ['disabled'] })).value).toBe('true')
    expect((await ask(box, { veteran: 'protected', veteranCategories: ['service_medal'] })).value).toBe('false')
    expect((await ask(box, { veteran: 'not_protected' })).value).toBe('false')
  })
})

describe('military service and military spouse in Yes or No form', () => {
  const yesNo = ['Yes', 'No', 'Prefer not to say']
  it('answers "Have you served in the military?" from militaryService', async () => {
    const f = field('Have you served in the military?', 'select', yesNo)
    expect((await ask(f, { militaryService: 'yes' })).value).toBe('Yes')
    expect((await ask(f, { militaryService: 'no' })).value).toBe('No')
    expect((await ask(f, { militaryService: 'decline' })).value).toBe('Prefer not to say')
  })
  it('answers "Are you a military spouse?" from militarySpouse', async () => {
    const f = field('Are you a military spouse?', 'select', yesNo)
    expect((await ask(f, { militarySpouse: 'yes' })).value).toBe('Yes')
    expect((await ask(f, { militarySpouse: 'no' })).value).toBe('No')
    expect((await ask(f, { militarySpouse: 'decline' })).value).toBe('Prefer not to say')
    expect((await ask(f, { militaryService: 'yes' })).value).toBe('Prefer not to say')
  })
  it('answers "Are you a protected veteran?" from the veteran setting, not military service', async () => {
    const f = field('Are you a protected veteran?', 'select', yesNo)
    expect((await ask(f, { veteran: 'protected' })).value).toBe('Yes')
    expect((await ask(f, { veteran: 'not_protected', militaryService: 'yes' })).value).toBe('No')
    expect((await ask(f, { veteran: 'decline', militaryService: 'yes' })).value).toBe('Prefer not to say')
  })
})

// --- Disability ---------------------------------------------------------------

const disabilityCases: Case[] = [
  ['yes', { disability: 'yes' }, opt(/^Yes/)],
  ['no', { disability: 'no' }, opt(/^No/)],
  ['decline', { disability: 'decline' }, DECLINE_PICK]
]
runCases(list('OFCCP CC-305 (2020 form)', 'Disability Status'), disabilityCases)
runCases(list('OFCCP CC-305 (2023 form)', 'Disability Status'), disabilityCases)
runCases(list('Greenhouse, Discord', 'Disability Status'), disabilityCases)
runCases(list('Greenhouse, Bungie', 'Do you have a disability?'), disabilityCases)
runCases(list('Greenhouse, Roblox', 'Do you have a disability or chronic condition'), [
  ['yes', { disability: 'yes' }, 'Yes'],
  ['no', { disability: 'no' }, 'No'],
  ['decline', { disability: 'decline' }, DECLINE_PICK]
])

describe('disability wording without Yes or No', () => {
  const f = field('Disability status', 'radio', ['I have a disability', 'I do not have a disability', 'I do not want to answer'])
  it('reads the sentences', async () => {
    expect((await ask(f, { disability: 'yes' })).value).toBe('I have a disability')
    expect((await ask(f, { disability: 'no' })).value).toBe('I do not have a disability')
  })
})

// --- Age (owner decision 9) ----------------------------------------------------

describe('age', () => {
  const ageOptions = ['Under 25', '25-34', '35-44', '45-54', '55-64', '65 or older', 'Prefer not to say']
  const yesNo = ['Yes', 'No', 'Prefer not to say']
  const answer = (f: FormField, birthYear: number | null) => demographicAnswer(f, eeo({ birthYear }), null, 2026)

  it('declines every age question without a birth year', () => {
    expect(answer(field('Age band', 'select', ageOptions), null).value).toBe('Prefer not to say')
    expect(answer(field('Are you 40 or older?', 'select', yesNo), null).value).toBe('Prefer not to say')
    expect(answer(field('Year of birth', 'number'), null).value).toBe('')
    expect(answer(field('Date of birth', 'date'), null).value).toBe('')
  })

  it('picks the age band', () => {
    const f = field('Age band', 'select', ageOptions)
    expect(answer(f, 1980).value).toBe('45-54')
    expect(answer(f, 1992).value).toBe('25-34')
    expect(answer(f, 2003).value).toBe('Under 25')
    expect(answer(f, 1950).value).toBe('65 or older')
  })

  it('declines when the birth year sits on a band edge', () => {
    const a = answer(field('Age band', 'select', ageOptions), 1981)
    expect(a).toMatchObject({ value: 'Prefer not to say' })
    expect(a.note).toMatch(/matched none/)
  })

  it('answers "40 or older" questions', () => {
    const f = field('Are you 40 or older?', 'select', yesNo)
    expect(answer(f, 1980).value).toBe('Yes')
    expect(answer(f, 2000).value).toBe('No')
    expect(answer(f, 1985).value).toBe('Yes')
    expect(answer(f, 1986).value).toBe('Prefer not to say')
    expect(answer(field('Are you over 40 years of age?', 'select', yesNo), 1980).value).toBe('Yes')
    expect(answer(field('Are you 40 or older?', 'text'), 2000).value).toBe('No')
  })

  it('writes the birth year into a year-of-birth box, and leaves exact dates and ages alone', () => {
    expect(answer(field('Year of birth', 'number'), 1990).value).toBe('1990')
    expect(answer(field('Date of birth', 'date'), 1990).value).toBe('')
    expect(answer(field('Age', 'number'), 1990).value).toBe('')
  })
})

// --- Text boxes -----------------------------------------------------------------

describe('text boxes', () => {
  const text = (label: string, patch: Partial<Settings['eeo']>) => demographicAnswer(field(label, 'text'), eeo(patch), null).value
  it('writes the setting as words', () => {
    expect(text('Gender', { gender: 'man' })).toBe('Male')
    expect(text('Gender', { gender: 'woman' })).toBe('Female')
    expect(text('Gender', { gender: 'non_binary' })).toBe('Non-binary')
    expect(text('Gender', { gender: 'self_describe', genderText: 'Agender' })).toBe('Agender')
    expect(text('Gender', { gender: 'self_describe', genderText: '  ' })).toBe('')
    expect(text('Gender', { gender: 'decline', genderText: 'Agender' })).toBe('')
    expect(text('Pronouns', { pronouns: 'she' })).toBe('she/her')
    expect(text('Pronouns', { pronouns: 'custom', pronounsText: 'xe/xem' })).toBe('xe/xem')
    expect(text('Pronouns', { pronouns: 'name_only' })).toBe('')
    expect(text('Race', { race: ['white', 'asian'] })).toBe('White, Asian')
    expect(text('Race', { race: ['white'], hispanicLatino: 'yes' })).toBe('Hispanic or Latino, White')
    expect(text('Veteran status', { veteran: 'not_protected' })).toBe('I am not a protected veteran')
    expect(text('Disability status', { disability: 'no' })).toBe('No')
  })
})

describe('the setting wins over a saved answer, and unmatched settings fall back', () => {
  it('uses the decline option before a saved answer when no option fits', () => {
    const f = field('Gender', 'select', ['Male', 'Female', "I don't wish to answer"], true)
    const a = demographicAnswer(f, eeo({ gender: 'non_binary' }), { answer: 'Male', kind: 'fact' })
    expect(a).toMatchObject({ value: "I don't wish to answer", needsUser: false })
    expect(a.note).toMatch(/matched none/)
  })
  it('flags a required list with no decline option when nothing fits', () => {
    const f = field('Gender', 'select', ['Male', 'Female'], true)
    expect(demographicAnswer(f, eeo({ gender: 'non_binary' }), null)).toMatchObject({ needsUser: true, value: '' })
  })
})

// --- UK and EU families -------------------------------------------------------------

const SPOTIFY = 'Lever, Spotify (UK survey)'
const ONS = 'ONS 2021 wording (reference, not seen on a live form)'
const SMC = 'Social Mobility Commission wording (reference, not seen on a live form)'
const UKREF = 'UK reference wording (not seen on a live form)'

type UkId = Settings['eeo']['ukEthnicity']
const uk = (ukEthnicity: UkId): Partial<Settings['eeo']> => ({ ukEthnicity })

/** The option whose text, ignoring stray spaces, is exactly this. */
const exact =
  (text: string) =>
  (options: string[]): string => {
    const hit = options.find((o) => o.trim() === text)
    if (!hit) throw new Error(`${text} is not in ${JSON.stringify(options)}`)
    return hit
  }

// Group name on a "group first" list, and each subgroup's text.
const ONS_GROUPS: Record<string, { name: string; subs: Partial<Record<UkId, string>> }> = {
  asian: {
    name: 'Asian, Asian British or Asian Welsh',
    subs: { asian_bangladeshi: 'Bangladeshi', asian_chinese: 'Chinese', asian_indian: 'Indian', asian_pakistani: 'Pakistani', asian_other: 'Any other Asian background' }
  },
  black: {
    name: 'Black, Black British, Black Welsh, Caribbean or African',
    subs: { black_african: 'African', black_caribbean: 'Caribbean', black_other: 'Any other Black, Black British or Caribbean background' }
  },
  mixed: {
    name: 'Mixed or Multiple ethnic groups',
    subs: {
      mixed_white_asian: 'White and Asian',
      mixed_white_black_african: 'White and Black African',
      mixed_white_black_caribbean: 'White and Black Caribbean',
      mixed_other: 'Any other Mixed or Multiple ethnic background'
    }
  },
  white: {
    name: 'White',
    subs: {
      white_british: 'English, Welsh, Scottish, Northern Irish or British',
      white_irish: 'Irish',
      white_gypsy_traveller: 'Gypsy or Irish Traveller',
      white_roma: 'Roma',
      white_other: 'Any other White background'
    }
  },
  other: { name: 'Other ethnic group', subs: { other_arab: 'Arab', other_any: 'Any other ethnic group' } }
}
const ALL_SUBS = Object.entries(ONS_GROUPS).flatMap(([group, g]) => Object.entries(g.subs).map(([id, text]) => ({ id: id as UkId, group, groupName: g.name, text: text as string })))

describe('UK ethnic group: Spotify UK Lever list', () => {
  const l = list(SPOTIFY, 'What best describes your ethnicity?')
  runCases(l, [
    ['asian_bangladeshi', uk('asian_bangladeshi'), exact('Asian/Asian British: Bangladeshi')],
    ['asian_chinese', uk('asian_chinese'), exact('Asian/Asian British: Chinese')],
    ['asian_indian', uk('asian_indian'), exact('Asian/Asian British: Indian')],
    ['asian_pakistani', uk('asian_pakistani'), exact('Asian/Asian British: Pakistani')],
    ['asian_other', uk('asian_other'), exact('Asian/Asian British: Any other Asian background')],
    ['black_african', uk('black_african'), exact('Black/Black British: African')],
    ['black_caribbean', uk('black_caribbean'), exact('Black/Black British: Caribbean')],
    ['black_other', uk('black_other'), exact('Black/Black British: Any other Black/ African / Caribbean background')],
    ['mixed_white_asian', uk('mixed_white_asian'), exact('Mixed: White and Asian')],
    ['mixed_white_black_african', uk('mixed_white_black_african'), exact('Mixed: White and Black African')],
    ['mixed_white_black_caribbean', uk('mixed_white_black_caribbean'), exact('Mixed: White and Black Caribbean')],
    ['mixed_other', uk('mixed_other'), exact('Mixed: Any other mixed background')],
    ['white_british', uk('white_british'), exact('White: English/Welsh/Scottish/Northern Irish/British')],
    ['white_irish', uk('white_irish'), exact('White: Irish')],
    ['white_gypsy_traveller', uk('white_gypsy_traveller'), (o: string[]) => o.find((x) => x.startsWith('White: Irish Traveller')) as string],
    ['white_other', uk('white_other'), exact('White: Any other White background')],
    ['other_arab', uk('other_arab'), exact('Arab')],
    ['other_any', uk('other_any'), exact('Any other ethnic group')],
    ['white_roma has no option, so it declines with a note', uk('white_roma'), NO_MATCH],
    ['decline', uk('decline'), DECLINE_PICK],
    ['the defaults decline', {}, DECLINE_PICK],
    ['the US race settings do not answer a UK list', { race: ['white'], hispanicLatino: 'no' }, DECLINE_PICK]
  ])
})

describe('UK ethnic group: lists that write the group and the subgroup in one option', () => {
  const lists: Array<[string, string]> = [
    ['What is your ethnic group? (group, then subgroup)', ' - '],
    ['What is your ethnic group? (slash)', ' / '],
    ['What is your ethnic group? (colon)', ': ']
  ]
  for (const [label, sep] of lists) {
    runCases(list(ONS, label), [
      ...ALL_SUBS.map((s): Case => [s.id, uk(s.id), exact(`${s.groupName}${sep}${s.text}`)]),
      ['decline', uk('decline'), DECLINE_PICK],
      ['the defaults decline', {}, DECLINE_PICK]
    ])
  }
})

describe('UK ethnic group: a list of subgroups only', () => {
  const cases: Case[] = ALL_SUBS.map((s): Case => [s.id, uk(s.id), exact(s.text)])
  runCases(list(ONS, 'What is your ethnic group? (subgroups only)'), [...cases, ['decline', uk('decline'), DECLINE_PICK], ['the defaults decline', {}, DECLINE_PICK]])
})

describe('UK ethnic group: the group first, then the subgroup in a second question', () => {
  runCases(list(ONS, 'Which of the following best describes your ethnic group?'), [
    ...ALL_SUBS.map((s): Case => [`${s.id} answers with its group`, uk(s.id), exact(s.groupName)]),
    ['decline', uk('decline'), DECLINE_PICK],
    ['the defaults decline', {}, DECLINE_PICK]
  ])

  const second: Array<[string, string]> = [
    ['Please select your Asian background', 'asian'],
    ['Please select your Black background', 'black'],
    ['Please select your Mixed background', 'mixed'],
    ['Please select your White background', 'white'],
    ['Please select your other ethnic background', 'other']
  ]
  for (const [label, group] of second) {
    runCases(list(ONS, label), [
      ...ALL_SUBS.filter((s) => s.group === group).map((s): Case => [s.id, uk(s.id), exact(s.text)]),
      ...ALL_SUBS.filter((s) => s.group !== group)
        .slice(0, 2)
        .map((s): Case => [`${s.id} has no option on the ${group} list, so it declines with a note`, uk(s.id), NO_MATCH]),
      ['the defaults decline', {}, DECLINE_PICK]
    ])
  }
})

describe('UK ethnic group: separators and wordings', () => {
  const pick = (options: string[], id: UkId): string | null => {
    const a = demographicAnswer(field('Ethnic group', 'select', [...options, 'Prefer not to say']), eeo(uk(id)), null)
    return a.note ? null : a.value
  }

  it('reads "Group - Subgroup", "Group / Subgroup", "Group: Subgroup" and the subgroup alone the same way', () => {
    for (const options of [
      ['Asian or Asian British - Indian', 'Asian or Asian British - Pakistani', 'White - Irish'],
      ['Asian or Asian British / Indian', 'Asian or Asian British / Pakistani', 'White / Irish'],
      ['Asian or Asian British: Indian', 'Asian or Asian British: Pakistani', 'White: Irish'],
      ['Asian/Asian British - Indian', 'Asian/Asian British - Pakistani', 'White - Irish'],
      ['Indian', 'Pakistani', 'Irish']
    ]) {
      expect(pick(options, 'asian_indian')).toBe(options[0])
      expect(pick(options, 'asian_pakistani')).toBe(options[1])
      expect(pick(options, 'white_irish')).toBe(options[2])
    }
  })

  it('reads the "White British" style', () => {
    const options = ['White British', 'White Irish', 'Asian Indian', 'Black African', 'Black Caribbean', 'Mixed White and Black Caribbean']
    expect(pick(options, 'white_british')).toBe('White British')
    expect(pick(options, 'white_irish')).toBe('White Irish')
    expect(pick(options, 'asian_indian')).toBe('Asian Indian')
    expect(pick(options, 'black_african')).toBe('Black African')
    expect(pick(options, 'black_caribbean')).toBe('Black Caribbean')
    expect(pick(options, 'mixed_white_black_caribbean')).toBe('Mixed White and Black Caribbean')
  })

  it('does not take "Irish Traveller" for "Irish", or "Black British" for "White British"', () => {
    const options = ['Irish', 'Gypsy or Irish Traveller', 'White British', 'Black British']
    expect(pick(options, 'white_irish')).toBe('Irish')
    expect(pick(options, 'white_gypsy_traveller')).toBe('Gypsy or Irish Traveller')
    expect(pick(options, 'white_british')).toBe('White British')
  })

  it('leaves an ambiguous list alone', () => {
    expect(pick(['Indian', 'Indian (British)', 'Pakistani'], 'asian_indian')).toBeNull()
  })

  it('does not take a US list for a UK list', () => {
    const usList = list('Greenhouse, Epic Games', 'Race/Ethnicity')
    const a = demographicAnswer(fieldOf(usList), eeo({ ukEthnicity: 'white_british' }), null)
    expect(a.value).toBe(declineOf(usList))
    expect(a.note).toBeNull()
  })
})

// --- Religion ---------------------------------------------------------------

const R = (religion: Settings['eeo']['religion']): Partial<Settings['eeo']> => ({ religion })

runCases(list(ONS, 'What is your religion?'), [
  ['none', R('none'), 'No religion'],
  ['christian picks the option that lists the denominations', R('christian'), opt(/^Christian/)],
  ['buddhist', R('buddhist'), 'Buddhist'],
  ['hindu', R('hindu'), 'Hindu'],
  ['jewish', R('jewish'), 'Jewish'],
  ['muslim', R('muslim'), 'Muslim'],
  ['sikh', R('sikh'), 'Sikh'],
  ['other', R('other'), 'Any other religion'],
  ['decline', R('decline'), DECLINE_PICK],
  ['the defaults decline', {}, DECLINE_PICK]
])
runCases(list(ONS, 'What is your religion or belief?'), [
  ['none', R('none'), 'No religion or belief'],
  ['christian', R('christian'), 'Christian'],
  ['sikh', R('sikh'), 'Sikh'],
  ['other', R('other'), 'Other'],
  ['the defaults decline', {}, DECLINE_PICK]
])
runCases(list(ONS, 'Do you follow a religion?'), [
  ['none is No', R('none'), 'No'],
  ['any religion is Yes', R('muslim'), 'Yes'],
  ['the defaults decline', {}, DECLINE_PICK]
])

// --- Caring and neurodivergent ---------------------------------------------------

runCases(list(UKREF, 'Do you have caring responsibilities?'), [
  ['yes', { caring: 'yes' }, 'Yes'],
  ['no', { caring: 'no' }, 'No'],
  ['decline', { caring: 'decline' }, DECLINE_PICK],
  ['the defaults decline', {}, DECLINE_PICK]
])
runCases(list(UKREF, 'Do you have any caring responsibilities?'), [
  ['yes cannot choose between several Yes options', { caring: 'yes' }, NO_MATCH],
  ['no', { caring: 'no' }, 'No'],
  ['the defaults decline', {}, DECLINE_PICK]
])
runCases(list(UKREF, 'Do you consider yourself to be neurodivergent?'), [
  ['yes', { neurodivergent: 'yes' }, 'Yes'],
  ['no', { neurodivergent: 'no' }, 'No'],
  ['the defaults decline', {}, DECLINE_PICK]
])
runCases(list(UKREF, 'Neurodiversity'), [
  ['yes picks Neurodivergent', { neurodivergent: 'yes' }, 'Neurodivergent'],
  ['no picks Neurotypical', { neurodivergent: 'no' }, 'Neurotypical'],
  ['the defaults decline', {}, DECLINE_PICK]
])
runCases(list(UKREF, 'Are you neurotypical?'), [
  ['neurodivergent yes answers No', { neurodivergent: 'yes' }, 'No'],
  ['neurodivergent no answers Yes', { neurodivergent: 'no' }, 'Yes'],
  ['the defaults decline', {}, DECLINE_PICK]
])
runCases(list(UKREF, 'Do you have dyslexia?'), [
  ['neurodivergent yes cannot say yes to one condition', { neurodivergent: 'yes' }, DECLINE_PICK],
  ['neurodivergent no answers No', { neurodivergent: 'no' }, 'No'],
  ['the defaults decline', {}, DECLINE_PICK]
])

// --- Social Mobility Commission ----------------------------------------------------

const OCC = (householdOccupation: Settings['eeo']['socioeconomic']['householdOccupation']): Partial<Settings['eeo']> => ({
  socioeconomic: { ...DEFAULT_SETTINGS.eeo.socioeconomic, householdOccupation }
})
runCases(list(SMC, 'What was the occupation of your main household earner'), [
  ['modern_professional', OCC('modern_professional'), opt(/^Modern professional/)],
  ['clerical_intermediate', OCC('clerical_intermediate'), opt(/^Clerical/)],
  ['senior_manager', OCC('senior_manager'), opt(/^Senior managers/)],
  ['technical_craft', OCC('technical_craft'), opt(/^Technical and craft/)],
  ['semi_routine, not routine', OCC('semi_routine'), opt(/^Semi-routine/)],
  ['routine, not semi-routine', OCC('routine'), opt(/^Routine manual/)],
  ['middle_manager', OCC('middle_manager'), opt(/^Middle or junior/)],
  ['traditional_professional', OCC('traditional_professional'), opt(/^Traditional professional/)],
  ['long_term_unemployed', OCC('long_term_unemployed'), opt(/^Long-term unemployed/)],
  ['retired', OCC('retired'), 'Retired'],
  ['not_applicable', OCC('not_applicable'), 'This question does not apply to me'],
  ['decline', OCC('decline'), DECLINE_PICK],
  ['the defaults decline', {}, DECLINE_PICK]
])

const SCHOOL = (schoolType: Settings['eeo']['socioeconomic']['schoolType']): Partial<Settings['eeo']> => ({
  socioeconomic: { ...DEFAULT_SETTINGS.eeo.socioeconomic, schoolType }
})
runCases(list(SMC, 'What type of school did you attend'), [
  ['state_non_selective', SCHOOL('state_non_selective'), opt(/non-selective/)],
  ['state_selective, not non-selective', SCHOOL('state_selective'), opt(/\(selective on/)],
  ['independent, not the bursary option', SCHOOL('independent'), exact('Independent or fee-paying school')],
  ['independent_bursary', SCHOOL('independent_bursary'), opt(/bursary/)],
  ['outside_uk', SCHOOL('outside_uk'), 'Attended school outside the UK'],
  ['decline', SCHOOL('decline'), DECLINE_PICK],
  ['the defaults decline', {}, DECLINE_PICK]
])

runCases(list(SMC, 'Were you eligible for free school meals'), [
  ['yes', { socioeconomic: { ...DEFAULT_SETTINGS.eeo.socioeconomic, freeSchoolMeals: 'yes' } }, 'Yes'],
  ['no', { socioeconomic: { ...DEFAULT_SETTINGS.eeo.socioeconomic, freeSchoolMeals: 'no' } }, 'No'],
  ['decline', { socioeconomic: { ...DEFAULT_SETTINGS.eeo.socioeconomic, freeSchoolMeals: 'decline' } }, DECLINE_PICK],
  ['the defaults decline', {}, DECLINE_PICK]
])

const PARENT = (parentDegree: YesNoDecline): Partial<Settings['eeo']> => ({ socioeconomic: { ...DEFAULT_SETTINGS.eeo.socioeconomic, parentDegree } })
runCases(list(SMC, 'Did either of your parents attend university'), [
  ['yes', PARENT('yes'), opt(/^Yes/)],
  ['no', PARENT('no'), opt(/^No/)],
  ['the defaults decline', {}, DECLINE_PICK]
])
runCases(list(SMC, 'Are you the first in your family to go to university?'), [
  ['a parent with a degree means not the first, so No', PARENT('yes'), 'No'],
  ['no parent degree does not prove first generation, so it declines', PARENT('no'), DECLINE_PICK],
  ['the defaults decline', {}, DECLINE_PICK]
])

// --- Age band (from the birth year only), marital status and pregnancy -------------------

describe('UK age band', () => {
  const l = list(UKREF, 'What is your age band?')
  const answer = (birthYear: number | null) => demographicAnswer(fieldOf(l), eeo({ birthYear }), null, 2026).value
  covered.add(l)
  it('picks the band from the birth year', () => {
    expect(answer(1992)).toBe('25-34')
    expect(answer(1975)).toBe('45-54')
    expect(answer(1990)).toBe('35-44')
    expect(answer(1950)).toBe('65+')
    expect(answer(2005)).toBe('16-24')
  })
  it('declines without a birth year', () => {
    expect(answer(null)).toBe('Prefer not to say')
  })
  it('declines on a band edge', () => {
    expect(answer(1981)).toBe('Prefer not to say')
  })
})

const EVERYTHING_SET: Partial<Settings['eeo']> = {
  gender: 'woman',
  transgender: 'no',
  disability: 'yes',
  religion: 'muslim',
  caring: 'yes',
  neurodivergent: 'yes',
  birthYear: 1990,
  ukEthnicity: 'asian_indian'
}
runCases(list(UKREF, 'Marital status'), [
  ['the defaults decline', {}, DECLINE_PICK],
  ['no setting changes it', EVERYTHING_SET, DECLINE_PICK]
])
runCases(list(UKREF, 'Are you pregnant or on maternity leave?'), [
  ['the defaults decline', {}, DECLINE_PICK],
  ['no setting changes it', EVERYTHING_SET, DECLINE_PICK]
])

describe('UK and EU questions without a decline option', () => {
  const ask1 = (f: FormField, patch: Partial<Settings['eeo']> = {}) => demographicAnswer(f, eeo(patch), null)
  it('flags a required marital status or pregnancy question with no decline option', () => {
    expect(ask1(field('Marital status', 'select', ['Single', 'Married'], true))).toMatchObject({ needsUser: true, value: '' })
    expect(ask1(field('Are you pregnant?', 'select', ['Yes', 'No'], true))).toMatchObject({ needsUser: true, value: '' })
  })
  it('leaves optional text boxes blank and does not tick checkboxes', () => {
    expect(ask1(field('Marital status', 'text', [], false), EVERYTHING_SET)).toMatchObject({ value: '', needsUser: false })
    expect(ask1(field('I have caring responsibilities', 'checkbox', [], false))).toMatchObject({ value: 'false', needsUser: false })
    expect(ask1(field('I have caring responsibilities', 'checkbox', [], false), { caring: 'yes' })).toMatchObject({ value: 'true', needsUser: false })
  })
  it('writes a short answer into a text box', () => {
    expect(ask1(field('Do you have caring responsibilities?', 'text', [], false), { caring: 'yes' }).value).toBe('Yes')
    expect(ask1(field('What is your religion?', 'text', [], false), { religion: 'sikh' }).value).toBe('Sikh')
    expect(ask1(field('What is your religion?', 'text', [], false), { religion: 'other' }).value).toBe('')
  })
})

// --- Coverage and the model -------------------------------------------------------

describe('fixture coverage', () => {
  it('has a case table for every list', () => {
    const missing = LISTS.filter((l) => !covered.has(l)).map((l) => `${l.source} / ${l.label}`)
    expect(missing).toEqual([])
  })

  it('never reached the model', () => {
    expect(prompts).toEqual([])
  })
})
