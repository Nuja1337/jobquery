import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FormField, Profile, Settings } from '@shared/types'
import { Db } from '../db/database'
import { ProvidersRepo } from '../db/repos/providers'
import { SettingsRepo } from '../db/repos/settings'
import { LlmService } from '../llm/service'
import type { LlmClient, LlmRequest } from '../llm/types'
import { testVault } from '../secrets'
import { ingestRaw } from '../pipeline/ingest'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { answerFields, COVER_LETTER_PDF, GENERIC_QUESTION, isGenericQuestion, type SavedAnswer } from './answers'
import type { BrowserManager } from './browser'
import { draftApplication } from './prepare'

const usage = { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }
const WRITTEN = 'At Ledgerly I rebuilt billing after a double-charge weekend. The retry fix cut failed payments by 40 percent, and I wrote the nightly check that still runs.'
const ADAPTED = 'I like building payment tools, and Acme builds them. At Ledgerly I rebuilt billing after a double-charge weekend and cut failed payments by 40 percent.'
const LETTER = 'Hi Acme team,\n\nLast spring I rebuilt the billing pipeline at Ledgerly after it double-charged about 300 customers in one weekend. The fix took three weeks, and most of that went into the nightly reconciliation job.\n\nYour posting mentions payment tools. I have spent four years on that kind of work.\n\nThanks,\nSam'

const profile: Profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  experience: [{ company: 'Ledgerly', title: 'Senior Engineer', start: '2021', end: 'present', highlights: ['Rebuilt billing after a double-charge incident'] }]
}

const job = { id: 'j1', company: 'Acme', title: 'Platform Engineer', location: 'Remote', description: 'We build payment tools.', fit: null, source: 'greenhouse' as const }

const field = (key: string, label: string, extra: Partial<FormField> = {}): FormField => ({
  key,
  label,
  type: 'textarea',
  required: false,
  options: [],
  placeholder: null,
  maxLength: null,
  fileHint: null,
  ...extra
})

interface Seen {
  kind: 'json' | 'text'
  req: LlmRequest
}

async function setup(options: { saved?: Record<string, SavedAnswer>; writing?: Partial<Settings['writing']>; adapted?: string } = {}) {
  const seen: Seen[] = []
  const used: string[] = []
  const client: LlmClient = {
    kind: 'anthropic',
    async complete(model, req) {
      seen.push({ kind: 'text', req })
      return { text: WRITTEN, usage, model, truncated: false }
    },
    async completeJson(model, req, schema) {
      seen.push({ kind: 'json', req })
      const keys = [...req.prompt.matchAll(/^QUESTION (q\d+)$/gm)].map((m) => m[1])
      // The saved answer for a general question comes back adapted. Other questions get a plain answer.
      const answers = keys.map((key) => {
        const block = req.prompt.split(`QUESTION ${key}\n`)[1].split('\n\nQUESTION')[0]
        return { key, answer: block.includes('Base answer') ? (options.adapted ?? ADAPTED) : WRITTEN }
      })
      const raw = req.prompt.includes('COVER LETTER\n') ? { answers, letter: LETTER } : { answers }
      return { text: '', value: schema.parse(raw), usage, model, truncated: false }
    },
    async listModels() {
      return []
    }
  }
  const db = await Db.open(null)
  const settings = new SettingsRepo(db)
  const providers = new ProvidersRepo(db, testVault)
  await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
  const llm = new LlmService(db, settings, providers, () => client)
  const deps = {
    llm,
    settings: { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, minLintScore: 0, ...options.writing } },
    profile,
    samples: [],
    findSavedAnswer: (question: string) => Object.entries(options.saved ?? {}).find(([needle]) => question.includes(needle))?.[1] ?? null,
    markAnswerUsed: (id: string) => void used.push(id),
    resumePath: null
  }
  return { deps, seen, used }
}

const saved = (answer: string, kind: SavedAnswer['kind'] = 'fact'): SavedAnswer => ({ id: `saved-${answer.slice(0, 6)}`, answer, kind })

describe('answerFields writes open questions together', () => {
  it('sends three open questions in one call', async () => {
    const env = await setup()
    const fields = [field('a', 'Describe a hard bug you fixed.'), field('b', 'What would you build first here?'), field('c', 'Tell us about a time you disagreed with a teammate.')]
    const { answers } = await answerFields(env.deps, job, fields, null)
    expect(env.seen).toHaveLength(1)
    expect(env.seen[0].kind).toBe('json')
    expect(answers.map((a) => a.value)).toEqual([WRITTEN, WRITTEN, WRITTEN])
    expect(answers.every((a) => a.source === 'ai' && a.lint)).toBe(true)
  })

  it('never sends a question that must go to the user', async () => {
    const env = await setup()
    const fields = [field('a', 'Describe a hard bug you fixed.'), field('b', 'Did you use AI to write this application?', { required: true }), field('c', 'What would you build first here?')]
    const { answers } = await answerFields(env.deps, job, fields, null)
    expect(env.seen).toHaveLength(1)
    expect(env.seen[0].req.prompt).not.toContain('Did you use AI')
    expect(answers[1]).toMatchObject({ needsUser: true, value: '' })
  })
})

describe('saved answers to general questions', () => {
  const why = field('why', 'Why do you want to work at Acme?', { required: true })
  const other = field('bug', 'Describe a hard bug you fixed.')

  it('recognizes the general questions and not the factual ones', () => {
    expect(GENERIC_QUESTION.length).toBeGreaterThan(3)
    for (const label of ['Why do you want to work here?', 'Why are you interested in this role?', 'Tell us about yourself', 'What are your greatest strengths?', 'Describe a project you are proud of', 'What excites you about this role?']) {
      expect(isGenericQuestion(label), label).toBe(true)
    }
    for (const label of ['What are your salary expectations?', 'Are you legally authorized to work in the US?', 'Did you use AI to write this?', 'How did you hear about us?']) {
      expect(isGenericQuestion(label), label).toBe(false)
    }
  })

  it('adapts the saved answer to the company and keeps the answer bank as its source', async () => {
    const env = await setup({ saved: { 'Why do you want': saved('I like payment tools and I have built them for four years at Ledgerly.') } })
    const { answers } = await answerFields(env.deps, job, [why, other], null)
    expect(env.seen).toHaveLength(1)
    const prompt = env.seen[0].req.prompt
    expect(prompt).toContain('I like payment tools and I have built them for four years at Ledgerly.')
    expect(prompt).toContain('a base answer written by the person; keep its facts and wording, adapt one or two sentences to this company and role')
    expect(answers[0]).toMatchObject({ value: ADAPTED, source: 'answer_bank', note: 'Adapted from your saved answer.' })
    expect(answers[0].lint).not.toBeNull()
    expect(answers[1]).toMatchObject({ value: WRITTEN, source: 'ai', note: null })
    expect(env.used).toEqual([saved('I like payment tools and I have built them for four years at Ledgerly.').id])
  })

  it('pastes the saved answer as it is when the setting is off', async () => {
    const env = await setup({ saved: { 'Why do you want': saved('My own words.') }, writing: { adaptSavedAnswers: false } })
    const { answers } = await answerFields(env.deps, job, [why, other], null)
    expect(answers[0]).toMatchObject({ value: 'My own words.', source: 'answer_bank', note: null })
    expect(env.seen.every((s) => !s.req.prompt.includes('My own words.'))).toBe(true)
  })

  it('uses a factual saved answer as it is and never sends it to the model', async () => {
    const env = await setup({ saved: { 'favorite programming language': saved('TypeScript.'), 'Did you use AI': saved('No, I wrote every word.') } })
    const fields = [field('n', 'What is your favorite programming language?', { type: 'text', required: true }), field('ai', 'Did you use AI to write this application?', { required: true })]
    const { answers, costUsd } = await answerFields(env.deps, job, fields, null)
    expect(env.seen).toHaveLength(0)
    expect(costUsd).toBe(0)
    expect(answers[0]).toMatchObject({ value: 'TypeScript.', source: 'answer_bank' })
    expect(answers[1]).toMatchObject({ value: 'No, I wrote every word.', source: 'answer_bank' })
  })

  it('falls back to the saved answer when the model says it needs input', async () => {
    const env = await setup({ saved: { 'Why do you want': saved('My own words.') }, adapted: 'NEEDS_INPUT: why Acme' })
    const { answers } = await answerFields(env.deps, job, [why, other], null)
    expect(answers[0]).toMatchObject({ value: 'My own words.', source: 'answer_bank', needsUser: false })
  })

  it('still adapts a saved template, as before, with the usual source', async () => {
    const env = await setup({ saved: { 'Why do you want': saved('A template about payments.', 'template') } })
    const { answers } = await answerFields(env.deps, job, [why, other], null)
    expect(env.seen[0].req.prompt).toContain('A template about payments.')
    expect(answers[0].source).toBe('ai')
  })
})

describe('cover letter fields', () => {
  const upload = (required: boolean) => field('cl', 'Cover Letter', { type: 'file', fileHint: 'cover_letter', required })
  const questions = [field('a', 'Describe a hard bug you fixed.'), field('b', 'What would you build first here?')]

  it('writes a required letter in the same call as the answers', async () => {
    const env = await setup()
    const { answers, letter, costUsd } = await answerFields(env.deps, job, [...questions, upload(true)], null, { writeCoverLetter: true })
    expect(env.seen).toHaveLength(1)
    expect(env.seen[0].req.prompt).toContain('COVER LETTER')
    expect(letter?.text).toBe(LETTER)
    expect(costUsd).toBeGreaterThan(0)
    expect(answers[2]).toMatchObject({ value: COVER_LETTER_PDF, source: 'file' })
  })

  it('fills a cover letter text box with the letter', async () => {
    const env = await setup()
    const box = field('cl', 'Cover letter', { required: true })
    const { answers } = await answerFields(env.deps, job, [...questions, box], null, { writeCoverLetter: true })
    expect(env.seen).toHaveLength(1)
    expect(answers[2]).toMatchObject({ value: LETTER, needsUser: false })
  })

  it('writes the letter on its own when no question is open', async () => {
    const env = await setup()
    const { letter } = await answerFields(env.deps, job, [upload(true)], null, { writeCoverLetter: true })
    expect(env.seen.map((s) => s.kind)).toEqual(['text'])
    expect(letter).not.toBeNull()
  })

  it('leaves an optional cover letter blank and does not flag it', async () => {
    const env = await setup()
    const box = field('clb', 'Cover letter (optional)')
    const { answers, letter } = await answerFields(env.deps, job, [upload(false), box], null)
    expect(env.seen).toHaveLength(0)
    expect(letter).toBeNull()
    expect(answers[0]).toMatchObject({ value: '', needsUser: false })
    expect(answers[1]).toMatchObject({ value: '', needsUser: false })
  })

  it('uses a letter that already exists and writes nothing', async () => {
    const env = await setup()
    const { answers } = await answerFields(env.deps, job, [upload(true)], LETTER, { writeCoverLetter: true })
    expect(env.seen).toHaveLength(0)
    expect(answers[0].value).toBe(COVER_LETTER_PDF)
  })
})

describe('draftApplication', () => {
  it('writes no letter when the form could not be read ahead of time, leaving it to the live fill', async () => {
    const env = await makeTestEnv()
    env.ctx.profile.save(makeProfile())
    const j = ingestRaw(env.ctx, makeRaw({ externalId: 'x', source: 'lever', ats: 'lever', url: 'https://jobs.lever.co/acme/1' })).job
    const browser = {
      headlessPage: async () => {
        throw new Error('no browser here')
      }
    } as unknown as BrowserManager
    const deps = {
      llm: env.ctx.llm,
      browser,
      settings: env.ctx.settings.get(),
      profile: env.ctx.profile.get().profile,
      samples: [],
      findSavedAnswer: () => null,
      markAnswerUsed: () => {},
      resumePath: null
    }
    const draft = await draftApplication(deps, j)
    expect(draft.formSource).toBe('none')
    expect(draft.coverLetter).toBeNull()
    expect(env.llmCalls).toHaveLength(0)
  })
})
