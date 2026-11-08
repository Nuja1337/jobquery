import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField, Profile } from '@shared/types'
import { Db } from '../db/database'
import { AnswerBankRepo } from '../db/repos/answers'
import { ProvidersRepo } from '../db/repos/providers'
import { SettingsRepo } from '../db/repos/settings'
import { LlmService } from '../llm/service'
import type { LlmClient } from '../llm/types'
import { testVault } from '../secrets'
import { answerFields } from './answers'

// Opt-ins, "Have you previously applied to us?" and the company history questions, through answerFields.

const profile: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  location: 'Austin, TX',
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
  application: { ...EMPTY_APPLICATION_FACTS, relativesAtEmployers: false, referrals: 'none' },
  experience: [{ company: 'Ledgerly', title: 'Engineer', start: '2021', end: 'present', highlights: [] }]
}

const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** A model that answers every short field "Maybe" and records what it was asked. */
function model(asked: string[]): LlmClient {
  return {
    kind: 'anthropic',
    async complete(m) {
      return { text: 'Written.', usage, model: m, truncated: false }
    },
    async completeJson(m, req, schema) {
      const fields = JSON.parse(req.prompt.split('FIELDS\n')[1]) as Array<{ key: string; question: string }>
      for (const f of fields) asked.push(f.question)
      const value = schema.parse({ answers: fields.map((f) => ({ key: f.key, value: 'Maybe', confidence: 0.9, needsUser: false, note: '' })) })
      return { text: '', value, usage, model: m, truncated: false }
    },
    async listModels() {
      return []
    }
  }
}

async function setup(asked: string[], extra: { previouslyApplied?: (company: string) => boolean; profile?: Profile } = {}) {
  const db = await Db.open(null)
  const settings = new SettingsRepo(db)
  const providers = new ProvidersRepo(db, testVault)
  await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
  const llm = new LlmService(db, settings, providers, () => model(asked))
  const bank = new AnswerBankRepo(db)
  return {
    bank,
    deps: {
      llm,
      settings: DEFAULT_SETTINGS,
      profile: extra.profile ?? profile,
      samples: [],
      findSavedAnswer: (q: string) => {
        const hit = bank.findBest(q)
        return hit ? { id: hit.id, answer: hit.answer, kind: hit.kind, topic: hit.topic } : null
      },
      markAnswerUsed: (id: string) => bank.markUsed(id),
      resumePath: null,
      previouslyApplied: extra.previouslyApplied
    }
  }
}

const job = { id: 'j1', company: 'Riot Games', title: 'Engineer', location: 'Los Angeles, CA', description: 'We make games.', fit: null, source: 'greenhouse' as const }

const field = (label: string, type: FieldType = 'select', options: string[] = ['Yes', 'No'], required = true): FormField => ({
  key: 'q',
  label,
  type,
  required,
  options,
  placeholder: null,
  maxLength: null,
  fileHint: null
})

const one = async (f: FormField, extra?: Parameters<typeof setup>[1]) => {
  const asked: string[] = []
  const { deps, bank } = await setup(asked, extra)
  const { answers } = await answerFields(deps, job, [f], null)
  return { answer: answers[0], asked, bank }
}

describe('opt-ins to messages', () => {
  const label = 'Do you opt-in to receive WhatsApp messages from Stripe Recruiting?'

  it('declines in a combobox, a select, a radio and a typed box', async () => {
    for (const type of ['combobox', 'select', 'radio'] as const) {
      const { answer, asked } = await one(field(label, type))
      expect(answer, type).toMatchObject({ value: 'No', needsUser: false, source: 'settings' })
      expect(asked).toEqual([])
    }
    expect((await one(field(label, 'combobox', []))).answer).toMatchObject({ value: 'No', needsUser: false })
  })

  it('picks the option that declines even when it does not start with No', async () => {
    const { answer } = await one(field(label, 'select', ['Yes, I opt in', 'I do not opt in']))
    expect(answer).toMatchObject({ value: 'I do not opt in', needsUser: false })
  })

  it('never answers a required consent or legal question as an opt-in', async () => {
    const consent = await one(field('I consent to receiving SMS text messages', 'checkbox', []))
    expect(consent.answer).toMatchObject({ needsUser: true, value: '' })
    const legal = await one(field('Do you agree to the arbitration agreement?'))
    expect(legal.answer).toMatchObject({ needsUser: true, value: '' })
  })
})

describe('"Have you previously applied" with the application log', () => {
  const label = 'Have you previously applied to Riot Games?'

  it('answers No when the log shows no earlier application, and Yes when it does', async () => {
    const seen: string[] = []
    const no = await one(field(label), { previouslyApplied: (c) => (seen.push(c), false) })
    expect(no.answer).toMatchObject({ value: 'No', needsUser: false, source: 'profile' })
    expect(seen).toEqual(['Riot Games'])
    expect(no.asked).toEqual([])
    const yes = await one(field('Have you applied here before?'), { previouslyApplied: () => true })
    expect(yes.answer).toMatchObject({ value: 'Yes', needsUser: false })
  })

  it('waits for the person when the app has no log to ask', async () => {
    const { answer, asked } = await one(field(label))
    expect(answer).toMatchObject({ needsUser: true, value: '' })
    expect(asked).toEqual([])
  })

  it('lets a saved answer of the person answer when there is no log', async () => {
    const asked: string[] = []
    const { deps, bank } = await setup(asked)
    bank.save({ question: label, answer: 'No', kind: 'fact', topic: null })
    const { answers } = await answerFields(deps, job, [field(label)], null)
    expect(answers[0]).toMatchObject({ value: 'No', source: 'answer_bank', needsUser: false })
  })

  it('leaves a question about another company or a time span to the model', async () => {
    const seen: string[] = []
    const prev = (c: string) => (seen.push(c), false)
    for (const text of ['Have you previously applied to Google?', 'Have you applied to any role in the past 12 months?']) {
      const { answer, asked } = await one(field(text, 'text', []), { previouslyApplied: prev })
      expect(answer.value, text).toBe('Maybe')
      expect(asked, text).toEqual([text])
    }
    expect(seen).toEqual([])
  })

  it('does not say No for this exact role after an earlier application', async () => {
    const { answer } = await one(field('Have you previously applied for this position?'), { previouslyApplied: () => true })
    expect(answer).toMatchObject({ needsUser: true, value: '' })
    const none = await one(field('Have you previously applied for this position?'), { previouslyApplied: () => false })
    expect(none.answer).toMatchObject({ value: 'No' })
  })

  it('leaves the "If yes" follow-up blank when the log shows no application', async () => {
    const f = field('If yes, when did you apply and for which application?', 'text', [], false)
    const { answer, asked } = await one(f, { previouslyApplied: () => false })
    expect(answer).toMatchObject({ value: '', needsUser: false })
    expect(asked).toEqual([])
  })
})

describe('company history through answerFields', () => {
  it('answers the worked-here questions and their follow-up without the model', async () => {
    const asked: string[] = []
    const { deps } = await setup(asked)
    const fields = [
      { ...field('Have you ever worked for a Sony company previously?'), key: 'a' },
      { ...field('As we are majority owned by Tencent, we would like to know if you have worked for Tencent'), key: 'b' },
      { ...field('Have you previously been employed by our organization?'), key: 'c' },
      { ...field('If yes, please state the last year and month you worked for Riot', 'text', [], false), key: 'd' },
      { ...field('Do you have any immediate family members working at Riot Games?'), key: 'e' },
      { ...field('Did a Riot Games employee refer you?'), key: 'f' },
      { ...field('Who referred you?', 'text', []), key: 'g' }
    ]
    const { answers } = await answerFields(deps, job, fields, null)
    expect(answers.map((a) => a.value)).toEqual(['No', 'No', 'No', '', 'No', 'No', 'No referral.'])
    expect(answers.every((a) => !a.needsUser)).toBe(true)
    expect(asked).toEqual([])
  })

  it('asks the person when no fact says whether family or a referral applies', async () => {
    const bare: Profile = { ...profile, application: { ...EMPTY_APPLICATION_FACTS } }
    const asked: string[] = []
    const { deps } = await setup(asked, { profile: bare })
    const fields = [
      { ...field('Do you have friends, family or significant others who work at Riot Games?'), key: 'a' },
      { ...field('Did a Riot Games employee refer you?'), key: 'b' }
    ]
    const { answers } = await answerFields(deps, job, fields, null)
    expect(answers.map((a) => a.needsUser)).toEqual([true, true])
    expect(asked).toEqual([])
  })
})
