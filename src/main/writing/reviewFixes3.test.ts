import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { Profile } from '@shared/types'
import profileFixture from './__fixtures__/profile.json'
import scopely from './__fixtures__/scopely-client-engineer.posting.json'
import { coverLetterLintOptions, jobWritingContext } from './generate'
import { groundingIssues, groundingSource, lettersCheckPasses, lintText } from './lint'
import { linkRequest, parseLimits, questionLimits } from './prompts'

// Final review, writing findings: upper limits worded with "no", small word counts, links the form forbids, and
// resume shorthand in the grounding check.

describe('finding 3: "no more than" is an upper limit', () => {
  it.each([
    ['Please answer in no more than 200 words.', { words: 200, chars: null }],
    ['Not more than 150 words, please.', { words: 150, chars: null }],
    ['No more than 500 characters.', { words: null, chars: 500 }],
    ['Keep it to no more than 3 sentences.', { words: 75, chars: null }],
    ['Do not go over 300 words.', { words: 300, chars: null }],
    ["Please don't go over 400 words.", { words: 400, chars: null }],
    ['Do not exceed 250 words.', { words: 250, chars: null }],
    ['The answer should not be more than 120 words.', { words: 120, chars: null }],
    ['Do not go over 900 characters.', { words: null, chars: 900 }]
  ])('%s', (text, expected) => {
    expect(parseLimits(text)).toEqual(expected)
  })

  it('still reads a minimum as no limit', () => {
    expect(parseLimits('At least 50 words.')).toEqual({ words: null, chars: null })
    expect(parseLimits('Describe a time you wrote more than 10,000 lines of code in one week.')).toEqual({ words: null, chars: null })
    expect(parseLimits('Write over 200 words.')).toEqual({ words: null, chars: null })
    expect(parseLimits('Minimum 50 words, maximum 200 words.')).toEqual({ words: 200, chars: null })
  })

  it('does not read "one words" out of ordinary text', () => {
    expect(parseLimits('Describe a project. Someone words this badly.')).toEqual({ words: null, chars: null })
  })
})

describe('finding 4: small word counts set no character cap', () => {
  it('checks three words as words only', () => {
    expect(questionLimits({ label: 'Describe yourself in three words.', maxLength: null })).toEqual({ maxChars: null, maxWords: 3 })
    expect(questionLimits({ label: 'In one word, what drives you?', maxLength: null })).toEqual({ maxChars: null, maxWords: 1 })
    expect(questionLimits({ label: 'What 3 words would your teammates use to describe you?', maxLength: null })).toEqual({ maxChars: null, maxWords: 3 })
  })

  it('keeps the field limit and an explicit character limit', () => {
    expect(questionLimits({ label: 'Describe yourself in three words.', maxLength: 80 })).toEqual({ maxChars: 80, maxWords: 3 })
    expect(questionLimits({ label: 'Describe yourself in three words.', maxLength: null, hint: 'Max 40 characters' })).toEqual({ maxChars: 40, maxWords: 3 })
  })

  it('still derives a character cap from a normal word limit', () => {
    expect(questionLimits({ label: 'Why us?', maxLength: null, hint: 'In 100 words or less' })).toEqual({ maxChars: 600, maxWords: 100 })
    expect(questionLimits({ label: 'Why us?', maxLength: null, hint: 'Up to 15 words' })).toEqual({ maxChars: 90, maxWords: 15 })
  })
})

describe('finding 10: a hint that forbids links asks for none', () => {
  const links: Profile['links'] = { linkedin: '', github: 'https://github.com/sam', portfolio: 'https://sam.dev', website: '', other: [] }

  it.each([
    'Please do not include any links or personal contact information.',
    'Tell us about a project you are proud of. No links please.',
    "Don't include a link.",
    'Answer without any URLs.'
  ])('%s', (text) => {
    expect(linkRequest(links, 'Tell us about a project', text)).toBeNull()
  })

  it('still sees a request for a link', () => {
    expect(linkRequest(links, 'Share a link to your portfolio.')).toEqual({ kind: 'portfolio', url: 'https://sam.dev' })
    expect(linkRequest(links, 'Paste your GitHub URL')).toEqual({ kind: 'GitHub', url: 'https://github.com/sam' })
    // A ban on links to something else leaves the request in place.
    expect(linkRequest(links, 'Share your GitHub link. Do not include links to private repos.')).toEqual({ kind: 'GitHub', url: 'https://github.com/sam' })
  })
})

describe('finding 9: resume shorthand and tenure in the grounding check', () => {
  const base: Profile = { ...EMPTY_PROFILE, ...(profileFixture as Partial<Profile>) }
  const job = { id: 'scopely', company: scopely.company, title: scopely.title, location: null, description: scopely.text, fit: null }

  const fullNames: Profile = {
    ...base,
    languages: ['English'],
    skills: [...base.skills, 'Unreal Engine 5'],
    experience: [{ ...base.experience[0], highlights: [...base.experience[0].highlights, 'Shipped Tidepool on Steam and ported it to Xbox and Nintendo Switch', 'Worked with QA to triage crash reports from players'] }]
  }
  const shorthand: Profile = {
    ...base,
    languages: ['English'],
    skills: [...base.skills.filter((s) => s !== 'Unreal Engine'), 'UE5'],
    experience: [{ ...base.experience[0], highlights: [...base.experience[0].highlights, 'Shipped Tidepool on Steam, Xbox and Switch', 'Worked with QA to triage player crash reports'] }]
  }

  const letter = `Hi Scopely team,

When our mobile puzzle game lost progress on about 300 phones, nobody could see it happening in the field. I wrote a small telemetry layer in C# inside the Unity client that reported save failures and frame times from real devices, and our QA lead used it to reproduce the bug in an afternoon.

The Client Engineer posting asks for monitoring and observability inside the Unity client, and for turning ambiguous live issues into signals the team can act on. That is the work I enjoy most. On Tidepool I watched crash reports from Steam, Xbox and Nintendo Switch players side by side, using Unreal Engine 5 builds for the console ports, and the same UI bug looked different on each platform until the data lined up.

I write and present in English every day. I would like to talk about which signals your team wants first from real user monitoring, and how you decide what goes on a dashboard.

Thanks,
Mara`

  const check = (text: string, profile: Profile) => {
    const ctx = jobWritingContext(job, profile)
    return lintText(text, coverLetterLintOptions({ settings: DEFAULT_SETTINGS }, null, ctx.allowedTerms, { source: ctx.grounding, kind: 'letter' }))
  }
  const names = (text: string, profile: Profile) =>
    groundingIssues(check(text, profile))
      .map((i) => i.match)
      .filter(Boolean)

  it('holds the letter against a profile that spells the names out and passes', () => {
    expect(names(letter, fullNames)).toEqual([])
  })

  it('counts UE5 and Switch in the profile as support for Unreal Engine 5 and Nintendo Switch', () => {
    expect(names(letter, shorthand)).toEqual([])
    expect(lettersCheckPasses(check(letter, shorthand), DEFAULT_SETTINGS.writing.minLintScore)).toBe(true)
  })

  it('still flags a platform the profile does not have', () => {
    const invented = letter.replace('Steam, Xbox and Nintendo Switch', 'Steam, Xbox and Sega Genesis')
    expect(names(invented, shorthand)).toContain('Sega')
    // Without the shorthand there is nothing to support Nintendo.
    const bare: Profile = { ...shorthand, skills: ['C#', 'Unity'], experience: [{ ...shorthand.experience[0], highlights: ['Shipped Tidepool on Steam'] }] }
    expect(names(letter, bare)).toContain('Nintendo')
  })

  it('does not read the plain word "switch" in the profile as Nintendo Switch', () => {
    const plain: Profile = { ...shorthand, experience: [{ ...shorthand.experience[0], highlights: ['Wrote a state machine with a switch statement for the shop'] }] }
    expect(names(letter, plain)).toContain('Nintendo')
  })

  const source = (experience: Array<{ start?: string | null; end?: string | null }>, profile = 'Gameplay programmer who ships C# and Unity features.') =>
    groundingSource({ title: 'Engineer', company: 'Acme', description: scopely.text, profile, experience, now: new Date('2026-11-08T00:00:00Z') })

  it('supports years at one employer, rounded down or up', () => {
    // 2021 to November 2026 is 4.9 to 5.9 years, depending on the month.
    const s = source([{ start: '2021', end: null }])
    for (const n of ['4', '5', '6']) expect(s.numbers.has(n), n).toBe(true)
    expect(s.numbers.has('9')).toBe(false)
  })

  it('works out years from a month, in total and for each job', () => {
    const s = source([
      { start: '2024-09', end: null },
      { start: '2020-06', end: '2024-08' }
    ])
    // 2 years at the current job, 4 at the earlier one, 6 in total.
    for (const n of ['2', '3', '4', '6', '7']) expect(s.numbers.has(n), n).toBe(true)
    expect(s.numbers.has('12')).toBe(false)
  })

  it('reads month names and ignores a job without a start', () => {
    const s = source([{ start: 'Mar 2023', end: 'Sep 2024' }, { start: null, end: null }])
    expect(s.numbers.has('2')).toBe(true)
    expect(s.numbers.has('18')).toBe(true)
  })

  it('accepts "5 years at Hollow Lantern Studio" for a job that started in 2021', () => {
    const noFive: Profile = { ...base, languages: ['English'], experience: [{ ...base.experience[0], highlights: [...base.experience[0].highlights, 'Shipped Tidepool on Steam and ported it to Xbox and Nintendo Switch', 'Worked with QA to triage crash reports from players'] }] }
    const years = letter.replace('When our mobile puzzle game', 'In 5 years at Hollow Lantern Studio, when our mobile puzzle game').replace(', using Unreal Engine 5 builds for the console ports', '')
    expect(groundingIssues(check(years, noFive)).map((i) => i.rule)).toEqual([])
    // With no start date in the profile, the same figure is unsupported.
    const undated: Profile = { ...noFive, experience: [{ ...noFive.experience[0], start: undefined }] }
    expect(groundingIssues(check(years, undated)).map((i) => i.match)).toContain('5')
  })

  it('does not support a figure that no source or tenure has', () => {
    const wrong = letter.replace('When our mobile puzzle game', 'After 17 years in games, when our mobile puzzle game')
    expect(groundingIssues(check(wrong, fullNames)).map((i) => i.match)).toContain('17')
  })
})
