import { describe, expect, it } from 'vitest'
import { parseHimalayas } from './himalayas'
import { parsePersonio } from './personio'
import { parseTheMuse } from './themuse'
import { fixtureJson, fixtureText } from './testHelpers'

// Himalayas, Personio and The Muse state a level. It becomes one of the app's seniority ids.

describe('seniority from sources', () => {
  it('reads the levels Himalayas lists', () => {
    const jobs = parseHimalayas(fixtureJson('himalayas.json'), {}, 0)
    expect(jobs.map((j) => j.seniority)).toEqual([['mid'], ['mid', 'senior'], ['mid']])
  })

  it('reads the level and minimum years Personio states', () => {
    const jobs = parsePersonio(fixtureText('personio.xml'), 'demo')
    expect(jobs.map((j) => [j.seniority, j.minYears])).toEqual([
      [['junior'], 0],
      [['junior'], 0],
      [['junior'], null],
      [['intern'], 0]
    ])
  })

  it('reads the Muse levels', () => {
    const jobs = parseTheMuse(fixtureJson('themuse.json'))
    expect(jobs.map((j) => j.seniority)).toEqual([['senior'], ['senior'], ['mid']])
  })

  it('reads Personio year ranges as their lower bound', () => {
    const feed = (range: string, seniority = 'experienced') =>
      `<workzag-jobs><position><id>1</id><name>Engineer</name><office>Berlin</office><seniority>${seniority}</seniority>` +
      `<yearsOfExperience>${range}</yearsOfExperience><jobDescriptions><jobDescription><name>Role</name><value>Build.</value></jobDescription></jobDescriptions></position></workzag-jobs>`
    const years = (range: string) => parsePersonio(feed(range), 'demo')[0].minYears
    expect(years('lt-1')).toBe(0)
    expect(years('1-2')).toBe(1)
    expect(years('5-7')).toBe(5)
    expect(years('ge-15')).toBe(15)
    expect(years('')).toBeNull()
    // "experienced" says too little to place, so no level is set.
    expect(parsePersonio(feed('2-5'), 'demo')[0].seniority).toEqual([])
  })
})
