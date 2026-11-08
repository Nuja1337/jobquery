import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import { isGuess } from '@shared/answers'
import type { FormField, Profile } from '@shared/types'
import type { LlmService } from '../llm/service'
import { blockingIssues, groundingIssues } from '../writing/lint'
import { answerFields, COVER_LETTER_PDF, HELD_UPLOAD_NOTE, type AnswerDeps, type SavedAnswer } from './answers'
import profileFixture from '../writing/__fixtures__/profile.json'
import scopely from '../writing/__fixtures__/scopely-client-engineer.posting.json'

// A letter or an open answer that is less grounded goes out below the auto-send confidence, with a note that names why.

const profile: Profile = { ...EMPTY_PROFILE, ...(profileFixture as Partial<Profile>) }
const letterFile = (kind: 'generic' | 'grounded') => fs.readFileSync(fileURLToPath(new URL(`../writing/__fixtures__/letters/scopely-client-engineer.${kind}.txt`, import.meta.url)), 'utf8').trim()
const GENERIC = letterFile('generic')
const GROUNDED = letterFile('grounded')

const WHY_GENERIC = 'I like building games with a team that cares about the details, and I enjoy solving hard problems that players notice. The work looks like a good match for my background and my interests.'
const WHY_GROUNDED = 'At Hollow Lantern I added telemetry to a Unity client, so I know why monitoring and observability matter. Your unannounced Strategy/MMO needs the same signals from real players.'
const BUG = 'I once chased a crash that only happened on one old phone. I added logging first, then found a missing null check in the save code. The fix took an hour once I could see it.'

const job = { id: 'j1', company: scopely.company, title: scopely.title, location: null, description: scopely.text, fit: null, source: 'greenhouse' as const }

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

/** A stand-in model. `answers` is the draft for each question label, `letter` the first letter, `revised` what a revision returns. */
function stubLlm(opts: { answers?: Record<string, string>; revised?: Record<string, string>; letter?: string; reviseLetter?: string }) {
  const calls: Calls = { json: [], text: [] }
  const labelOf = (prompt: string, id: string) => prompt.split(`QUESTION ${id}\n"`)[1]?.split('"')[0] ?? ''
  const llm = {
    async json(req: { task: string; prompt: string }) {
      calls.json.push({ task: req.task, prompt: req.prompt })
      if (req.task === 'revise') {
        const ids = [...req.prompt.matchAll(/^DRAFT (\S+)$/gm)].map((m) => m[1])
        const pick = (id: string) => {
          if (id === 'letter') return opts.reviseLetter ?? GROUNDED
          const label = req.prompt.split(`DRAFT ${id}`)[1]?.split('QUESTION\n"')[1]?.split('"')[0] ?? ''
          return opts.revised?.[label] ?? opts.answers?.[label] ?? ''
        }
        return { value: { answers: ids.map((key) => ({ key, answer: pick(key) })) }, costUsd: 0.001 }
      }
      const keys = [...req.prompt.matchAll(/^QUESTION (q\d+)$/gm)].map((m) => m[1])
      return { value: { answers: keys.map((key) => ({ key, answer: opts.answers?.[labelOf(req.prompt, key)] ?? BUG })), letter: opts.letter ?? null }, costUsd: 0.001 }
    },
    async text(req: { task: string; prompt: string }) {
      calls.text.push({ task: req.task, prompt: req.prompt })
      const label = req.prompt.split('QUESTION\n"')[1]?.split('"')[0] ?? ''
      if (req.task === 'revise') return { value: label ? (opts.revised?.[label] ?? opts.answers?.[label] ?? BUG) : (opts.reviseLetter ?? GROUNDED), costUsd: 0.001 }
      if (req.task === 'cover_letter') return { value: opts.letter ?? GROUNDED, costUsd: 0.001 }
      return { value: opts.answers?.[label] ?? BUG, costUsd: 0.001 }
    }
  }
  return { llm: llm as unknown as LlmService, calls }
}

function makeDeps(llm: LlmService, extra: Partial<AnswerDeps> = {}): AnswerDeps {
  return {
    llm,
    settings: { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, coverLetterLength: 'medium', minLintScore: 80, maxRevisions: 2 } },
    profile,
    samples: [],
    findSavedAnswer: () => null,
    markAnswerUsed: () => {},
    resumePath: null,
    ...extra
  }
}

const NOTE = /^Not tied to the posting and the profile\. /
/** A letter that is less grounded is held like one the style check rejects. */
const HELD = /^The cover letter was held back by the style check. /

describe('a cover letter in a text field', () => {
  const box = field('Cover letter', { key: 'cover_letter' })

  it('drops a generic letter to 0.6, below the auto-send line, with a note that names the issue', async () => {
    const { llm, calls } = stubLlm({ letter: GENERIC, reviseLetter: GENERIC })
    const { answers, letter } = await answerFields(makeDeps(llm), job, [box], null, { writeCoverLetter: true })
    // It was sent back for a revision before it was given up.
    expect(calls.text.filter((c) => c.task === 'revise')).toHaveLength(2)
    expect(letter?.text).toBe(GENERIC)
    expect(answers[0]).toMatchObject({ value: GENERIC, confidence: 0.6, source: 'ai', needsUser: false })
    expect(answers[0].note).toMatch(HELD)
    expect(answers[0].note).toContain('It names no detail from the posting')
    expect(blockingIssues(answers[0].lint!)).toEqual([])
    expect(groundingIssues(answers[0].lint!).length).toBe(1)
    expect(isGuess(answers[0])).toBe(true)
  })

  it('sends the grounded revision at 0.9', async () => {
    const { llm, calls } = stubLlm({ letter: GENERIC, reviseLetter: GROUNDED })
    const { answers } = await answerFields(makeDeps(llm), job, [box], null, { writeCoverLetter: true })
    expect(calls.text.filter((c) => c.task === 'revise')).toHaveLength(1)
    expect(answers[0]).toMatchObject({ value: GROUNDED, confidence: 0.9, note: null })
    expect(isGuess(answers[0])).toBe(false)
  })

  it('keeps a grounded letter at 0.9 without a revision', async () => {
    const { llm, calls } = stubLlm({ letter: GROUNDED })
    const { answers } = await answerFields(makeDeps(llm), job, [box], null, { writeCoverLetter: true })
    expect(calls.text.filter((c) => c.task === 'revise')).toHaveLength(0)
    expect(answers[0]).toMatchObject({ confidence: 0.9, note: null })
  })

  it('checks a letter that was handed in', async () => {
    const { llm } = stubLlm({})
    const generic = await answerFields(makeDeps(llm), job, [box], GENERIC)
    expect(generic.answers[0]).toMatchObject({ value: GENERIC, confidence: 0.6 })
    expect(generic.answers[0].note).toMatch(HELD)
    const grounded = await answerFields(makeDeps(llm), job, [box], GROUNDED)
    expect(grounded.answers[0]).toMatchObject({ confidence: 0.9, note: null })
  })

  it('holds a letter with a style problem under the style note', async () => {
    const both = GENERIC.replace('Thanks,', 'I am passionate about games.\n\nThanks,')
    const { llm } = stubLlm({})
    const { answers } = await answerFields(makeDeps(llm), job, [box], both)
    expect(answers[0].confidence).toBe(0.6)
    expect(answers[0].note).toMatch(/^The cover letter was held back by the style check\./)
  })

  it('names a number the letter invented', async () => {
    const { llm } = stubLlm({})
    const { answers } = await answerFields(makeDeps(llm), job, [box], GROUNDED.replace('two days after', '87 days after'))
    expect(answers[0].confidence).toBe(0.6)
    expect(answers[0].note).toContain('The number 87 is in neither the profile nor the posting.')
  })

  it('leaves a required upload attached, so the application status holds it', async () => {
    const upload = field('Cover letter', { key: 'cover_letter_file', type: 'file', fileHint: 'cover_letter' })
    const { llm } = stubLlm({ letter: GENERIC, reviseLetter: GENERIC })
    const { answers, letter } = await answerFields(makeDeps(llm), job, [upload], null, { writeCoverLetter: true })
    expect(groundingIssues(letter!.lint).length).toBe(1)
    expect(answers[0]).toMatchObject({ value: COVER_LETTER_PDF, source: 'file', confidence: 1 })
  })

  it('leaves an optional upload empty with the held note, as for a letter the style check holds', async () => {
    const upload = field('Cover letter', { key: 'cover_letter_file', type: 'file', fileHint: 'cover_letter', required: false })
    const { llm } = stubLlm({})
    const { answers } = await answerFields(makeDeps(llm), job, [upload], GENERIC)
    expect(answers[0]).toMatchObject({ value: '', source: 'file', note: HELD_UPLOAD_NOTE })
    const ok = await answerFields(makeDeps(llm), job, [upload], GROUNDED)
    expect(ok.answers[0]).toMatchObject({ value: COVER_LETTER_PDF })
  })
})

describe('open answers', () => {
  const why = field('Why do you want to work at Scopely?')
  const bug = field('Describe a hard bug you fixed')

  it('holds a generic answer about the company at 0.6 and leaves a general answer at 0.85', async () => {
    const { llm } = stubLlm({ answers: { [why.label]: WHY_GENERIC, [bug.label]: BUG }, revised: { [why.label]: WHY_GENERIC } })
    const { answers } = await answerFields(makeDeps(llm), job, [why, bug], null)
    expect(answers[0]).toMatchObject({ value: WHY_GENERIC, confidence: 0.6, source: 'ai', needsUser: false })
    expect(answers[0].note).toMatch(NOTE)
    expect(isGuess(answers[0])).toBe(true)
    expect(answers[1]).toMatchObject({ value: BUG, confidence: 0.85, note: null })
  })

  it('revises the generic answer once and sends the grounded one at 0.85', async () => {
    const { llm, calls } = stubLlm({ answers: { [why.label]: WHY_GENERIC, [bug.label]: BUG }, revised: { [why.label]: WHY_GROUNDED } })
    const { answers } = await answerFields(makeDeps(llm), job, [why, bug], null)
    const revisions = calls.json.filter((c) => c.task === 'revise')
    expect(revisions).toHaveLength(1)
    expect(revisions[0].prompt).toContain('It names no detail from the posting')
    expect(revisions[0].prompt).toContain('DRAFT q1')
    expect(revisions[0].prompt).not.toContain('DRAFT q2')
    expect(answers[0]).toMatchObject({ value: WHY_GROUNDED, confidence: 0.85, note: null })
  })

  it('holds a general answer that invents a number or a name', async () => {
    const invented = `${BUG} It took 87 hours at Naughty Dog.`
    const { llm } = stubLlm({ answers: { [bug.label]: invented } })
    const { answers } = await answerFields(makeDeps(llm), job, [bug], null)
    expect(answers[0]).toMatchObject({ value: invented, confidence: 0.6 })
    expect(answers[0].note).toMatch(NOTE)
  })

  it('puts the style note and the grounding note on one answer', async () => {
    const both = `${WHY_GENERIC} I am passionate about games.`
    const { llm } = stubLlm({ answers: { [why.label]: both, [bug.label]: BUG }, revised: { [why.label]: both } })
    const { answers } = await answerFields(makeDeps(llm), job, [why, bug], null)
    expect(answers[0].confidence).toBe(0.6)
    expect(answers[0].note).toMatch(/^Held back by the style check. /)
    expect(answers[0].note).toContain('Not tied to the posting and the profile.')
  })

  it('does not hold an answer adapted from the person\'s saved one', async () => {
    const saved: SavedAnswer = { id: 's1', answer: 'I like payment tools.', kind: 'fact' }
    const adapted = 'I like payment tools. At Ledgerly I cut failed payments by 87 percent, which the team at Acme still relies on every single week.'
    const { llm } = stubLlm({ answers: { [why.label]: adapted } })
    const { answers } = await answerFields(makeDeps(llm, { findSavedAnswer: (q) => (q.includes('Why do you want') ? saved : null) }), job, [why, bug], null)
    expect(answers[0]).toMatchObject({ value: adapted, source: 'answer_bank', confidence: 0.85 })
    expect(groundingIssues(answers[0].lint!)).toEqual([])
  })
})
