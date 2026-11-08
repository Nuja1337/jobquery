import { describe, expect, it } from 'vitest'
import { fetchPersonioBoard, parsePersonio } from './personio'
import { fixtureText, stubFetch, useFastHttp } from './testHelpers'

useFastHttp()

const xml = fixtureText('personio.xml')

describe('parsePersonio', () => {
  const jobs = parsePersonio(xml, 'demo')

  it('reads every position', () => {
    expect(jobs).toHaveLength(4)
    expect(jobs[0]).toMatchObject({
      source: 'personio',
      ats: 'personio',
      atsToken: 'demo',
      atsJobId: '1822268',
      externalId: '1822268',
      company: 'Demo',
      title: 'Bewerberpool',
      location: 'München',
      employmentType: 'Full-time',
      url: 'https://demo.jobs.personio.de/job/1822268',
      applyUrl: 'https://demo.jobs.personio.de/job/1822268#apply',
      postedAt: '2017-03-16T16:25:09.000Z'
    })
  })

  it('joins the description sections with their headings', () => {
    const text = jobs[0].description
    expect(text).toContain('Ihre Aufgaben\n')
    expect(text).toContain('Ihr Profil\n')
    expect(text).toContain('Lorem ipsum dolor sit amet')
    expect(text).not.toContain('<')
    expect(text).not.toContain('CDATA')
  })

  it('uses the sub-company name, infers remote from the office and reads published pay', () => {
    const remote = jobs.find((j) => j.location === 'Remote')
    expect(remote).toBeDefined()
    expect(remote!.remote).toBe('remote')
    expect(remote!.company).toBe('Mutter AG')
    const paid = jobs.find((j) => j.salaryMin)
    expect(paid).toMatchObject({ salaryMin: 45000, salaryMax: 55000, salaryCurrency: 'EUR' })
  })

  it('prefers the name the person gave and the .com domain when told', () => {
    const [job] = parsePersonio(xml, 'demo', 'Demo GmbH', 'com')
    expect(job.company).toBe('Demo GmbH')
    expect(job.url).toBe('https://demo.jobs.personio.com/job/1822268')
  })

  it('returns nothing for an empty board', () => {
    expect(parsePersonio('<?xml version="1.0"?><workzag-jobs>\n\n</workzag-jobs>', 'empty')).toEqual([])
  })
})

describe('fetchPersonioBoard', () => {
  it('falls back to the .com domain after a 404', async () => {
    const seen = stubFetch({ 'https://acme.jobs.personio.com/xml': { text: xml } })
    const jobs = await fetchPersonioBoard('acme')
    expect(seen).toEqual(['https://acme.jobs.personio.de/xml', 'https://acme.jobs.personio.com/xml'])
    expect(jobs[0].url).toBe('https://acme.jobs.personio.com/job/1822268')
  })

  it('reports a slug that neither domain knows', async () => {
    stubFetch({})
    await expect(fetchPersonioBoard('nope')).rejects.toThrow(/404/)
  })

  it('rejects an answer that is not a job feed', async () => {
    stubFetch({ 'https://odd.jobs.personio.de/xml': { text: '<html>Hello</html>' } })
    await expect(fetchPersonioBoard('odd')).rejects.toThrow(/job feed/)
  })
})
