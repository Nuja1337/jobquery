import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Profile } from '@shared/types'
import { Db } from '../db/database'
import { ProvidersRepo } from '../db/repos/providers'
import { SettingsRepo } from '../db/repos/settings'
import type { LlmClient } from '../llm/types'
import { LlmService } from '../llm/service'
import { testVault } from '../secrets'
import fixture from './__fixtures__/greenhouse-questions.json'
import { answerFields } from './answers'
import { greenhouseFields } from './greenhouseForm'

const profile: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  phone: '555-0100',
  links: { ...EMPTY_PROFILE.links, linkedin: 'https://linkedin.com/in/sam' },
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
  experience: [{ company: 'Ledgerly', title: 'Senior Engineer', start: '2021', end: 'present', highlights: ['Rebuilt billing after a double-charge incident, cutting failed retries by 40%'] }]
}

const usage = { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }

// Stands in for the model. Short fields get "Yes" when they look like open-to questions and
// are flagged otherwise. Written answers come back plain and specific.
const fake: LlmClient = {
  kind: 'anthropic',
  async complete(model) {
    return { text: 'I rebuilt the billing system at Ledgerly after a weekend of double charges, and the retry fix cut failed payments by 40 percent. Safety work at Anthropic has the same shape, where small errors compound.', usage, model, truncated: false }
  },
  async completeJson(model, req, schema) {
    const fields = JSON.parse(req.prompt.split('FIELDS\n')[1]) as Array<{ key: string; question: string }>
    const value = schema.parse({
      answers: fields.map((f) => (/open to/i.test(f.question) ? { key: f.key, value: 'Yes', confidence: 0.8, needsUser: false, note: '' } : { key: f.key, value: '', confidence: 0, needsUser: true, note: 'Not in the profile.' }))
    })
    return { text: '', value, usage, model, truncated: false }
  },
  async listModels() {
    return []
  }
}

async function deps() {
  const db = await Db.open(null)
  const settings = new SettingsRepo(db)
  const providers = new ProvidersRepo(db, testVault)
  await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
  const llm = new LlmService(db, settings, providers, () => fake)
  return {
    llm,
    settings: { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, minLintScore: 0 } },
    profile,
    samples: [],
    findSavedAnswer: () => null,
    markAnswerUsed: () => {},
    resumePath: 'C:/resumes/sam.pdf'
  }
}

describe('answerFields on a real Greenhouse form', () => {
  it('fills from the profile, batches short fields, writes long ones and flags what it must not answer', async () => {
    const fields = greenhouseFields(fixture as never)
    const job = { id: 'j1', company: 'Anthropic', title: '3P Revenue Accounting', location: 'San Francisco, CA', description: 'We build safe AI.', fit: null, source: 'greenhouse' as const }
    const { answers, costUsd } = await answerFields(await deps(), job, fields, null)
    const by = (re: RegExp) => answers.find((a) => re.test(a.label))!

    expect(answers).toHaveLength(fields.length)
    expect(costUsd).toBeGreaterThan(0)
    expect(by(/^First Name/)).toMatchObject({ value: 'Sam', source: 'profile' })
    expect(by(/^Resume/)).toMatchObject({ value: 'C:/resumes/sam.pdf', source: 'file' })
    expect(by(/^Do you require visa sponsorship/).value).toBe('No')
    expect(by(/working in-person/)).toMatchObject({ value: 'Yes', source: 'ai' })
    expect(by(/interviewed at Anthropic before/)).toMatchObject({ needsUser: true })
    expect(by(/AI Policy/)).toMatchObject({ needsUser: true })
    expect(by(/Agreement to Arbitrate/)).toMatchObject({ needsUser: true })

    const why = by(/^Why Anthropic/)
    expect(why.source).toBe('ai')
    expect(why.value).toContain('Ledgerly')
    expect(why.lint?.score).toBeGreaterThan(70)
  })

  it('keeps AI-policy and legal questions flagged when the user clicks Regenerate', async () => {
    const fields = greenhouseFields(fixture as never).filter((f) => /AI Policy|Arbitrate/.test(f.label))
    const job = { id: 'j1', company: 'Anthropic', title: 'Engineer', location: null, description: '', fit: null, source: 'greenhouse' as const }
    const { answers, costUsd } = await answerFields(await deps(), job, fields, null, { regenerateKeys: new Set(fields.map((f) => f.key)) })
    expect(answers.every((a) => a.needsUser && a.value === '')).toBe(true)
    expect(costUsd).toBe(0)
  })
})
