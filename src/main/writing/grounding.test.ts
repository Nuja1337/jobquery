import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { LintReport, Profile } from '@shared/types'
import { coverLetterLintOptions, jobWritingContext } from './generate'
import { letterHeld } from '../apply/readiness'
import { asksAboutEmployer, blockingIssues, failureReason, groundingIssues, lettersCheckPasses, groundingNote, GROUNDING_RULES, isBetterLint, lintPasses, lintText, topIssue, type GroundingKind } from './lint'
import { renderProfile, type JobForWriting } from './prompts'
import bungie from './__fixtures__/bungie-investment-designer.posting.json'
import profileFixture from './__fixtures__/profile.json'
import riot from './__fixtures__/riot-combat-designer.posting.json'
import scopely from './__fixtures__/scopely-client-engineer.posting.json'

// Grounding checks run on three real postings from Greenhouse's public API (title, company and text, converted with
// htmlToPlain) and a made-up candidate. Each posting has a generic letter that could go to any studio and one that
// holds to the posting. The Riot posting is in Chinese, so the checks have nothing to hold a letter against.

const profile: Profile = { ...EMPTY_PROFILE, ...(profileFixture as Partial<Profile>) }
const fixtureLetter = (slug: string, kind: 'generic' | 'grounded') => fs.readFileSync(fileURLToPath(new URL(`./__fixtures__/letters/${slug}.${kind}.txt`, import.meta.url)), 'utf8').trim()
const forWriting = (id: string, p: { title: string; company: string; text: string }): JobForWriting => ({ id, company: p.company, title: p.title, location: null, description: p.text, fit: null })

const POSTINGS = {
  scopely: { slug: 'scopely-client-engineer', job: forWriting('scopely', scopely) },
  bungie: { slug: 'bungie-investment-designer', job: forWriting('bungie', bungie) },
  riot: { slug: 'riot-combat-designer', job: forWriting('riot', riot) }
}

const MIN = DEFAULT_SETTINGS.writing.minLintScore

/** Lints a text the way a cover letter is linted when it is written for this job. */
function lintLetter(job: JobForWriting, text: string, kind: GroundingKind = 'letter', extra?: string): LintReport {
  const ctx = jobWritingContext(job, profile)
  return lintText(text, coverLetterLintOptions({ settings: DEFAULT_SETTINGS }, null, ctx.allowedTerms, { source: ctx.grounding, kind, extra }))
}

const ruleIds = (report: LintReport) => groundingIssues(report).map((i) => i.rule)

describe('the fixture postings', () => {
  it('give the English ones enough words to hold a letter against, and the Chinese one too few', () => {
    expect(jobWritingContext(POSTINGS.scopely.job, profile).grounding.usable).toBe(true)
    expect(jobWritingContext(POSTINGS.bungie.job, profile).grounding.usable).toBe(true)
    expect(jobWritingContext(POSTINGS.riot.job, profile).grounding.usable).toBe(false)
  })
})

describe.each(['scopely', 'bungie'] as const)('%s letters', (name) => {
  const { slug, job } = POSTINGS[name]

  it('puts the generic letter below the auto-send line while its style score stays high', () => {
    const report = lintLetter(job, fixtureLetter(slug, 'generic'))
    // The same letter without grounding is a clean, high score. That is the problem the checks solve.
    const plain = lintText(fixtureLetter(slug, 'generic'), coverLetterLintOptions({ settings: DEFAULT_SETTINGS }))
    expect(plain.score).toBeGreaterThanOrEqual(95)
    expect(report.score).toBe(plain.score)
    expect(ruleIds(report)).toEqual([GROUNDING_RULES.noDetail])
    expect(groundingNote(report)).toMatch(/^Not tied to the posting and the profile\. /)
  })

  it('keeps the grounded letter clean', () => {
    const report = lintLetter(job, fixtureLetter(slug, 'grounded'))
    expect(report.score).toBeGreaterThanOrEqual(90)
    expect(ruleIds(report)).toEqual([])
    expect(groundingNote(report)).toBeNull()
  })

  it('never blocks a letter and never costs it style points', () => {
    const report = lintLetter(job, fixtureLetter(slug, 'generic'))
    expect(blockingIssues(report)).toEqual([])
    expect(lintPasses(report, MIN)).toBe(true)
    expect(report.issues.find((i) => i.rule === GROUNDING_RULES.noDetail)?.severity).toBe('medium')
  })
})

describe('a posting the checks cannot read', () => {
  it('raises nothing for either Riot letter, even a generic one', () => {
    const { slug, job } = POSTINGS.riot
    for (const kind of ['generic', 'grounded'] as const) {
      const report = lintLetter(job, fixtureLetter(slug, kind))
      expect(report.score).toBeGreaterThanOrEqual(90)
      expect(ruleIds(report)).toEqual([])
    }
  })

  it('raises nothing for a stub posting, so a number or a name is not held against it', () => {
    const stub = { ...POSTINGS.scopely.job, description: 'We build payment tools.' }
    const report = lintLetter(stub, `${fixtureLetter('scopely-client-engineer', 'generic')} We cut costs by 87 percent at Naughty Dog.`)
    expect(ruleIds(report)).toEqual([])
  })
})

describe('numbers and names that neither the profile nor the posting has', () => {
  const { slug, job } = POSTINGS.scopely
  const grounded = fixtureLetter(slug, 'grounded')

  it('flags a number the letter invented', () => {
    const report = lintLetter(job, grounded.replace('two days after', '87 days after'))
    const hit = groundingIssues(report).find((i) => i.rule === GROUNDING_RULES.number)
    expect(hit?.match).toBe('87')
    expect(hit?.message).toBe('The number 87 is in neither the profile nor the posting.')
  })

  it('accepts numbers the profile or the posting gives, in any format', () => {
    // 300 and 35 are in the profile, 3 is in the posting ("3 days a week"), and 2D is a format.
    const text = `${grounded}\n\nThe fix reached about 300 phones, and frame hitches fell 35 percent. A 2D game and a 3 day week are both fine by me.`
    expect(ruleIds(lintLetter(job, text))).toEqual([])
  })

  it('accepts a number from what the person asked for', () => {
    const text = grounded.replace('two days after', '87 days after')
    expect(ruleIds(lintLetter(job, text, 'letter', 'Mention the 87 days.'))).toEqual([])
  })

  it('flags a name the letter invented', () => {
    const report = lintLetter(job, grounded.replace('inside the Unity client', 'the way Naughty Dog does inside the Unity client'))
    const names = groundingIssues(report).filter((i) => i.rule === GROUNDING_RULES.name)
    expect(names.map((i) => i.match)).toEqual(['Naughty', 'Dog'])
    expect(names[0].message).toBe('The name Naughty is in neither the profile nor the posting.')
  })

  it('leaves names from the posting, the profile and the form of the letter alone', () => {
    // Scopely, Unity, Strategy and LiveOps are in the posting. Hollow Lantern Studio and Leeds are in the profile.
    const text = `${grounded}\n\nAt Hollow Lantern Studio near Leeds I worked on Unity builds and on Strategy tools. Dear Hiring Manager, I am free on Monday in March.`
    expect(ruleIds(lintText(text, lintLetterOptions(job)))).toEqual([])
  })

  it('does not take the first word of a sentence for a name', () => {
    const text = `${grounded}\n\nTelemetry helped. Monitoring helped more. Nobody argued about it afterwards.`
    expect(ruleIds(lintLetter(job, text))).toEqual([])
  })
})

function lintLetterOptions(job: JobForWriting) {
  const ctx = jobWritingContext(job, profile)
  return coverLetterLintOptions({ settings: DEFAULT_SETTINGS }, null, ctx.allowedTerms, { source: ctx.grounding, kind: 'letter' })
}

describe('a letter that repeats the resume', () => {
  const { job } = POSTINGS.scopely
  const echo = [
    'Hi Scopely team,',
    renderProfile(profile, 'writing')
      .split('\n')
      .filter((l) => /^\s+\*/.test(l) || /^- Tidepool/.test(l))
      .map((l) => l.replace(/^\s*\*\s*|^- /, '').replace(/^Tidepool: /, ''))
      .join('. ') + '.',
    'The Unity client monitoring and telemetry in your Strategy/MMO project would suit me, and observability is where I do my best work.',
    'Thanks,\nMara'
  ].join('\n\n')

  it('is flagged even when it names the posting', () => {
    const report = lintLetter(job, echo)
    expect(ruleIds(report)).toEqual([GROUNDING_RULES.echo])
    expect(groundingIssues(report)[0].message).toBe('Most of it repeats the resume in the same words.')
  })

  it('does not flag a letter that uses a fact or two in its own words', () => {
    expect(ruleIds(lintLetter(job, fixtureLetter('scopely-client-engineer', 'grounded')))).toEqual([])
  })
})

describe('open answers', () => {
  const { job } = POSTINGS.scopely
  const WHY_GENERIC = 'I like building games with a team that cares about the details, and I enjoy solving hard problems that players notice. The work looks like a good match for my background and my interests.'
  const WHY_GROUNDED = 'At Hollow Lantern I added telemetry to a Unity client, so I know why monitoring and observability matter. Your unannounced Strategy/MMO needs the same signals from real players.'

  it('asks a company or role question for posting details', () => {
    const generic = lintLetter(job, WHY_GENERIC, 'company')
    expect(ruleIds(generic)).toEqual([GROUNDING_RULES.noDetail])
    expect(ruleIds(lintLetter(job, WHY_GROUNDED, 'company'))).toEqual([])
  })

  it('asks a general question for nothing from the posting, but still checks numbers and names', () => {
    expect(ruleIds(lintLetter(job, WHY_GENERIC, 'general'))).toEqual([])
    const invented = `${WHY_GENERIC} I did this at Naughty Dog for 87 weeks.`
    expect(ruleIds(lintLetter(job, invented, 'general'))).toEqual([GROUNDING_RULES.number, GROUNDING_RULES.name, GROUNDING_RULES.name])
  })

  it('does not judge a very short answer', () => {
    expect(ruleIds(lintLetter(job, 'Yes, for 87 weeks at Naughty Dog.', 'company'))).toEqual([])
  })

  it.each([
    ['Why do you want to work at Scopely?', true],
    ['Why are you interested in this role?', true],
    ['What excites you about this position?', true],
    ['What interests you about our studio?', true],
    ['Tell us why you are a good fit', true],
    ['What do you know about us?', true],
    ['Why are you leaving your current job?', false],
    ['Describe a hard bug you fixed', false],
    ['Tell us about a project you shipped', false],
    ['What are your greatest strengths?', false]
  ])('reads "%s" as asking about the employer: %s', (question, expected) => {
    expect(asksAboutEmployer(question)).toBe(expected)
  })
})

describe('what a grounding issue does to the report', () => {
  const { slug, job } = POSTINGS.scopely

  it('comes after the style issues when the report names its top issue', () => {
    const text = `${fixtureLetter(slug, 'generic')} I am passionate about games.`
    const report = lintLetter(job, text)
    expect(ruleIds(report)).toEqual([GROUNDING_RULES.noDetail])
    expect(topIssue(report)?.rule).toBe('phrase:passionate about')
    expect(topIssue(lintLetter(job, fixtureLetter(slug, 'generic')))?.rule).toBe(GROUNDING_RULES.noDetail)
  })

  it('makes a revision that fixes it the better text, as long as the style result holds', () => {
    const generic = lintLetter(job, fixtureLetter(slug, 'generic'))
    const grounded = lintLetter(job, fixtureLetter(slug, 'grounded'))
    expect(isBetterLint(grounded, generic, MIN)).toBe(true)
    expect(isBetterLint(generic, grounded, MIN)).toBe(false)
    // Equal grounding falls back to the score, as before.
    expect(isBetterLint(generic, generic, MIN)).toBe(true)
    // Fewer grounding issues do not buy back a style score under the minimum.
    expect(isBetterLint({ ...grounded, score: MIN - 1 }, generic, MIN)).toBe(false)
    // A blocking issue still loses to a clean text.
    const blocked = lintText(`${fixtureLetter(slug, 'grounded')} I am passionate about games.`)
    expect(isBetterLint(blocked, generic, MIN)).toBe(false)
  })

  it('leaves lintText without grounding options exactly as it was', () => {
    const text = fixtureLetter(slug, 'generic')
    expect(lintText(text)).toEqual(lintText(text, { grounding: undefined }))
    expect(groundingIssues(lintText(text))).toEqual([])
  })
})

describe('a letter that is less grounded is held like one the style check rejects', () => {
  const { slug, job } = POSTINGS.scopely
  const generic = lintLetter(job, fixtureLetter(slug, 'generic'))
  const grounded = lintLetter(job, fixtureLetter(slug, 'grounded'))

  it('fails the letter check and names the grounding issue', () => {
    expect(lettersCheckPasses(generic, MIN)).toBe(false)
    expect(lettersCheckPasses(grounded, MIN)).toBe(true)
    expect(failureReason(generic, MIN)).toMatch(/^It names no detail from the posting/)
    expect(letterHeld({ lint: generic, minLintScore: MIN })).toBe(true)
    expect(letterHeld({ lint: grounded, minLintScore: MIN })).toBe(false)
  })
})
