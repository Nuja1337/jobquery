import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, Profile } from '@shared/types'
import { Db } from '../db/database'
import { AnswerBankRepo } from '../db/repos/answers'
import { ProvidersRepo } from '../db/repos/providers'
import { SettingsRepo } from '../db/repos/settings'
import { LlmService } from '../llm/service'
import type { LlmClient } from '../llm/types'
import { testVault } from '../secrets'
import fixture from './__fixtures__/greenhouse-questions.json'
import { answerFields } from './answers'
import { greenhouseFields } from './greenhouseForm'

// With the interview done, a Greenhouse form needs the person only for AI use, consent and legal questions.

const application: ApplicationFacts = {
  ...EMPTY_APPLICATION_FACTS,
  address: { street: '221 Baker Street', city: 'Austin', region: 'TX', postalCode: '78701', country: 'United States' },
  phoneCountryCode: '+1',
  authorization: [{ country: 'United States', status: 'citizen', needsSponsorship: false, notes: '' }],
  salary: [{ currency: 'USD', min: 110000, target: 130000, period: 'year', answerStyle: 'range' }],
  noticeWeeks: 2,
  earliestStart: null,
  relocation: { willing: true, places: [] },
  travel: 'some',
  skillYears: { React: 6 },
  languageLevels: { English: 'native' },
  clearance: 'None',
  driversLicense: true,
  over18: true,
  references: 'Available on request.',
  gpa: '3.7',
  heardAbout: 'LinkedIn'
}

const profile: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  phone: '555-0100',
  location: 'Austin, TX',
  links: { ...EMPTY_PROFILE.links, linkedin: 'https://linkedin.com/in/sam' },
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
  experience: [{ company: 'Ledgerly', title: 'Senior Engineer', start: '2021', end: 'present', highlights: ['Rebuilt billing after a double-charge incident, cutting failed retries by 40%'] }],
  application
}

const usage = { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }
const WRITTEN = 'I rebuilt the billing system at Ledgerly after a weekend of double charges, and the retry fix cut failed payments by 40 percent. Safety work at Anthropic has the same shape, where small errors compound.'

/** A model that answers every short field "No" and writes the open ones. It records what it was asked. */
function model(asked: string[]): LlmClient {
  return {
    kind: 'anthropic',
    async complete(m) {
      return { text: WRITTEN, usage, model: m, truncated: false }
    },
    async completeJson(m, req, schema) {
      if (req.prompt.includes('QUESTION q1')) {
        const keys = [...req.prompt.matchAll(/^QUESTION (q\d+)$/gm)].map((x) => x[1])
        return { text: '', value: schema.parse({ answers: keys.map((key) => ({ key, answer: WRITTEN })) }), usage, model: m, truncated: false }
      }
      const fields = JSON.parse(req.prompt.split('FIELDS\n')[1]) as Array<{ key: string; question: string }>
      for (const f of fields) asked.push(f.question)
      const value = schema.parse({ answers: fields.map((f) => ({ key: f.key, value: 'No', confidence: 0.9, needsUser: false, note: '' })) })
      return { text: '', value, usage, model: m, truncated: false }
    },
    async listModels() {
      return []
    }
  }
}

async function setup(asked: string[], savedAnswers?: AnswerBankRepo) {
  const db = await Db.open(null)
  const settings = new SettingsRepo(db)
  const providers = new ProvidersRepo(db, testVault)
  await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
  const llm = new LlmService(db, settings, providers, () => model(asked))
  const answers = savedAnswers ?? new AnswerBankRepo(db)
  return {
    db,
    answers,
    deps: {
      llm,
      settings: { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, minLintScore: 0 } },
      profile,
      samples: [],
      findSavedAnswer: (q: string) => {
        const hit = answers.findBest(q)
        return hit ? { id: hit.id, answer: hit.answer, kind: hit.kind, topic: hit.topic } : null
      },
      markAnswerUsed: (id: string) => answers.markUsed(id),
      resumePath: 'C:/resumes/sam.pdf'
    }
  }
}

const job = { id: 'j1', company: 'Anthropic', title: '3P Revenue Accounting', location: 'San Francisco, CA', description: 'We build safe AI.', fit: null, source: 'greenhouse' as const }

describe('answerFields with the application facts filled in', () => {
  it('leaves only the AI-use, consent and legal questions for the person', async () => {
    const asked: string[] = []
    const { deps } = await setup(asked)
    const fields = greenhouseFields(fixture as never)
    const { answers } = await answerFields(deps, job, fields, null)

    const needing = answers.filter((a) => a.needsUser).map((a) => a.label)
    // The in-person question is a willingness question. No fact answers it yet, so it waits for the person.
    expect(needing.sort()).toEqual(['AI Policy for Application', 'Agreement to Arbitrate', 'Are you open to working in-person in one of our offices 25% of the time?', 'Please read the arbitration agreement below'].sort())

    const by = (re: RegExp) => answers.find((a) => re.test(a.label))!
    expect(by(/^Do you require visa sponsorship/)).toMatchObject({ value: 'No', source: 'profile' })
    expect(by(/open to relocation/)).toMatchObject({ value: 'Yes', source: 'profile' })
    expect(by(/earliest you would want to start/)).toMatchObject({ value: '2 weeks after an offer.', source: 'profile' })
    expect(by(/address from which you plan/)).toMatchObject({ value: '221 Baker Street, Austin, TX 78701, United States', source: 'profile' })
  })

  it('does not send the questions the facts answer to the model', async () => {
    const asked: string[] = []
    const { deps } = await setup(asked)
    await answerFields(deps, job, greenhouseFields(fixture as never), null)
    expect(asked.some((q) => /relocation|earliest you would want|visa sponsorship|address from which/i.test(q))).toBe(false)
  })

  it('answers the AI-use question from the stance saved for that exact question', async () => {
    const asked: string[] = []
    const { deps, answers } = await setup(asked)
    answers.save({ question: 'AI Policy for Application', answer: 'Yes', kind: 'fact', topic: 'ai_use_disclosure' })
    const fields = greenhouseFields(fixture as never).filter((f) => /AI Policy/.test(f.label))
    const { answers: out } = await answerFields(deps, job, fields, null)
    expect(out[0]).toMatchObject({ value: 'Yes', source: 'answer_bank', needsUser: false })
  })

  it('leaves the AI-use question to the person when the saved stance is for another wording', async () => {
    const asked: string[] = []
    const { deps, answers } = await setup(asked)
    answers.save({ question: 'Did you use AI to help with your application?', answer: 'Yes', kind: 'fact', topic: 'ai_use_disclosure' })
    const fields = greenhouseFields(fixture as never).filter((f) => /AI Policy/.test(f.label))
    const { answers: out } = await answerFields(deps, job, fields, null)
    expect(out[0]).toMatchObject({ value: '', needsUser: true })
  })
})
