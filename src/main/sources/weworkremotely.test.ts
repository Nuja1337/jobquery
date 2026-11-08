import { describe, expect, it } from 'vitest'
import { fetchWeWorkRemotely, parseWeWorkRemotely, splitWwrTitle } from './weworkremotely'
import { fixtureText, stubFetch, useFastHttp } from './testHelpers'

useFastHttp()

describe('parseWeWorkRemotely', () => {
  const jobs = parseWeWorkRemotely(fixtureText('weworkremotely.xml'))

  it('splits the title and keeps the link as the id and url', () => {
    expect(jobs).toHaveLength(4)
    expect(jobs[0]).toMatchObject({
      source: 'weworkremotely',
      company: 'Squarespace',
      title: 'Staff Software Engineer, Revenue Systems',
      location: 'Anywhere in the World',
      remote: 'remote',
      externalId: 'https://weworkremotely.com/remote-jobs/squarespace-staff-software-engineer-revenue-systems',
      url: 'https://weworkremotely.com/remote-jobs/squarespace-staff-software-engineer-revenue-systems',
      ats: 'unknown'
    })
    expect(jobs[0].postedAt).toBe('2026-10-18T07:30:58.000Z')
  })

  it('turns the escaped HTML into text and drops the apply line', () => {
    expect(jobs[0].description).toContain('Squarespace is seeking a talented Staff Software Engineer')
    expect(jobs[0].description).not.toContain('<')
    expect(jobs[0].description).not.toContain('&lt;')
    expect(jobs[0].description).not.toContain('To apply:')
  })

  it('reads pay and an employer link from the description', () => {
    const job = jobs[2]
    expect(job).toMatchObject({ salaryMin: 150000, salaryMax: 180000, salaryCurrency: 'USD', ats: 'greenhouse', atsToken: 'vercel', atsJobId: '5551234004' })
    expect(job.url).toContain('weworkremotely.com')
  })

  it('handles a stray space before the colon and filters on the query', () => {
    expect(splitWwrTitle('Fivetran : Global Alliance Lead, Capgemini')).toEqual({ company: 'Fivetran', title: 'Global Alliance Lead, Capgemini' })
    expect(splitWwrTitle('No colon here')).toBeNull()
    expect(parseWeWorkRemotely(fixtureText('weworkremotely.xml'), { query: 'java' })).toHaveLength(1)
  })
})

describe('fetchWeWorkRemotely', () => {
  it('reads the default category and ignores a bad one', async () => {
    const seen = stubFetch({ 'https://weworkremotely.com/categories/remote-programming-jobs.rss': { text: fixtureText('weworkremotely.xml') } })
    expect(await fetchWeWorkRemotely({})).toHaveLength(4)
    expect(await fetchWeWorkRemotely({ category: '../etc' })).toHaveLength(4)
    expect(seen).toHaveLength(2)
  })

  it('reads several categories and drops repeats', async () => {
    const xml = fixtureText('weworkremotely.xml')
    const seen = stubFetch({
      'https://weworkremotely.com/categories/remote-programming-jobs.rss': { text: xml },
      'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss': { text: xml }
    })
    const jobs = await fetchWeWorkRemotely({ category: 'remote-programming-jobs, remote-devops-sysadmin-jobs.rss' })
    expect(jobs).toHaveLength(4)
    expect(seen).toHaveLength(2)
  })
})
