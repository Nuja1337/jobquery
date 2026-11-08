import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, FormField, Profile } from '@shared/types'
import { answerFields, type AnswerDeps, type JobForAnswers, type SavedAnswer } from './answers'
import { renderApplicationFacts } from './factsSummary'
import { WILLINGNESS_FAMILIES, willingnessFamily, willingnessNote } from './questionFamilies'

const application: ApplicationFacts = {
  ...EMPTY_PROFILE.application,
  authorization: [{ country: 'United States', status: 'citizen', needsSponsorship: false, notes: '' }],
  salary: [{ currency: 'USD', min: 110000, target: 130000, period: 'year', answerStyle: 'number' }],
  relocation: { willing: true, places: ['Seattle', 'Austin'] },
  travel: 'some',
  clearance: 'None',
  driversLicense: true,
  over18: true
}
const profile: Profile = { ...EMPTY_PROFILE, fullName: 'Sam Rivera', email: 'sam@example.com', location: 'Austin, TX', application }

const job: JobForAnswers = { id: 'j', company: 'Studio', title: 'Gameplay Programmer', location: 'Irvine, CA', description: 'Onsite.', fit: null, source: 'greenhouse' } as JobForAnswers

const yesNo = (key: string, label: string, patch: Partial<FormField> = {}): FormField => ({ key, label, type: 'select', required: true, options: ['Yes', 'No'], ...patch }) as FormField
const textField = (key: string, label: string): FormField => ({ key, label, type: 'text', required: true, options: [] }) as unknown as FormField

function setup(saved: Record<string, Partial<SavedAnswer>> = {}, jobPatch: Partial<JobForAnswers> = {}) {
  const calls: Array<{ context: string; fields: Array<{ key: string; question: string }> }> = []
  const llm = {
    json: vi.fn(async (req: { context: string; prompt: string }) => {
      calls.push({ context: req.context, fields: JSON.parse(req.prompt.split('FIELDS\n')[1]) })
      return { costUsd: 0, value: { answers: [] } }
    })
  }
  const markAnswerUsed = vi.fn()
  const deps = {
    llm,
    settings: DEFAULT_SETTINGS,
    profile,
    samples: [],
    findSavedAnswer: (question: string) => {
      const hit = saved[question]
      return hit ? ({ id: `saved-${question}`, answer: 'Yes', kind: 'fact', topic: null, ...hit } as SavedAnswer) : null
    },
    markAnswerUsed,
    resumePath: 'resume.pdf'
  } as unknown as AnswerDeps
  const run = (fields: FormField[], options: Parameters<typeof answerFields>[4] = {}) => answerFields(deps, { ...job, ...jobPatch }, fields, null, options)
  return { run, calls, llm, markAnswerUsed }
}

describe('a saved answer clears a rule flag', () => {
  it('clears the background-check question, the start-date question and the skill-years question', async () => {
    const env = setup({
      'Are you willing to undergo a background check?': { answer: 'Yes' },
      'Can you start within 2 weeks?': { answer: 'Yes' },
      'How many years of experience do you have with Unreal Engine 5?': { answer: '3' }
    })
    const { answers } = await env.run([
      yesNo('q0', 'Are you willing to undergo a background check?'),
      yesNo('q1', 'Can you start within 2 weeks?'),
      textField('q2', 'How many years of experience do you have with Unreal Engine 5?')
    ])
    expect(answers.map((a) => [a.value, a.source, a.needsUser])).toEqual([
      ['Yes', 'answer_bank', false],
      ['Yes', 'answer_bank', false],
      ['3', 'answer_bank', false]
    ])
    expect(env.markAnswerUsed).toHaveBeenCalledTimes(3)
    expect(env.llm.json).not.toHaveBeenCalled()
  })

  it('keeps the flag when the saved answer is not one of the options', async () => {
    const env = setup({ 'Can you start within 2 weeks?': { answer: 'Maybe' } })
    const { answers } = await env.run([yesNo('q1', 'Can you start within 2 weeks?')])
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
    expect(env.markAnswerUsed).not.toHaveBeenCalled()
  })

  it('does not use a saved template, which is a starting point and not a fact', async () => {
    const env = setup({ 'How many years of experience do you have with Unreal Engine 5?': { answer: '3', kind: 'template' } })
    const { answers } = await env.run([textField('q2', 'How many years of experience do you have with Unreal Engine 5?')])
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
  })

  it('leaves a saved salary out of a salary flag, whatever the currency', async () => {
    const env = setup({ 'Expected salary': { answer: '120000', topic: 'salary_expectation' } }, { salaryCurrency: 'SEK', location: 'Stockholm' })
    const { answers } = await env.run([textField('q0', 'Expected salary')])
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
    expect(answers[0].note).toMatch(/SEK/)
    expect(env.markAnswerUsed).not.toHaveBeenCalled()
  })

  it('leaves a saved salary out of the flag even when the saved entry has no topic', async () => {
    const env = setup({ 'Expected salary': { answer: '120000', topic: null } }, { salaryCurrency: 'SEK', location: 'Stockholm' })
    const { answers } = await env.run([textField('q0', 'Expected salary')])
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
  })
})

describe('willingness questions are never guessed', () => {
  const labels = [
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
    'Are you a U.S. person as defined by ITAR?',
    'Will you now or in the future require the company to commence an immigration case in order to employ you?'
  ]

  it('sends none of the 12 probe labels to the model and flags each required one', async () => {
    const env = setup()
    const { answers } = await env.run(labels.map((label, i) => yesNo(`q${i}`, label)))
    expect(env.llm.json).not.toHaveBeenCalled()
    expect(answers).toHaveLength(12)
    for (const a of answers) {
      // The profile would relocate to Seattle, so commuting to the Seattle office is a Yes (owner decision 3).
      if (a.label.includes('Seattle office')) {
        expect(a).toMatchObject({ value: 'Yes', source: 'profile', needsUser: false })
        continue
      }
      expect(a).toMatchObject({ value: '', needsUser: true })
      expect(a.note).toMatch(/^This asks about .+ Your profile does not answer it, so answer it yourself\.$/)
    }
  })

  it('leaves an optional one blank without a flag', async () => {
    const env = setup()
    const { answers } = await env.run([yesNo('q0', 'Are you open to a hybrid schedule?', { required: false })])
    expect(env.llm.json).not.toHaveBeenCalled()
    expect(answers[0]).toMatchObject({ value: '', needsUser: false })
  })

  it('still lets the person own saved answer fill one', async () => {
    const env = setup({ 'Are you open to a hybrid schedule?': { answer: 'Yes' } })
    const { answers } = await env.run([yesNo('q0', 'Are you open to a hybrid schedule?')])
    expect(answers[0]).toMatchObject({ value: 'Yes', source: 'answer_bank', needsUser: false })
  })

  it('applies after Regenerate too', async () => {
    const env = setup()
    const { answers } = await env.run([yesNo('q0', 'Are you open to a hybrid schedule?')], { regenerateKeys: new Set(['q0']) })
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
    expect(env.llm.json).not.toHaveBeenCalled()
  })

  it('still sends an ordinary short question to the model', async () => {
    const env = setup()
    await env.run([yesNo('q0', 'Are you open to a hybrid schedule?'), textField('q1', 'Favorite game engine')])
    expect(env.calls).toHaveLength(1)
    expect(env.calls[0].fields.map((f) => f.question)).toEqual(['Favorite game engine'])
  })
})

describe('the model sees the stated facts', () => {
  it('puts the relocation line and the other facts in the form_map context', async () => {
    const env = setup()
    await env.run([textField('q1', 'Favorite game engine')])
    const { context } = env.calls[0]
    expect(context).toContain('Willing to relocate: yes')
    expect(context).toContain('Places they would relocate to: Seattle, Austin')
    expect(context).toContain('Work authorization in United States: citizen, needs no visa sponsorship')
    expect(context).toContain('Over 18: yes')
  })
})

describe('renderApplicationFacts', () => {
  it('writes unanswered facts as not stated', () => {
    const text = renderApplicationFacts(EMPTY_PROFILE.application, { remote: [] })
    expect(text).toContain('Willing to relocate: not stated')
    expect(text).toContain('Travel for work: not stated')
    expect(text).toContain('Work authorization: not stated')
    expect(text).toContain('Security clearance: not stated')
    expect(text).toContain("Driver's license: not stated")
    expect(text).toContain('Over 18: not stated')
    expect(text).toContain('Remote preference: not stated')
  })

  it('writes the stated facts', () => {
    const text = renderApplicationFacts(application, { remote: ['remote', 'hybrid'] })
    expect(text).toContain('Willing to relocate: yes')
    expect(text).toContain('Travel for work: some travel')
    expect(text).toContain('Security clearance: None')
    expect(text).toContain("Driver's license: yes")
    expect(text).toContain('Remote preference: remote, hybrid')
  })

  it('says any place when the person would relocate and listed none, and drops the places when they would not', () => {
    expect(renderApplicationFacts({ ...application, relocation: { willing: true, places: [] } }, { remote: [] })).toContain('Places they would relocate to: any place')
    const no = renderApplicationFacts({ ...application, relocation: { willing: false, places: ['Seattle'] } }, { remote: [] })
    expect(no).toContain('Willing to relocate: no')
    expect(no).not.toContain('Places they would relocate to')
  })
})

describe('willingnessFamily', () => {
  it.each([
    ['Are you able to commute to our office?', 'commute'],
    ['Are you willing to work onsite?', 'onsite'],
    ['Are you open to a hybrid schedule?', 'hybrid'],
    ['Can you work evenings and weekends?', 'schedule'],
    ['Are you able to work overtime?', 'overtime'],
    ['Can you work 40 hours per week?', 'hours'],
    ['Are you looking for a full-time role?', 'employment_type'],
    ['Will you take a drug test?', 'drug_test'],
    ['Do you consent to a background check?', 'background_check'],
    ['Do you agree to a credit check?', 'credit_check'],
    ['Are you a U.S. person under ITAR?', 'export_control'],
    ['Will you need an immigration case?', 'immigration_case']
  ])('%s is %s', (label, family) => {
    expect(willingnessFamily(label)).toBe(family)
  })

  it.each(['What is your favorite game engine?', 'Years of experience with C++', 'Are you a lawful permanent resident?', 'LinkedIn profile', ''])(
    'leaves "%s" alone',
    (label) => {
      expect(willingnessFamily(label)).toBeNull()
    }
  )

  it('has a note for every family', () => {
    for (const family of WILLINGNESS_FAMILIES) expect(willingnessNote(family)).toMatch(/^This asks about .+\. Your profile does not answer it, so answer it yourself\.$/)
  })
})
