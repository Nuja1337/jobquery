import { describe, expect, it } from 'vitest'
import { EMPTY_APPLICATION_FACTS } from '@shared/defaults'
import { topicFor } from '@shared/questionTopics'
import type { ApplicationFacts } from '@shared/types'
import { STANCE_SLOTS, TEMPLATE_SLOTS } from './answerSlots'
import { cleanApplication, languageName, languageRows, skillRows, TOP_SKILLS, withLanguageLevel, withSkillYears } from './applicationFactsHelpers'

describe('skillRows', () => {
  it('lists the top skills first, then other skills that have years, without repeats', () => {
    const skills = Array.from({ length: 14 }, (_, i) => `Skill ${i + 1}`)
    const rows = skillRows(skills, { 'skill 2': 4, Rust: 1 })
    expect(rows.slice(0, TOP_SKILLS)).toEqual(skills.slice(0, TOP_SKILLS))
    expect(rows).toContain('Rust')
    expect(rows.filter((r) => r.toLowerCase() === 'skill 2')).toHaveLength(1)
    expect(rows).not.toContain('Skill 14')
  })

  it('skips blank names', () => {
    expect(skillRows(['', ' React '], { '': 2 })).toEqual(['React'])
  })
})

describe('language rows', () => {
  it('reads the name out of "German (B1)"', () => {
    expect(languageName('German (B1)')).toBe('German')
    expect(languageName('English - fluent')).toBe('English')
    expect(languageName('Spanish')).toBe('Spanish')
  })

  it('lists the profile languages and any other with a level', () => {
    expect(languageRows(['English (fluent)', 'German (B1)'], { german: 'conversational', French: 'basic' })).toEqual(['English', 'German', 'French'])
  })
})

describe('withSkillYears and withLanguageLevel', () => {
  it('sets, updates and clears an entry, keeping the order', () => {
    const start = { React: 6, Go: 1 }
    expect(Object.entries(withSkillYears(start, 'react', 7))).toEqual([['React', 7], ['Go', 1]])
    expect(withSkillYears(start, 'Go', null)).toEqual({ React: 6 })
    expect(withSkillYears(start, 'Rust', 2)).toEqual({ React: 6, Go: 1, Rust: 2 })
    expect(withSkillYears(start, 'Rust', null)).toEqual(start)
    expect(withLanguageLevel({ German: 'basic' }, 'german', 'fluent')).toEqual({ German: 'fluent' })
    expect(withLanguageLevel({ German: 'basic' }, 'German', null)).toEqual({})
  })
})

describe('cleanApplication', () => {
  it('drops blank rows and trims places', () => {
    const facts: ApplicationFacts = {
      ...EMPTY_APPLICATION_FACTS,
      authorization: [
        { country: ' ', status: 'citizen', needsSponsorship: false, notes: '' },
        { country: 'Germany ', status: 'citizen', needsSponsorship: false, notes: '' }
      ],
      salary: [
        { currency: 'USD', min: null, target: null, period: 'year', answerStyle: 'range' },
        { currency: 'EUR', min: 90000, target: null, period: 'year', answerStyle: 'number' }
      ],
      relocation: { willing: true, places: [' Spain ', ''] },
      skillYears: { React: 6, '': 3 },
      languageLevels: { German: 'basic' }
    }
    const clean = cleanApplication(facts)
    expect(clean.authorization.map((a) => a.country)).toEqual(['Germany'])
    expect(clean.salary.map((s) => s.currency)).toEqual(['EUR'])
    expect(clean.relocation.places).toEqual(['Spain'])
    expect(clean.skillYears).toEqual({ React: 6 })
  })

  it('keeps the family and referral facts', () => {
    const clean = cleanApplication({ ...EMPTY_APPLICATION_FACTS, relativesAtEmployers: false, referrals: 'none' })
    expect(clean.relativesAtEmployers).toBe(false)
    expect(clean.referrals).toBe('none')
    expect(cleanApplication(EMPTY_APPLICATION_FACTS)).toMatchObject({ relativesAtEmployers: null, referrals: '' })
  })

  it('leaves clean facts unchanged, key order included', () => {
    expect(JSON.stringify(cleanApplication(EMPTY_APPLICATION_FACTS))).toBe(JSON.stringify(EMPTY_APPLICATION_FACTS))
  })
})

describe('answer slots', () => {
  it('file each question under the slot topic', () => {
    for (const slot of [...STANCE_SLOTS, ...TEMPLATE_SLOTS]) expect(topicFor(slot.question)?.topic, slot.question).toBe(slot.topic)
  })

  it('keep the stances as facts and the written answers as templates', () => {
    expect(STANCE_SLOTS.every((s) => s.kind === 'fact')).toBe(true)
    expect(TEMPLATE_SLOTS.every((s) => s.kind === 'template')).toBe(true)
    expect(TEMPLATE_SLOTS.map((s) => s.topic)).toEqual(['why_company', 'about_you', 'strengths'])
    expect(STANCE_SLOTS.map((s) => s.topic)).toEqual(['ai_use_disclosure', 'criminal_history'])
  })
})
