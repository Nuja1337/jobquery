import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Profile } from '@shared/types'
import type { LlmService } from '../llm/service'
import { coverLetterLintOptions, writeAnswer, writeApplicationAnswers, writeCoverLetter, type BatchQuestion, type WritingInputs } from './generate'
import { allowedTermsFor, type JobForWriting } from './prompts'
import { blockingIssues, groundingIssues, GROUNDING_RULES, lintPasses, lintText } from './lint'
import profileFixture from './__fixtures__/profile.json'
import scopely from './__fixtures__/scopely-client-engineer.posting.json'

// Allowed terms and grounding reach every text written for a job: the prompt, the style check and the revision loop.

const profile: Profile = { ...EMPTY_PROFILE, ...(profileFixture as Partial<Profile>) }
const letterFile = (kind: 'generic' | 'grounded') => fs.readFileSync(fileURLToPath(new URL(`./__fixtures__/letters/scopely-client-engineer.${kind}.txt`, import.meta.url)), 'utf8').trim()
const GENERIC = letterFile('generic')
const GROUNDED = letterFile('grounded')

const settings = { ...DEFAULT_SETTINGS, writing: { ...DEFAULT_SETTINGS.writing, minLintScore: 80, maxRevisions: 2, coverLetterLength: 'medium' as const } }
const inputs: WritingInputs = { profile, samples: [], settings }

const scopelyJob: JobForWriting = { id: 'scopely', company: scopely.company, title: scopely.title, location: null, description: scopely.text, fit: null }

interface Seen {
  kind: 'text' | 'json'
  task: string
  system: string
  prompt: string
}

/** A stand-in model. `reply` answers by task, and `batch` answers the one JSON call that writes several texts. */
function stub(reply: (req: Seen, n: number) => string, batch: (req: Seen, n: number) => unknown = () => ({ answers: [] })) {
  const seen: Seen[] = []
  const llm = {
    async text(req: { task: string; system: string; prompt: string }) {
      seen.push({ kind: 'text', task: req.task, system: req.system, prompt: req.prompt })
      return { value: reply(seen[seen.length - 1], seen.length), costUsd: 0.001 }
    },
    async json(req: { task: string; system: string; prompt: string }) {
      seen.push({ kind: 'json', task: req.task, system: req.system, prompt: req.prompt })
      return { value: batch(seen[seen.length - 1], seen.length), costUsd: 0.001 }
    }
  }
  return { llm: llm as unknown as LlmService, seen }
}

const bannedList = (system: string) => system.split('Any of these words or phrases: ')[1]!.split('.\n')[0]!.split(', ')

describe('allowed terms follow the posting', () => {
  const TEXT =
    'Hi Mossbrook team,\n\nLast year I built a test harness for the combat code of a mobile shooter. It replayed recorded matches overnight and listed every desync in the morning. The first week it found nine bugs that testers had missed, and the team stopped dreading releases.\n\nThat is why your posting caught my eye. You want someone to own the harness and the unlock progression, and I like that kind of quiet work.\n\nThanks,\nMara'
  const withTerm: JobForWriting = {
    id: 'a',
    company: 'Mossbrook Games',
    title: 'Gameplay Programmer',
    location: null,
    description: 'You will build the test harness for our combat code and own unlock progression. Experience with C++ and Unreal helps.',
    fit: null
  }
  const without: JobForWriting = { ...withTerm, id: 'b', description: 'You will build tooling for our combat code and own the reward economy. Experience with C++ and Unreal helps.' }
  const phrases = (lint: { issues: Array<{ rule: string }> }) => [...new Set(lint.issues.map((i) => i.rule).filter((r) => r === 'phrase:harness'))]

  it('finds the term in one posting and not in the other', () => {
    expect(allowedTermsFor(withTerm, profile)).toContain('harness')
    expect(allowedTermsFor(without, profile)).not.toContain('harness')
  })

  it('leaves it unflagged in that job\'s cover letter, and flags it for a job whose posting lacks it', async () => {
    const a = stub(() => TEXT)
    const written = await writeCoverLetter(a.llm, inputs, withTerm)
    expect(phrases(written.lint)).toEqual([])
    expect(bannedList(a.seen[0].system)).not.toContain('harness')

    const b = stub(() => TEXT)
    const flagged = await writeCoverLetter(b.llm, inputs, without)
    expect(phrases(flagged.lint)).toEqual(['phrase:harness'])
    expect(bannedList(b.seen[0].system)).toContain('harness')
  })

  it('does the same for a single answer', async () => {
    const question = { label: 'Describe a project you are proud of', maxLength: null, long: true }
    const a = stub(() => TEXT.split('\n\n')[1])
    expect(phrases((await writeAnswer(a.llm, inputs, withTerm, question)).lint)).toEqual([])
    expect(bannedList(a.seen[0].system)).not.toContain('harness')
    const b = stub(() => TEXT.split('\n\n')[1])
    expect(phrases((await writeAnswer(b.llm, inputs, without, question)).lint)).toEqual(['phrase:harness'])
  })

  it('does the same for the answers and the letter written together', async () => {
    const questions: BatchQuestion[] = [
      { key: 'one', label: 'Describe a project you are proud of', maxLength: null, long: true },
      { key: 'two', label: 'Tell us about a tool you built', maxLength: null, long: true }
    ]
    const answer = TEXT.split('\n\n')[1]
    const reply = () => ({ answers: [{ key: 'q1', answer }, { key: 'q2', answer }], letter: TEXT })
    const a = stub(() => '', reply)
    const withResult = await writeApplicationAnswers(a.llm, inputs, withTerm, questions, { coverLetter: {} })
    expect(a.seen).toHaveLength(1)
    expect(bannedList(a.seen[0].system)).not.toContain('harness')
    for (const t of [withResult.answers.get('one')!, withResult.answers.get('two')!, withResult.letter!]) expect(phrases(t.lint)).toEqual([])

    const b = stub(() => '', reply)
    const withoutResult = await writeApplicationAnswers(b.llm, inputs, without, questions, { coverLetter: {} })
    for (const t of [withoutResult.answers.get('one')!, withoutResult.answers.get('two')!, withoutResult.letter!]) expect(phrases(t.lint)).toEqual(['phrase:harness'])
  })

  it('lets coverLetterLintOptions carry the terms to a letter the person edits', () => {
    const options = coverLetterLintOptions({ settings }, null, ['harness'])
    expect(phrases(lintText(TEXT, options))).toEqual([])
    expect(phrases(lintText(TEXT, coverLetterLintOptions({ settings })))).toEqual(['phrase:harness'])
  })
})

describe('the revision loop and grounding', () => {
  it('sends a generic letter back with the issue and the posting, and keeps the grounded revision', async () => {
    const env = stub((req) => (req.task === 'revise' ? GROUNDED : GENERIC))
    const written = await writeCoverLetter(env.llm, inputs, scopelyJob)
    expect(env.seen.map((s) => s.task)).toEqual(['cover_letter', 'revise'])
    expect(written).toMatchObject({ text: GROUNDED, revisions: 1 })
    expect(groundingIssues(written.lint)).toEqual([])
    const prompt = env.seen[1].prompt
    expect(prompt).toContain('It names no detail from the posting')
    expect(prompt).toContain('client-side monitoring, telemetry, observability')
    expect(prompt).toContain(GENERIC)
  })

  it('does not hand over the posting when the problem is a number', async () => {
    const invented = GROUNDED.replace('two days after', '87 days after')
    const env = stub((req) => (req.task === 'revise' ? GROUNDED : invented))
    const written = await writeCoverLetter(env.llm, inputs, scopelyJob)
    expect(written).toMatchObject({ text: GROUNDED, revisions: 1 })
    const prompt = env.seen[1].prompt
    expect(prompt).toContain('The number 87 is in neither the profile nor the posting.')
    expect(prompt).not.toContain('to take details from')
  })

  it('gives up after maxRevisions and sends the letter on, below the line, without blocking it', async () => {
    const env = stub(() => GENERIC)
    const written = await writeCoverLetter(env.llm, inputs, scopelyJob)
    expect(env.seen).toHaveLength(3)
    expect(written.revisions).toBe(2)
    expect(groundingIssues(written.lint).map((i) => i.rule)).toEqual([GROUNDING_RULES.noDetail])
    expect(blockingIssues(written.lint)).toEqual([])
    expect(lintPasses(written.lint, 80)).toBe(true)
  })

  it('does not revise a grounded letter', async () => {
    const env = stub(() => GROUNDED)
    const written = await writeCoverLetter(env.llm, inputs, scopelyJob)
    expect(env.seen).toHaveLength(1)
    expect(written.revisions).toBe(0)
  })

  it('revises only the texts that are ungrounded, together, when several are written at once', async () => {
    const WHY_GENERIC = 'I like building games with a team that cares about the details, and I enjoy solving hard problems that players notice. The work looks like a good match for my background and my interests.'
    const WHY_GROUNDED = 'At Hollow Lantern I added telemetry to a Unity client, so I know why monitoring and observability matter. Your unannounced Strategy/MMO needs the same signals from real players.'
    const BUG = 'I once chased a crash that only happened on one old phone. I added logging first, then found a missing null check in the save code. The fix took an hour once I could see it.'
    const questions: BatchQuestion[] = [
      { key: 'why', label: 'Why do you want to work at Scopely?', maxLength: null, long: true },
      { key: 'bug', label: 'Describe a hard bug you fixed', maxLength: null, long: true }
    ]
    const env = stub(
      () => '',
      (req) =>
        req.prompt.includes('DRAFT ')
          ? { answers: [{ key: 'q1', answer: WHY_GROUNDED }, { key: 'letter', answer: GROUNDED }] }
          : { answers: [{ key: 'q1', answer: WHY_GENERIC }, { key: 'q2', answer: BUG }], letter: GENERIC }
    )
    const result = await writeApplicationAnswers(env.llm, inputs, scopelyJob, questions, { coverLetter: {} })
    expect(env.seen).toHaveLength(2)
    const revision = env.seen[1].prompt
    expect(revision).toContain('DRAFT q1')
    expect(revision).toContain('DRAFT letter')
    expect(revision).not.toContain('DRAFT q2')
    expect(result.answers.get('why')).toMatchObject({ text: WHY_GROUNDED, revisions: 1 })
    expect(result.answers.get('bug')).toMatchObject({ text: BUG, revisions: 0 })
    expect(result.letter).toMatchObject({ text: GROUNDED, revisions: 1 })
    for (const t of [result.answers.get('why')!, result.answers.get('bug')!, result.letter!]) expect(groundingIssues(t.lint)).toEqual([])
  })

  it('does not hold an answer adapted from the person\'s saved answer against the profile', async () => {
    const adapted = 'I like payment tools. At Ledgerly I cut failed payments by 87 percent and I wrote the nightly check that still runs, which the team at Acme still relies on every single week.'
    const questions: BatchQuestion[] = [
      { key: 'why', label: 'Why do you want to work at Scopely?', maxLength: null, long: true, baseAnswer: 'I like payment tools.' },
      { key: 'bug', label: 'Describe a hard bug you fixed', maxLength: null, long: true }
    ]
    const env = stub(() => '', () => ({ answers: [{ key: 'q1', answer: adapted }, { key: 'q2', answer: adapted }] }))
    const result = await writeApplicationAnswers(env.llm, inputs, scopelyJob, questions)
    expect(groundingIssues(result.answers.get('why')!.lint)).toEqual([])
    expect(groundingIssues(result.answers.get('bug')!.lint).map((i) => i.rule)).toEqual([GROUNDING_RULES.number, GROUNDING_RULES.name, GROUNDING_RULES.name])
  })
})
