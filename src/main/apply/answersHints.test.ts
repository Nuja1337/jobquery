import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FormField, Profile } from '@shared/types'
import { Db } from '../db/database'
import { ProvidersRepo } from '../db/repos/providers'
import { SettingsRepo } from '../db/repos/settings'
import { LlmService } from '../llm/service'
import type { LlmClient, LlmRequest } from '../llm/types'
import { testVault } from '../secrets'
import { answerFields } from './answers'

const usage = { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }
const WRITTEN = 'At Ledgerly I rebuilt billing after a double-charge weekend. The retry fix cut failed payments by 40 percent, and I wrote the nightly check that still runs.'
const LONG = `${WRITTEN} ${WRITTEN} ${WRITTEN} ${WRITTEN}`

const job = { id: 'j1', company: 'Acme', title: 'Platform Engineer', location: 'Remote', description: 'We build payment tools.', fit: null, source: 'greenhouse' as const }

const baseProfile: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  experience: [{ company: 'Ledgerly', title: 'Senior Engineer', start: '2021', end: 'present', highlights: ['Rebuilt billing after a double-charge incident'] }]
}
const withPortfolio: Profile = { ...baseProfile, links: { ...baseProfile.links, portfolio: 'https://sam.dev' } }

const field = (key: string, label: string, extra: Partial<FormField> = {}): FormField => ({
  key,
  label,
  type: 'textarea',
  required: true,
  options: [],
  placeholder: null,
  maxLength: null,
  fileHint: null,
  ...extra
})

async function setup(profile: Profile, answer = WRITTEN) {
  const seen: Array<{ kind: 'json' | 'text'; schemaName: string | null; req: LlmRequest }> = []
  const client: LlmClient = {
    kind: 'anthropic',
    async complete(model, req) {
      seen.push({ kind: 'text', schemaName: null, req })
      return { text: answer, usage, model, truncated: false }
    },
    async completeJson(model, req, schema, schemaName) {
      seen.push({ kind: 'json', schemaName, req })
      if (schemaName === 'form_answers') {
        const keys = [...req.prompt.matchAll(/"key":"([^"]+)"/g)].map((m) => m[1])
        return { text: '', value: schema.parse({ answers: keys.map((key) => ({ key, value: 'TypeScript', confidence: 0.9, needsUser: false, note: '' })) }), usage, model, truncated: false }
      }
      const keys = [...req.prompt.matchAll(/^QUESTION (q\d+)$/gm)].map((m) => m[1])
      return { text: '', value: schema.parse({ answers: keys.map((key) => ({ key, answer })) }), usage, model, truncated: false }
    },
    async listModels() {
      return []
    }
  }
  const db = await Db.open(null)
  const providers = new ProvidersRepo(db, testVault)
  await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
  const llm = new LlmService(db, new SettingsRepo(db), providers, () => client)
  const deps = {
    llm,
    settings: { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, minLintScore: 0 } },
    profile,
    samples: [],
    findSavedAnswer: () => null,
    markAnswerUsed: () => {},
    resumePath: null
  }
  return { deps, seen }
}

describe('answerFields with the form hint', () => {
  it('sends the hint, the required flag and the tighter limit to the writing model', async () => {
    const env = await setup(withPortfolio)
    const f = field('why', 'Why do you want to work at Acme?', { maxLength: 2000, hint: 'In 100 words or less' })
    const other = field('bug', 'Describe a hard bug you fixed.')
    await answerFields(env.deps, job, [f, other], null)
    const prompt = env.seen[0].req.prompt
    expect(prompt).toContain('In 100 words or less')
    expect(prompt).toContain('Required on the form.')
    expect(prompt).toContain('Hard limit: 600 characters')
  })

  it('cuts an answer that runs past the limit in the hint', async () => {
    const env = await setup(withPortfolio, LONG)
    const { answers } = await answerFields(env.deps, job, [field('why', 'Why Acme?', { maxLength: 2000, hint: 'Please answer in 100 words or less.' })], null)
    expect(answers[0].value.length).toBeLessThanOrEqual(600)
    expect(answers[0].value.endsWith('.')).toBe(true)
    expect(answers[0].needsUser).toBe(false)
  })

  it('puts the owner link into an answer when the hint asks for one', async () => {
    const env = await setup(withPortfolio)
    const { answers } = await answerFields(env.deps, job, [field('work', 'Tell us about your best work.', { hint: 'Include a link to your portfolio' })], null)
    expect(env.seen[0].req.prompt).toContain('written exactly like this: https://sam.dev')
    expect(answers[0].value).toBe(`${WRITTEN}\nhttps://sam.dev`)
    expect(answers[0].note).toContain('Added your link')
  })

  it('leaves the answer alone when the model already included the link', async () => {
    const env = await setup(withPortfolio, `${WRITTEN} My work is at sam.dev.`)
    const { answers } = await answerFields(env.deps, job, [field('work', 'Tell us about your best work.', { hint: 'Include a link to your portfolio' })], null)
    expect(answers[0].value).toBe(`${WRITTEN} My work is at sam.dev.`)
    expect(answers[0].note).toBeNull()
  })

  it('flags a required question that asks for a link the profile lacks, without calling the model', async () => {
    const env = await setup(baseProfile)
    const { answers } = await answerFields(env.deps, job, [field('work', 'Tell us about your best work.', { hint: 'Include a link to your portfolio' })], null)
    expect(env.seen).toHaveLength(0)
    expect(answers[0]).toMatchObject({ needsUser: true, value: '' })
    expect(answers[0].note).toContain('a link to your portfolio')
    expect(answers[0].note).toContain('your profile has none')
  })

  it('tells the model not to invent a link for an optional question the person asked to regenerate', async () => {
    const env = await setup(baseProfile)
    const f = field('work', 'Tell us about your best work.', { required: false, hint: 'Include a link to your portfolio' })
    const { answers } = await answerFields(env.deps, job, [f], null, { regenerateKeys: new Set(['work']) })
    expect(env.seen[0].req.prompt).toContain('has none on file. Do not write a link or a web address.')
    expect(answers[0].needsUser).toBe(false)
    expect(answers[0].value).toBe(WRITTEN)
  })

  it('does not treat a hint without a link request as one', async () => {
    const env = await setup(withPortfolio)
    const { answers } = await answerFields(env.deps, job, [field('why', 'Why Acme?', { hint: 'Answer in English' })], null)
    expect(env.seen[0].req.prompt).not.toContain('The form asks for a link')
    expect(answers[0].value).toBe(WRITTEN)
  })

  it('gives short fields their hint in the field list', async () => {
    const env = await setup(withPortfolio)
    await answerFields(env.deps, job, [field('lang', 'Favorite programming language?', { type: 'text', hint: 'Answer in English' })], null)
    const call = env.seen.find((s) => s.schemaName === 'form_answers')
    expect(call?.req.prompt).toContain('"hint":"Answer in English"')
    expect(call?.req.system).toContain('hint')
  })
})
