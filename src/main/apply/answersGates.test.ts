import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import { isGuess } from '@shared/answers'
import type { FormField } from '@shared/types'
import type { LlmService } from '../llm/service'
import { blockingIssues, lintText } from '../writing/lint'
import { coverLetterLintOptions } from '../writing/generate'
import { answerFields, companiesToCheck, COVER_LETTER_PDF, otherCompanyNamed, type AnswerDeps, type SavedAnswer } from './answers'

// Writing gates: a text with a template tell never reaches the confidence of a passing text.

const GOOD = 'I rebuilt the billing system at Ledgerly after a weekend of double charges. The retry fix cut failed payments by 40 percent, and I wrote the nightly check that still runs.'
const GOOD_2 = 'At Ledgerly I moved invoicing off a monolith over six months. The old system kept running the whole time, which shaped how I split the services.'
const OPENER = 'I am writing to express my interest in this role. '
const SCORE_88 = `${OPENER}${GOOD}`
const PASSIONATE = `${GOOD} I am passionate about payment systems.`

const LETTER_BODY = `Last spring I rebuilt the billing pipeline at Ledgerly after it double-charged about 300 customers in one weekend. The fix took three weeks. Most of that time went into the reconciliation job that now runs every night and pages me if totals drift by more than a cent.

Your posting mentions moving invoicing off a monolith. I did the same move at Ledgerly in 2024, splitting invoices, payments and dunning into separate services over about six months while the old system kept running. We cut failed payment retries by 40 percent along the way, mostly by fixing how retries were scheduled.

I would like to hear how far along your migration is and where you expect the hard parts to be. I can talk any time next week.

Thanks,
Sam`
const GOOD_LETTER = `Hi Acme team,\n\n${LETTER_BODY}`
const OPENER_LETTER = `Hi Acme team,\n\nI am writing to express my interest in the Platform Engineer role. ${LETTER_BODY}`

const field = (label: string, over: Partial<FormField> = {}): FormField => ({
  key: label,
  label,
  type: 'textarea',
  required: true,
  options: [],
  placeholder: null,
  maxLength: null,
  fileHint: null,
  ...over
})

interface Calls {
  json: Array<{ task: string; prompt: string }>
  text: Array<{ task: string; prompt: string }>
}

/** A stand-in model. `first` is the draft for each question key, `revise` the reply to a revision. */
function stubLlm(opts: { first: (key: string) => string; revise: (key: string) => string; letter?: string; reviseLetter?: string }) {
  const calls: Calls = { json: [], text: [] }
  const llm = {
    async json(req: { task: string; prompt: string }) {
      calls.json.push({ task: req.task, prompt: req.prompt })
      if (req.task === 'revise') {
        const ids = [...req.prompt.matchAll(/^DRAFT (\S+)$/gm)].map((m) => m[1])
        return { value: { answers: ids.map((key) => ({ key, answer: key === 'letter' ? (opts.reviseLetter ?? GOOD_LETTER) : opts.revise(key) })) }, costUsd: 0.001 }
      }
      const keys = [...req.prompt.matchAll(/^QUESTION (q\d+)$/gm)].map((m) => m[1])
      return { value: { answers: keys.map((key) => ({ key, answer: opts.first(key) })), letter: opts.letter ?? null }, costUsd: 0.001 }
    },
    async text(req: { task: string; prompt: string }) {
      calls.text.push({ task: req.task, prompt: req.prompt })
      if (req.task === 'cover_letter') return { value: opts.letter ?? GOOD_LETTER, costUsd: 0.001 }
      if (req.task === 'revise') return { value: opts.reviseLetter ?? GOOD_LETTER, costUsd: 0.001 }
      return { value: opts.first('single'), costUsd: 0.001 }
    }
  }
  return { llm: llm as unknown as LlmService, calls }
}

const job = { id: 'j1', company: 'Acme', title: 'Platform Engineer', location: null, description: 'We build payment tools.', fit: null, source: 'greenhouse' as const }

function makeDeps(llm: LlmService, extra: Partial<AnswerDeps> = {}, writing: Partial<typeof DEFAULT_SETTINGS.writing> = {}): AnswerDeps {
  return {
    llm,
    settings: { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, coverLetterLength: 'short', minLintScore: 80, maxRevisions: 2, ...writing } },
    profile: EMPTY_PROFILE,
    samples: [],
    findSavedAnswer: () => null,
    markAnswerUsed: () => {},
    resumePath: null,
    ...extra
  }
}

describe('the sample drafts', () => {
  it('score high enough to pass on score alone and are held only by the blocking rule', () => {
    const report = lintText(SCORE_88)
    expect(report.score).toBeGreaterThanOrEqual(80)
    expect(blockingIssues(report).map((i) => i.rule)).toContain('phrase:i am writing to express my interest')
    const letter = lintText(OPENER_LETTER, coverLetterLintOptions(makeDeps(stubLlm({ first: () => '', revise: () => '' }).llm)))
    expect(letter.score).toBeGreaterThanOrEqual(80)
    expect(blockingIssues(letter).length).toBeGreaterThan(0)
  })
})

describe('open answers', () => {
  const two = [field('Tell us about a project you shipped'), field('Describe a hard bug you fixed')]

  it('revises a template opener and then sends the revision at 0.85', async () => {
    const { llm, calls } = stubLlm({ first: () => SCORE_88, revise: (key) => (key === 'q1' ? GOOD : GOOD_2) })
    const { answers } = await answerFields(makeDeps(llm), job, two, null)
    expect(calls.json.filter((c) => c.task === 'revise')).toHaveLength(1)
    expect(answers.map((a) => a.value)).toEqual([GOOD, GOOD_2])
    for (const a of answers) {
      expect(a.confidence).toBe(0.85)
      expect(blockingIssues(a.lint!)).toEqual([])
    }
  })

  it('never reaches 0.85 when the revisions still carry a template phrase', async () => {
    const { llm, calls } = stubLlm({ first: () => PASSIONATE, revise: () => PASSIONATE })
    const { answers } = await answerFields(makeDeps(llm), job, two, null)
    expect(calls.json.filter((c) => c.task === 'revise').length).toBeGreaterThanOrEqual(1)
    for (const a of answers) {
      expect(a.confidence).toBe(0.6)
      expect(a.note).toMatch(/style check/)
      expect(blockingIssues(a.lint!).length).toBeGreaterThan(0)
      // Auto mode never sends a guess.
      expect(isGuess(a)).toBe(true)
    }
  })

  it('does not revise a passing answer', async () => {
    const { llm, calls } = stubLlm({ first: (key) => (key === 'q1' ? GOOD : GOOD_2), revise: () => '' })
    const { answers } = await answerFields(makeDeps(llm), job, two, null)
    expect(calls.json.filter((c) => c.task === 'revise')).toHaveLength(0)
    expect(answers.map((a) => a.confidence)).toEqual([0.85, 0.85])
  })

  it.each([
    ['a placeholder', `${GOOD} I would like to work at [Company Name].`],
    ['markdown', `${GOOD}\n\n- I shipped the retry fix\n- I wrote the nightly check`],
    ['a contrast formula', `${GOOD} It is not only about the code but about the people.`]
  ])('holds back an answer with %s that the revisions do not remove', async (_name, draft) => {
    const { llm } = stubLlm({ first: () => draft, revise: () => draft })
    const { answers } = await answerFields(makeDeps(llm), job, two, null)
    for (const a of answers) expect(a.confidence).toBeLessThan(0.85)
  })

  it('removes an em dash without a model call when revisions are off, and then passes', async () => {
    const dashed = `${GOOD} The fix was small — a single flag — and it held.`
    const { llm } = stubLlm({ first: () => dashed, revise: () => dashed })
    const { answers } = await answerFields(makeDeps(llm, {}, { maxRevisions: 0 }), job, two, null)
    for (const a of answers) {
      expect(a.value).not.toContain('—')
      expect(a.confidence).toBe(0.85)
    }
  })
})

describe('a cover letter in a text field', () => {
  const letterField = field('Cover letter', { key: 'cover_letter' })

  it('revises a template opener and sends the revision at 0.9 with its check attached', async () => {
    const { llm, calls } = stubLlm({ first: () => '', revise: () => '', letter: OPENER_LETTER, reviseLetter: GOOD_LETTER })
    const { answers, letter } = await answerFields(makeDeps(llm), job, [letterField], null, { writeCoverLetter: true })
    expect(calls.text.filter((c) => c.task === 'revise')).toHaveLength(1)
    expect(letter?.text).toBe(GOOD_LETTER)
    expect(answers[0]).toMatchObject({ value: GOOD_LETTER, confidence: 0.9, source: 'ai' })
    expect(answers[0].lint).not.toBeNull()
    expect(blockingIssues(answers[0].lint!)).toEqual([])
  })

  it('drops to 0.6 with the check attached when the letter still fails', async () => {
    const { llm } = stubLlm({ first: () => '', revise: () => '', letter: OPENER_LETTER, reviseLetter: OPENER_LETTER })
    const { answers, letter } = await answerFields(makeDeps(llm), job, [letterField], null, { writeCoverLetter: true })
    expect(blockingIssues(letter!.lint).length).toBeGreaterThan(0)
    expect(answers[0].confidence).toBe(0.6)
    expect(answers[0].lint).not.toBeNull()
    expect(answers[0].note).toMatch(/held back by the style check/)
    expect(isGuess(answers[0])).toBe(true)
  })

  it('checks a letter that was handed in', async () => {
    const { llm } = stubLlm({ first: () => '', revise: () => '' })
    const ok = await answerFields(makeDeps(llm), job, [letterField], GOOD_LETTER)
    expect(ok.answers[0]).toMatchObject({ confidence: 0.9 })
    const held = await answerFields(makeDeps(llm), job, [letterField], OPENER_LETTER)
    expect(held.answers[0]).toMatchObject({ confidence: 0.6 })
  })

  it('attaches an upload either way, and leaves the hold to the application status', async () => {
    const upload = field('Cover letter', { key: 'cover_letter_file', type: 'file', fileHint: 'cover_letter' })
    const { llm } = stubLlm({ first: () => '', revise: () => '', letter: OPENER_LETTER, reviseLetter: OPENER_LETTER })
    const { answers, letter } = await answerFields(makeDeps(llm), job, [upload], null, { writeCoverLetter: true })
    expect(answers[0].value).toBe(COVER_LETTER_PDF)
    expect(blockingIssues(letter!.lint).length).toBeGreaterThan(0)
  })
})

describe('saved answers that name another company', () => {
  const saved: SavedAnswer = { id: 's1', answer: 'At Riot Games I fixed a netcode desync by replaying the match from the server log. That bug taught me to log first.', kind: 'fact' }
  const bug = field('Describe a hard bug you fixed')

  function deps(company: string, extra: Partial<AnswerDeps> = {}) {
    const used: string[] = []
    const { llm } = stubLlm({ first: () => GOOD, revise: () => GOOD })
    const d = makeDeps(llm, { findSavedAnswer: () => saved, markAnswerUsed: (id) => used.push(id), otherCompanies: () => ['Riot Games, Inc.', 'Valve Corporation', company], ...extra })
    return { d, used }
  }

  it('flags a Riot answer on a Valve job and does not mark it used', async () => {
    const { d, used } = deps('Valve')
    const { answers } = await answerFields(d, { ...job, company: 'Valve' }, [bug], null)
    expect(answers[0]).toMatchObject({ needsUser: true, source: 'answer_bank', value: saved.answer })
    expect(answers[0].note).toContain('Riot Games')
    expect(used).toEqual([])
  })

  it('reuses it as it is at the company it names', async () => {
    const { d, used } = deps('Riot Games')
    const { answers } = await answerFields(d, { ...job, company: 'Riot Games' }, [bug], null)
    expect(answers[0]).toMatchObject({ needsUser: false, value: saved.answer, confidence: 0.9 })
    expect(used).toEqual(['s1'])
  })

  it('leaves an optional question blank', async () => {
    const { d } = deps('Valve')
    const { answers } = await answerFields(d, { ...job, company: 'Valve' }, [{ ...bug, required: false }], null)
    expect(answers[0]).toMatchObject({ value: '', needsUser: false })
    expect(answers[0].note).toContain('Riot Games')
  })

  it('reuses it when it names no other company, or when no company list is given', async () => {
    const plain: SavedAnswer = { id: 's2', answer: 'I fixed a desync by replaying the match from the server log.', kind: 'fact' }
    const { d } = deps('Valve', { findSavedAnswer: () => plain })
    expect((await answerFields(d, { ...job, company: 'Valve' }, [bug], null)).answers[0]).toMatchObject({ value: plain.answer, needsUser: false })
    const { d: none } = deps('Valve', { otherCompanies: undefined })
    expect((await answerFields(none, { ...job, company: 'Valve' }, [bug], null)).answers[0]).toMatchObject({ value: saved.answer, needsUser: false })
  })

  it('flags an adapted answer that still names the other company', async () => {
    const generic = field('Why do you want to work here?')
    const stays = `Riot Games taught me to log first, and Valve needs that. ${GOOD}`
    const { llm } = stubLlm({ first: () => stays, revise: () => stays })
    const d = makeDeps(llm, { findSavedAnswer: () => saved, otherCompanies: () => ['Riot Games'] })
    const two = [generic, field('Tell us about a project you are proud of')]
    const { answers } = await answerFields(d, { ...job, company: 'Valve' }, two, null)
    expect(answers[0]).toMatchObject({ needsUser: true })
    expect(answers[0].note).toContain('Riot Games')
  })
})

describe('otherCompanyNamed', () => {
  it('matches a name with or without its generic last word and legal suffix', () => {
    expect(otherCompanyNamed('I loved my time at Riot.', 'Valve', ['Riot Games, Inc.'])).toBe('Riot Games, Inc.')
    expect(otherCompanyNamed("Riot Games' netcode taught me a lot.", 'Valve', ['Riot Games'])).toBe('Riot Games')
  })

  it('ignores the job company, a company that shares its name and words that only contain a name', () => {
    expect(otherCompanyNamed('I want to work at Valve.', 'Valve Corporation', ['Valve'])).toBeNull()
    expect(otherCompanyNamed('Riot answered fast.', 'Riot Games', ['Riot'])).toBeNull()
    expect(otherCompanyNamed('I like metadata tools.', 'Valve', ['Meta'])).toBeNull()
  })
})

describe('names the owner uses for themselves', () => {
  const profile = {
    ...EMPTY_PROFILE,
    skills: ['Unity', 'C++'],
    experience: [{ company: 'Amazon', title: 'Engineer', start: '2019', end: '2022', highlights: [] }]
  }
  const applied = ['Unity Technologies', 'Amazon.com, Inc.', 'Amazon', 'Epic Games', 'Riot Games']
  // The check the app runs: the owner's own names come off the list, then the answer is searched for the rest.
  const check = (text: string, company: string) => otherCompanyNamed(text, company, companiesToCheck(applied, profile))

  it('drops a tool or a past employer from the companies to check', () => {
    expect(companiesToCheck(applied, profile)).toEqual(['Epic Games', 'Riot Games'])
  })

  it('does not flag "Unity" for a Unity Technologies application when Unity is a skill', () => {
    expect(check('I shipped two games in Unity.', 'Unity Technologies')).toBeNull()
    expect(check('I shipped two games in Unity.', 'Valve')).toBeNull()
  })

  it('does not flag a past employer', () => {
    expect(check('At Amazon I built the order pipeline, and my years at Amazon taught me to log first.', 'Valve')).toBeNull()
  })

  it('does not flag a lower-case common word that is also a company name', () => {
    expect(check('The best part was an epic boss fight that I scripted.', 'Valve')).toBeNull()
    // The bare word is a game engine's name too, and a one-word name at the start of a sentence never counts. The full name does.
    expect(check('Epic shaped how I think about engines.', 'Valve')).toBeNull()
    expect(check('Epic Games shaped how I think about engines.', 'Valve')).toBe('Epic Games')
  })

  it('still flags another studio', () => {
    expect(check("I love Riot's culture.", 'Valve')).toBe('Riot Games')
  })
})
