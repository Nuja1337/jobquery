import { describe, expect, it } from 'vitest'
import { fetchHimalayas, parseHimalayas } from './himalayas'
import { fixtureJson, stubFetch, useFastHttp } from './testHelpers'

useFastHttp()

const NOW = Date.parse('2026-11-08T00:00:00Z')

describe('parseHimalayas', () => {
  const jobs = parseHimalayas(fixtureJson('himalayas.json'), {}, NOW)

  it('keeps the Himalayas page as the url and drops expired jobs', () => {
    expect(jobs).toHaveLength(2)
    const job = jobs[0]
    expect(job).toMatchObject({
      source: 'himalayas',
      remote: 'remote',
      ats: 'unknown',
      atsToken: null,
      company: 'Gardens Interactive',
      title: 'Gameplay Engineer',
      url: 'https://himalayas.app/companies/gardens-interactive/jobs/gameplay-engineer',
      applyUrl: 'https://himalayas.app/companies/gardens-interactive/jobs/gameplay-engineer',
      externalId: 'https://himalayas.app/companies/gardens-interactive/jobs/gameplay-engineer'
    })
    expect(job.url).not.toContain('utm_source')
  })

  it('reads pay, location, date and keeps the attribution line', () => {
    const job = jobs[0]
    expect(job).toMatchObject({ salaryMin: 155000, salaryMax: 171000, salaryCurrency: 'USD', location: 'United States' })
    expect(job.postedAt).toBe(new Date(fixtureJson('himalayas.json').jobs[0].pubDate * 1000).toISOString())
    expect(job.description).toContain('Originally posted on Himalayas')
    expect(job.description).not.toContain('<')
  })

  it('takes the employer posting when the description links to one', () => {
    const job = jobs[1]
    expect(job.url).toContain('himalayas.app')
    expect(job).toMatchObject({
      ats: 'greenhouse',
      atsToken: 'gardens',
      atsJobId: '4412345001',
      applyUrl: 'https://job-boards.greenhouse.io/gardens/jobs/4412345001?gh_src=himalayas'
    })
  })

  it('filters on the query and converts hourly pay', () => {
    expect(parseHimalayas(fixtureJson('himalayas.json'), { query: 'nonexistent-word' }, NOW)).toHaveLength(0)
    const all = parseHimalayas(fixtureJson('himalayas.json'), {}, 0)
    expect(all).toHaveLength(3)
    expect(all[2]).toMatchObject({ salaryMin: 83200, salaryMax: 124800, salaryCurrency: 'USD' })
  })
})

describe('fetchHimalayas', () => {
  const page = (n: number, total = 60) => ({
    totalCount: total,
    nextCursor: n < 3 ? `cursor-${n}` : null,
    jobs: Array.from({ length: 20 }, (_, i) => ({
      title: `Engineer ${n}-${i}`,
      companyName: 'Acme',
      description: '<p>Build things.</p>',
      pubDate: 1794000000,
      guid: `https://himalayas.app/companies/acme/jobs/engineer-${n}-${i}`
    }))
  })

  it('pages the browse feed with the cursor', async () => {
    const seen = stubFetch({
      'https://himalayas.app/jobs/api?limit=20': { json: page(1) },
      'https://himalayas.app/jobs/api?limit=20&cursor=cursor-1': { json: page(2) }
    })
    const jobs = await fetchHimalayas({ pages: '2' })
    expect(jobs).toHaveLength(40)
    expect(seen).toHaveLength(2)
  })

  it('uses the search endpoint for a query and stops at the last page', async () => {
    const seen = stubFetch({
      'https://himalayas.app/jobs/api/search?q=game%20engineer&page=1': { json: page(1, 25) },
      'https://himalayas.app/jobs/api/search?q=game%20engineer&page=2': { json: { ...page(2, 25), jobs: page(2).jobs.slice(0, 5) } }
    })
    const jobs = await fetchHimalayas({ query: 'game engineer', pages: '5' })
    expect(jobs).toHaveLength(25)
    expect(seen).toHaveLength(2)
  })
})
