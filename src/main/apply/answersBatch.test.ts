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

/** Open boxes that are optional stay blank, so the tests that need written answers make them required. */
const req = { required: true }

interface Seen {
  kind: 'json' | 'text'
  req: LlmRequest
}

interface SetupOptions {
  saved?: Record<string, SavedAnswer>
  writing?: Partial<Settings['writing']>
  adapted?: string
  /** What the batch call and the single call write for a plain question. */
  answer?: string
  letter?: string
  /** What the revision call returns for each draft id. */
  revise?: (id: string) => string | undefined
  /** What the short-field call returns. */
  form?: Array<{ key: string; value: string; confidence: number; needsUser: boolean; note: string }>
}

async function setup(options: SetupOptions = {}) {
  const seen: Seen[] = []
  const used: string[] = []
  const client: LlmClient = {
    kind: 'anthropic',
    async complete(model, req) {
      seen.push({ kind: 'text', req })
      return { text: options.answer ?? WRITTEN, usage, model, truncated: false }
    },
    async completeJson(model, req, schema, schemaName) {
      seen.push({ kind: 'json', req })
      if (schemaName === 'form_answers') return { text: '', value: schema.parse({ answers: options.form ?? [] }), usage, model, truncated: false }
      if (schemaName === 'revised_answers') {
        const ids = [...req.prompt.matchAll(/^DRAFT (\S+)/gm)].map((m) => m[1])
        const revised = ids.flatMap((key) => {
          const answer = options.revise?.(key)
          return answer === undefined ? [] : [{ key, answer }]
        })
        return { text: '', value: schema.parse({ answers: revised }), usage, model, truncated: false }
      }
      const keys = [...req.prompt.matchAll(/^QUESTION (q\d+)$/gm)].map((m) => m[1])
      // The saved answer for a general question comes back adapted. Other questions get a plain answer.
      const answers = keys.map((key) => {
        const block = req.prompt.split(`QUESTION ${key}\n`)[1].split('\n\nQUESTION')[0]
        return { key, answer: block.includes('Base answer') ? (options.adapted ?? ADAPTED) : (options.answer ?? WRITTEN) }
      })
      const raw = req.prompt.includes('COVER LETTER\n') ? { answers, letter: options.letter ?? LETTER } : { answers }
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
    const fields = [field('a', 'Describe a hard bug you fixed.', req), field('b', 'What would you build first here?', req), field('c', 'Tell us about a time you disagreed with a teammate.', req)]
    const { answers } = await answerFields(env.deps, job, fields, null)
    expect(env.seen).toHaveLength(1)
    expect(env.seen[0].kind).toBe('json')
    expect(answers.map((a) => a.value)).toEqual([WRITTEN, WRITTEN, WRITTEN])
    expect(answers.every((a) => a.source === 'ai' && a.lint)).toBe(true)
  })

  it('never sends a question that must go to the user', async () => {
    const env = await setup()
    const fields = [field('a', 'Describe a hard bug you fixed.', req), field('b', 'Did you use AI to write this application?', { required: true }), field('c', 'What would you build first here?', req)]
    const { answers } = await answerFields(env.deps, job, fields, null)
    expect(env.seen).toHaveLength(1)
    expect(env.seen[0].req.prompt).not.toContain('Did you use AI')
    expect(answers[1]).toMatchObject({ needsUser: true, value: '' })
  })
})

describe('saved answers to general questions', () => {
  const why = field('why', 'Why do you want to work at Acme?', { required: true })
  const other = field('bug', 'Describe a hard bug you fixed.', req)

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
  const questions = [field('a', 'Describe a hard bug you fixed.', req), field('b', 'What would you build first here?', req)]

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

describe('answers that fit their box', () => {
  const req = { required: true }
  const SENTENCES = [
    'At Ledgerly I rebuilt billing after a weekend of double charges.',
    'The retry fix cut failed payments by 40 percent across every region we sell in.',
    'I also wrote the nightly check that compares our ledger with the payment provider.',
    'It still runs today and pages the on-call engineer when totals drift by more than a cent.',
    'Before that I spent two years on the invoicing service and learned how finance teams close their books.',
    'That work shaped how I split services later, and it is why I like small, boring migrations.'
  ]
  const LONG = SENTENCES.join(' ')
  const two = (limit: number | null) => [field('a', 'Describe a hard bug you fixed.', { required: true, maxLength: limit }), field('b', 'What would you build first here?', req)]

  it('keeps a revision that fits the box even when it is much shorter than the draft', async () => {
    expect(LONG.length).toBeGreaterThan(400)
    const env = await setup({ answer: LONG, revise: (id) => (id === 'q1' ? WRITTEN : undefined), writing: { maxRevisions: 2 } })
    const { answers } = await answerFields(env.deps, job, two(200), null)
    expect(WRITTEN.length).toBeLessThan(200)
    expect(WRITTEN.length).toBeLessThan(LONG.length * 0.4)
    expect(answers[0].value).toBe(WRITTEN)
    expect(env.seen[1].req.prompt).toContain('Shorten to under 200 characters. Keep the sentence that answers the question.')
    expect(env.seen[1].req.prompt).toContain('Describe a hard bug you fixed.')
  })

  it('cuts a draft that stays too long at a sentence end, never mid-word', async () => {
    const env = await setup({ answer: LONG, writing: { maxRevisions: 1 } })
    const { answers } = await answerFields(env.deps, job, two(150), null)
    const value = answers[0].value
    expect(value.length).toBeLessThanOrEqual(150)
    expect(value).toMatch(/[.!?]$/)
    expect(LONG.startsWith(value)).toBe(true)
    expect(answers[0].needsUser).toBe(false)
  })

  it('flags the field instead of sending a fragment when not even one sentence fits', async () => {
    const env = await setup({ answer: LONG, writing: { maxRevisions: 1 } })
    const { answers } = await answerFields(env.deps, job, two(40), null)
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
    expect(answers[0].note).toContain('this box takes 40')
  })

  it('tells the writer the size of the box', async () => {
    const env = await setup()
    await answerFields(env.deps, job, two(300), null)
    const prompt = env.seen[0].req.prompt
    expect(prompt).toContain('About 46 words, under 270 characters.')
    // The question with a limit gets the size line. The one without keeps the usual range.
    const [limited, open] = prompt.split('QUESTION q2')
    expect(limited).not.toContain('60 to 150 words')
    expect(open).toContain('usually 60 to 150 words')
  })

  it('flags a model reply that says NEEDS INPUT in any spelling', async () => {
    const env = await setup({ answer: 'NEEDS INPUT: your visa status' })
    const { answers } = await answerFields(env.deps, job, two(null), null)
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
    expect(answers[0].note).toBe('Needs your input: your visa status')
  })

  it('shortens a saved answer that is too long to whole sentences and says so', async () => {
    const env = await setup({ saved: { 'favorite project': saved(LONG) } })
    const box = field('p', 'Tell us about your favorite project.', { type: 'text', required: true, maxLength: 150 })
    const { answers } = await answerFields(env.deps, job, [box], null)
    expect(answers[0].value.length).toBeLessThanOrEqual(150)
    expect(answers[0].value).toMatch(/[.!?]$/)
    expect(answers[0]).toMatchObject({ source: 'answer_bank', needsUser: false })
    expect(answers[0].note).toBe('Shortened to fit the 150 character limit.')
  })

  it('flags a saved answer when no whole sentence fits', async () => {
    const env = await setup({ saved: { 'favorite project': saved(LONG) } })
    const box = field('p', 'Tell us about your favorite project.', { type: 'text', required: true, maxLength: 30 })
    const { answers } = await answerFields(env.deps, job, [box], null)
    expect(answers[0]).toMatchObject({ value: '', needsUser: true, source: 'answer_bank' })
    expect(env.used).toEqual([])
  })

  it('flags a short model answer that is longer than its box', async () => {
    const env = await setup({ form: [{ key: 's', value: 'Senior Engineer', confidence: 0.9, needsUser: false, note: '' }] })
    const box = field('s', 'What is your favorite database?', { type: 'text', required: true, maxLength: 5 })
    const { answers } = await answerFields(env.deps, job, [box], null)
    expect(env.seen.some((s) => s.kind === 'json')).toBe(true)
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
  })
})

describe('optional open boxes', () => {
  const optional = field('add', 'Additional information')
  const anything = field('any', 'Anything else you would like us to know?')

  it('leaves them blank and makes no model call', async () => {
    const env = await setup()
    const { answers, costUsd } = await answerFields(env.deps, job, [optional, anything], null)
    expect(env.seen).toHaveLength(0)
    expect(costUsd).toBe(0)
    expect(answers.map((a) => a.value)).toEqual(['', ''])
    expect(answers.every((a) => !a.needsUser && a.note === 'Optional, so jobpls leaves it blank.')).toBe(true)
  })

  it('writes the required ones and skips the optional ones in the same form', async () => {
    const env = await setup()
    const required = field('why', 'Describe a hard bug you fixed.', { required: true })
    const { answers } = await answerFields(env.deps, job, [optional, required], null)
    expect(answers[0].value).toBe('')
    expect(answers[1].value).toBe(WRITTEN)
    expect(env.seen).toHaveLength(1)
    expect(env.seen[0].req.prompt).not.toContain('Additional information')
  })

  it('uses a saved answer that fits an optional box', async () => {
    const env = await setup({ saved: { 'Additional information': saved('I can start in two weeks.') } })
    const { answers } = await answerFields(env.deps, job, [optional], null)
    expect(answers[0]).toMatchObject({ value: 'I can start in two weeks.', source: 'answer_bank' })
    expect(env.seen).toHaveLength(0)
  })

  it('writes an optional box when the person presses Regenerate on it', async () => {
    const env = await setup()
    const { answers } = await answerFields(env.deps, job, [optional], null, { regenerateKeys: new Set(['add']) })
    expect(answers[0].value).toBe(WRITTEN)
  })

  it('leaves one-line catch-all boxes blank too', async () => {
    const env = await setup()
    const labels = ["Anything else you'd like us to know?", 'Additional information', 'Is there anything else we should know?', 'Other comments', 'Notes']
    const { answers } = await answerFields(env.deps, job, labels.map((l, i) => field(`c${i}`, l, { type: 'text' })), null)
    expect(env.seen).toHaveLength(0)
    expect(answers.every((a) => a.value === '' && !a.needsUser && a.note === 'Optional, so jobpls leaves it blank.')).toBe(true)
  })

  it('keeps required catch-all boxes on their usual path and short factual boxes untouched', async () => {
    const env = await setup({ form: [{ key: 'req', value: 'Nothing more.', confidence: 0.9, needsUser: false, note: '' }, { key: 'title', value: 'Engineer', confidence: 0.9, needsUser: false, note: '' }] })
    const { answers } = await answerFields(env.deps, job, [field('req', 'Additional information', { type: 'text', required: true }), field('title', 'What is your favorite database?', { type: 'text' })], null)
    expect(answers[0].value).toBe('Nothing more.')
    expect(answers[1].value).toBe('Engineer')
  })

  it('uses a saved answer for an optional one-line catch-all box', async () => {
    const env = await setup({ saved: { 'Additional information': saved('I can start in two weeks.') } })
    const { answers } = await answerFields(env.deps, job, [field('c', 'Additional information', { type: 'text' })], null)
    expect(answers[0]).toMatchObject({ value: 'I can start in two weeks.', source: 'answer_bank' })
  })

  it('keeps the cover letter rules for an optional letter box', async () => {
    const env = await setup()
    const box = field('clb', 'Cover letter (optional)')
    const { answers } = await answerFields(env.deps, job, [box], LETTER)
    expect(answers[0].value).toBe(LETTER)
  })
})

describe('cover letters in a box with a character limit', () => {
  const para = (n: number) => `Paragraph ${n} says that I rebuilt the billing pipeline at Ledgerly and cut failed payments by 40 percent over six months.`
  const SHORT_LETTER = `Hi Acme team,\n\nLast spring I rebuilt the billing pipeline at Ledgerly after it double-charged about 300 customers. The fix took three weeks.\n\nYour posting mentions payment tools. I have spent four years on that kind of work, and the last two were mostly migrations. The old system kept running the whole time, which taught me to split services in small steps.\n\nI would like to hear how far along your own migration is and where you expect the hard parts to be. I can talk any time next week.\n\nThanks,\nSam`
  const BIG_LETTER = `Hi Acme team,\n\n${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(para).join(' ')}\n\nThanks,\nSam`
  const box = (required: boolean, maxLength: number | null) => field('cl', 'Cover letter', { required, maxLength })
  const questions = [field('a', 'Describe a hard bug you fixed.', { required: true }), field('b', 'What would you build first here?', { required: true })]

  it('asks for a letter that fits a 1000 character box', async () => {
    expect(SHORT_LETTER.length).toBeLessThan(1000)
    const env = await setup({ letter: SHORT_LETTER })
    const { answers, letter } = await answerFields(env.deps, job, [...questions, box(true, 1000)], null, { writeCoverLetter: true })
    expect(env.seen[0].req.prompt).toContain('About 153 words, under 900 characters.')
    expect(letter?.text).toBe(SHORT_LETTER)
    expect(answers[2]).toMatchObject({ value: SHORT_LETTER, needsUser: false })
  })

  it('revises a letter that is too long for the box and keeps the one that fits', async () => {
    expect(BIG_LETTER.length).toBeGreaterThan(1000)
    const env = await setup({ letter: BIG_LETTER, revise: (id) => (id === 'letter' ? SHORT_LETTER : undefined), writing: { maxRevisions: 2 } })
    const { answers } = await answerFields(env.deps, job, [...questions, box(true, 1000)], null, { writeCoverLetter: true })
    expect(answers[2].value).toBe(SHORT_LETTER)
  })

  it('flags the box and never cuts the letter when it will not fit', async () => {
    const env = await setup({ letter: BIG_LETTER, writing: { maxRevisions: 1 } })
    const { answers, letter } = await answerFields(env.deps, job, [...questions, box(true, 1000)], null, { writeCoverLetter: true })
    expect(letter?.text).toBe(BIG_LETTER)
    expect(answers[2]).toMatchObject({ value: '', needsUser: true })
    expect(answers[2].note).toContain('this box takes 1000')
  })

  it('flags a box that is too small for a letter that already exists', async () => {
    const env = await setup()
    const { answers } = await answerFields(env.deps, job, [box(true, 500)], BIG_LETTER)
    expect(env.seen).toHaveLength(0)
    expect(answers[0]).toMatchObject({ value: '', needsUser: true })
  })

  it('leaves an optional box blank when the existing letter is too long for it', async () => {
    const env = await setup()
    const { answers } = await answerFields(env.deps, job, [box(false, 500)], BIG_LETTER)
    expect(answers[0]).toMatchObject({ value: '', needsUser: false })
    expect(answers[0].note).toContain('optional')
  })

  it('keeps the usual letter length for a box with no limit', async () => {
    const env = await setup()
    await answerFields(env.deps, job, [...questions, box(true, null)], null, { writeCoverLetter: true })
    expect(env.seen[0].req.prompt).toContain('Length: 200 to 300 words')
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
