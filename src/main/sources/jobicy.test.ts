import { describe, expect, it } from 'vitest'
import { fetchJobicy, parseJobicy } from './jobicy'
import { fixtureJson, stubFetch, useFastHttp } from './testHelpers'

useFastHttp()

describe('parseJobicy', () => {
  const jobs = parseJobicy(fixtureJson('jobicy.json'))

  it('keeps the Jobicy page and reads yearly pay', () => {
    expect(jobs).toHaveLength(3)
    expect(jobs[0]).toMatchObject({
      source: 'jobicy',
      remote: 'remote',
      ats: 'unknown',
      company: 'Spotify',
      salaryMin: 227495,
      salaryMax: 324993,
      salaryCurrency: 'USD',
      employmentType: 'Full-time',
      location: 'Canada, USA',
      postedAt: '2026-11-07T16:33:27.000Z'
    })
    expect(jobs[0].url).toMatch(/^https:\/\/jobicy\.com\/jobs\/159648-/)
    expect(jobs[0].applyUrl).toBe(jobs[0].url)
    expect(jobs[0].externalId).toBe('159648')
    expect(jobs[0].description).not.toContain('<')
  })

  it('converts hourly pay to a yearly amount', () => {
    expect(jobs[1]).toMatchObject({ salaryMin: 52000, employmentType: 'Part-time' })
  })

  it('reads the older date style as UTC and takes an employer link from the description', () => {
    expect(jobs[2].postedAt).toBe('2026-11-05T12:00:00.000Z')
    expect(jobs[2]).toMatchObject({ ats: 'lever', atsToken: 'acme-games', atsJobId: '0a1b2c3d-1111-2222-3333-444455556666' })
    expect(jobs[2].url).toContain('jobicy.com')
  })

  it('applies a query on top of the tag filter', () => {
    expect(parseJobicy(fixtureJson('jobicy.json'), { query: 'tutor' })).toHaveLength(1)
  })
})

describe('fetchJobicy', () => {
  it('sends the tag and region', async () => {
    const seen = stubFetch({ 'https://jobicy.com/api/v2/remote-jobs?count=50&tag=unity&geo=usa': { json: fixtureJson('jobicy.json') } })
    const jobs = await fetchJobicy({ tag: 'unity', geo: 'usa' })
    expect(jobs).toHaveLength(3)
    expect(seen).toHaveLength(1)
  })
})
