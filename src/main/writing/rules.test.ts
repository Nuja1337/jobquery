import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Profile, VoiceProfile } from '@shared/types'
import { blockingIssues, lintText } from './lint'
import {
  allowedTermsFor,
  answerPrompt,
  answersBatchPrompt,
  buildCandidateContext,
  buildWritingSystem,
  coverLetterPrompt,
  passingSignaturePhrases,
  PROMPT_VERSIONS,
  type JobForWriting
} from './prompts'
import { allowedTermsFrom, replaceDashes } from './rules'

const PLAIN = 'I rebuilt the save system for a mobile puzzle game after it lost progress on about 300 phones. The fix cut crash reports by 40 percent, and I wrote the nightly check that still runs.'

const job: JobForWriting = {
  id: 'j1',
  company: 'Mossbrook Games',
  title: 'Gameplay Programmer',
  location: null,
  description: 'You will build the test harness for our combat code and own unlock progression. Experience with C++ and Unreal helps.',
  fit: null
}

function rules(text: string, allowedTerms?: string[]): string[] {
  return lintText(text, { allowedTerms }).issues.map((i) => i.rule)
}

describe('game and model cliches', () => {
  it.each([
    ['passion for games', 'My passion for games started early.'],
    ['gaming since', "I've been gaming since I was seven."],
    ['since childhood', 'I have built levels since childhood.'],
    ['push the boundaries', 'I want to push the boundaries of what a shooter can do.'],
    ['immersive experiences', 'I build immersive experiences for players.'],
    ['player-first', 'I take a player-first approach to design.'],
    ['aaa-quality', 'I ship AAA-quality tools.'],
    ['delve', 'I will delve into the combat code.'],
    ['tapestry', 'The studio is a tapestry of talent.'],
    ['testament to', 'The shipped title is a testament to the team.'],
    ["in today's fast-paced", "In today's fast-paced industry, speed matters."],
    ['unique blend', 'I bring a unique blend of code and design.'],
    ['align perfectly', 'My skills align perfectly with the role.'],
    ["i'd love the opportunity", "I'd love the opportunity to talk."],
    ['i am thrilled', 'I am thrilled to see this role.']
  ])('blocks "%s"', (phrase, sentence) => {
    const report = lintText(`${PLAIN} ${sentence}`)
    const hit = report.issues.find((i) => i.rule === `phrase:${phrase}`)
    expect(hit?.severity).toBe('high')
    expect(blockingIssues(report)).toContain(hit)
  })

  it('flags "level up" without blocking it', () => {
    const report = lintText(`${PLAIN} The tools helped designers level up their prototypes.`)
    const hit = report.issues.find((i) => i.rule === 'phrase:level up')
    expect(hit?.severity).toBe('medium')
    expect(blockingIssues(report)).toEqual([])
  })

  it('leaves a plain game-dev letter alone', () => {
    expect(lintText(PLAIN).issues).toEqual([])
  })
})

describe('the "With N years" opener', () => {
  it.each([
    'With 5 years of experience in games, I rebuilt the save system.',
    'With over six years of experience, I rebuilt the save system.',
    'Hi team,\n\nWith 10+ years in engine work, I rebuilt the save system.'
  ])('blocks %j', (text) => {
    expect(blockingIssues(lintText(text)).map((i) => i.rule)).toContain('with-years-opener')
  })

  it('does not flag "with" later in a sentence or a different phrase', () => {
    expect(rules('I worked with five studios over the years. With the save system rebuilt, crashes dropped.')).not.toContain('with-years-opener')
  })
})

describe('NEEDS_INPUT', () => {
  it.each(['NEEDS_INPUT: salary', 'Thanks for the note. NEEDS INPUT: start date', 'needs-input: visa'])('counts %j as a blocking placeholder', (text) => {
    expect(blockingIssues(lintText(`${PLAIN}\n\n${text}`)).map((i) => i.rule)).toContain('placeholder')
  })
})

describe('spaced hyphen as a dash', () => {
  it('counts like an em dash', () => {
    const report = lintText(`${PLAIN} The fix was small - one flag.`)
    expect(blockingIssues(report).map((i) => i.rule)).toContain('em-dash')
  })

  it('leaves hyphenated words, list markers at line starts and numbers alone', () => {
    expect(rules(`${PLAIN} It is a well-known, built-in check.`)).not.toContain('em-dash')
    expect(rules('Skills\n- C++\n- Unreal\n')).not.toContain('em-dash')
    expect(rules(`${PLAIN} Call 555-0100.`)).not.toContain('em-dash')
  })
})

describe('replaceDashes', () => {
  it('writes "to" between numbers', () => {
    expect(replaceDashes('Mossbrook, 2019 - 2021')).toBe('Mossbrook, 2019 to 2021')
    expect(replaceDashes('Mossbrook, 2019 — 2021')).toBe('Mossbrook, 2019 to 2021')
    expect(replaceDashes('Mossbrook, 2019–2021')).toBe('Mossbrook, 2019 to 2021')
  })

  it('does not touch a date or a phone number with unspaced hyphens', () => {
    expect(replaceDashes('Shipped 2024-05-01. Call 555-0100.')).toBe('Shipped 2024-05-01. Call 555-0100.')
  })

  it('turns a spaced hyphen between words into a comma', () => {
    expect(replaceDashes('The fix was small - one flag.')).toBe('The fix was small, one flag.')
  })

  it('keeps line breaks and list markers at line starts', () => {
    expect(replaceDashes('Skills\n- C++\n  - Unreal\n\nThanks —\nSam')).toBe('Skills\n- C++\n  - Unreal\n\nThanks,\nSam')
  })

  it('still handles the old cases', () => {
    expect(replaceDashes('We shipped — finally — in May.')).toBe('We shipped, finally, in May.')
    expect(replaceDashes('A -- B')).toBe('A, B')
  })

  it('leaves text that lints clean of dashes', () => {
    expect(rules(replaceDashes(`${PLAIN} It ran 2019 - 2021 - quietly.`))).not.toContain('em-dash')
  })
})

describe('allowed terms', () => {
  it('finds the banned terms a posting uses in a plain sense', () => {
    expect(allowedTermsFrom(job.description).sort()).toEqual(['harness', 'unlock'])
    expect(allowedTermsFrom('We value passion and a strong sense of ownership.')).toEqual([])
    expect(allowedTermsFrom('')).toEqual([])
  })

  it('never allows fillers or template openers', () => {
    expect(allowedTermsFrom('We are passionate about games, really, and just thrilled to hire.')).toEqual([])
  })

  it('reads the profile too', () => {
    const profile: Profile = { ...EMPTY_PROFILE, projects: [{ name: 'Rig', description: 'A test harness for netcode', highlights: [] }] }
    expect(allowedTermsFor({ title: 'Programmer', description: '' }, profile)).toEqual(['harness'])
    expect(allowedTermsFor(job, EMPTY_PROFILE).sort()).toEqual(['harness', 'unlock'])
  })

  it('lets the linter pass an allowed term and still flags it otherwise', () => {
    const text = `${PLAIN} I built a test harness and the unlock progression tests.`
    expect(rules(text)).toEqual(expect.arrayContaining(['phrase:harness', 'phrase:unlock']))
    const allowed = rules(text, ['harness', 'unlock'])
    expect(allowed).not.toContain('phrase:harness')
    expect(allowed).not.toContain('phrase:unlock')
  })

  it('keeps a phrase the owner banned in settings', () => {
    const report = lintText(`${PLAIN} I built a test harness.`, { allowedTerms: ['harness'], extraBanned: ['harness'] })
    expect(report.issues.map((i) => i.rule)).toContain('phrase:harness')
  })

  it('takes allowed terms off the banned list in the system prompt', () => {
    const list = (system: string) => system.split('Any of these words or phrases: ')[1]!.split('.\n')[0]!.split(', ')
    expect(list(buildWritingSystem(DEFAULT_SETTINGS))).toEqual(expect.arrayContaining(['harness', 'unlock']))
    const system = buildWritingSystem(DEFAULT_SETTINGS, ['harness', 'unlock'])
    expect(list(system)).not.toContain('harness')
    expect(list(system)).not.toContain('unlock')
    expect(list(system)).toContain('delve')
  })
})

describe('prompt lines', () => {
  it('puts the truth rule about the company in the system prompt and every task prompt', () => {
    expect(buildWritingSystem(DEFAULT_SETTINGS)).toContain('Say nothing about the company, its games, its products or its culture that is not in the posting')
    expect(answerPrompt(job, { label: 'Why us?', maxLength: null, long: true }, null)).toContain('Say nothing about Mossbrook Games that the posting does not say.')
    expect(coverLetterPrompt(job, 'medium', 'Sam', null)).toContain('Say nothing about Mossbrook Games that the posting does not say.')
    const batch = answersBatchPrompt(job, [{ id: 'q1', label: 'Why us?', maxLength: null, long: true, baseAnswer: null, guidance: null }], null)
    expect(batch).toContain('Say nothing about Mossbrook Games that the posting does not say.')
  })

  it('tells the letter to name the title once, use posting keywords, explain one decision and skip pay talk', () => {
    for (const prompt of [coverLetterPrompt(job, 'medium', 'Sam', null), answersBatchPrompt(job, [], { length: 'medium', firstName: 'Sam', guidance: null })]) {
      expect(prompt).toContain('Name the exact job title "Gameplay Programmer" once, and only once.')
      expect(prompt).toContain('Use 2 to 4 keywords from the posting')
      expect(prompt).toContain('explain one decision in it: what the candidate chose and why')
      expect(prompt).toContain('Leave out salary, visa, work authorization and notice period.')
    }
  })

  it('names the new opener and the game cliches in the system prompt', () => {
    const system = buildWritingSystem(DEFAULT_SETTINGS)
    expect(system).toContain('With N years of experience')
    expect(system).toContain('loving games since childhood')
    expect(system).toContain('a hyphen with spaces around it')
  })

  it('bumps the prompt versions', () => {
    expect(PROMPT_VERSIONS).toEqual({
      coverLetter: 'cover-v3',
      answer: 'answer-v4',
      revise: 'revise-v4',
      answersBatch: 'answers-batch-v4',
      reviseBatch: 'revise-batch-v4'
    })
  })

  it('has no em dash in its own lines', () => {
    expect([coverLetterPrompt(job, 'medium', 'Sam', null), buildWritingSystem(DEFAULT_SETTINGS)].join('\n')).not.toContain('—')
  })
})

describe('signature phrases', () => {
  it('drops the ones that fail lint', () => {
    expect(passingSignaturePhrases(['which cut load time', 'I am passionate about games', 'worth a conversation', 'really just works', '  '])).toEqual(['which cut load time', 'worth a conversation'])
  })

  it('keeps failing phrases out of the voice section of the prompt', () => {
    const voice: VoiceProfile = {
      summary: 'Direct.',
      formality: 'neutral',
      traits: [],
      signaturePhrases: ['which cut load time', 'a testament to the team'],
      avoid: [],
      avgSentenceWords: 14,
      builtFrom: [],
      builtAt: '2026-01-01T00:00:00.000Z'
    }
    const context = buildCandidateContext({ ...EMPTY_PROFILE, voice }, [])
    expect(context).toContain('"which cut load time"')
    expect(context).not.toContain('testament')
  })
})
