import { describe, expect, it } from 'vitest'
import { breezyDetailFromPage, fetchBreezyBoard, parseBreezyJob } from './breezy'
import { fixtureJson, fixtureText, stubFetch, useFastHttp } from './testHelpers'

useFastHttp()

const list = fixtureJson<any[]>('breezy-list.json')
const page = fixtureText('breezy-posting.html')

describe('breezy', () => {
  it('reads the JobPosting block of a posting page', () => {
    const detail = breezyDetailFromPage(page)
    expect(detail?.jobLocationType).toBe('TELECOMMUTE')
    expect(detail?.description).toContain('Sales Executive')
    expect(breezyDetailFromPage('<html></html>')).toBeNull()
  })

  it('combines the list item and the page', () => {
    const job = parseBreezyJob(list[0], breezyDetailFromPage(page), 'jobs')
    expect(job).toMatchObject({
      source: 'breezy',
      ats: 'breezy',
      atsToken: 'jobs',
      atsJobId: '493d0eedba0f',
      externalId: '493d0eedba0f',
      company: 'Breezy HR',
      title: 'Sales Executive',
      location: 'Mexico City, MX',
      remote: 'remote',
      employmentType: 'Full-time',
      url: 'https://jobs.breezy.hr/p/493d0eedba0f-sales-executive',
      applyUrl: 'https://jobs.breezy.hr/p/493d0eedba0f-sales-executive/apply',
      postedAt: '2026-11-02T21:20:00.447Z'
    })
    expect(job.description).toContain('Sales Executive')
    expect(job.description).not.toContain('<')
  })

  it('reads the pay field and leaves the description empty without a page', () => {
    const job = parseBreezyJob({ ...list[1], salary: '$80,000 - $95,000 / year' }, null, 'breezy')
    expect(job).toMatchObject({ salaryMin: 80000, salaryMax: 95000, employmentType: 'Contract', description: '', company: 'MS Breezy Trial' })
  })
})

describe('fetchBreezyBoard', () => {
  it('reads the list and the pages of new postings', async () => {
    const seen = stubFetch({
      'https://jobs.breezy.hr/json': { json: list },
      'https://jobs.breezy.hr/p/493d0eedba0f-sales-executive': { text: page }
    })
    const result = await fetchBreezyBoard('jobs', null, { isKnown: (id) => id === list[1].id })
    expect(seen).toEqual(['https://jobs.breezy.hr/json', 'https://jobs.breezy.hr/p/493d0eedba0f-sales-executive'])
    expect(result.jobs).toHaveLength(2)
    expect(result.complete).toBe(true)
  })

  it('marks the run incomplete when a page could not be read', async () => {
    stubFetch({ 'https://jobs.breezy.hr/json': { json: list } })
    const result = await fetchBreezyBoard('jobs')
    expect(result.jobs).toHaveLength(0)
    expect(result.complete).toBe(false)
  })

  it('reports an unknown slug', async () => {
    stubFetch({ 'https://nope.breezy.hr/json': { status: 404, text: '<html>Career portal not found</html>' } })
    await expect(fetchBreezyBoard('nope')).rejects.toThrow(/404/)
  })
})
