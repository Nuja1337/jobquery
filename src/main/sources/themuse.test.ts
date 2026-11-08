import { describe, expect, it } from 'vitest'
import { applyMuseLanding, fetchTheMuse, museApplyLink, parseTheMuse } from './themuse'
import { fixtureJson, fixtureText, stubFetch, useFastHttp } from './testHelpers'

useFastHttp()

describe('parseTheMuse', () => {
  const jobs = parseTheMuse(fixtureJson('themuse.json'))

  it('reads the list fields and points the apply link at the landing page', () => {
    expect(jobs).toHaveLength(3)
    expect(jobs[0]).toMatchObject({
      source: 'themuse',
      externalId: '22094568',
      company: 'Kyndryl',
      title: 'Network and Security engineer',
      location: 'Flexible / Remote; Vienna, Austria',
      remote: 'remote',
      ats: 'unknown',
      url: 'https://www.themuse.com/jobs/kyndryl/network-and-security-engineer-cb8f40',
      applyUrl: 'https://www.themuse.com/jobs/kyndryl/network-and-security-engineer-cb8f40',
      postedAt: '2026-11-04T18:38:26.000Z'
    })
    expect(jobs[0].description).not.toContain('<')
  })

  it('filters on the query', () => {
    expect(parseTheMuse(fixtureJson('themuse.json'), { query: 'fullstack' })).toHaveLength(1)
  })
})

describe('landing pages', () => {
  it('reads a Greenhouse link and sets the ATS identity', () => {
    const job = applyMuseLanding(parseTheMuse(fixtureJson('themuse.json'))[2], fixtureText('themuse-landing-greenhouse.html'))
    expect(job).toMatchObject({
      ats: 'greenhouse',
      atsToken: 'gitlab',
      atsJobId: '8490477002',
      applyUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8490477002?gh_src=8c3e40d12us'
    })
    expect(job.url).toContain('themuse.com')
  })

  it('keeps the employer link when the system is not one JobPilot can read', () => {
    const job = applyMuseLanding(parseTheMuse(fixtureJson('themuse.json'))[1], fixtureText('themuse-landing-workday.html'))
    expect(job.applyUrl).toContain('kyndryl.wd5.myworkdayjobs.com')
    expect(job.ats).toBe('workday')
  })

  it('decodes escaped ampersands in the link', () => {
    expect(museApplyLink(fixtureText('themuse-landing-jobvite.html'))).toBe('https://jobs.jobvite.com/anthology/job/oWFrtfwf/apply?__jvst=Job%20Board&__jvsd=TheMuse')
  })

  it('leaves the job alone when the page has no usable link', () => {
    const job = parseTheMuse(fixtureJson('themuse.json'))[0]
    expect(applyMuseLanding(job, '<html><body>nothing</body></html>')).toEqual(job)
    expect(museApplyLink('{\\"applyLink\\":\\"https://www.themuse.com/jobs/x\\"}')).toBeNull()
  })
})

describe('fetchTheMuse', () => {
  const base = 'https://www.themuse.com/api/public/jobs'
  const query = 'category=Software%20Engineering&level=Mid%20Level&location=Flexible%20%2F%20Remote'
  const params = { category: 'Software Engineering', level: 'Mid Level', location: 'Flexible / Remote' }
  const landing = 'https://www.themuse.com/jobs/gitlab/intermediate-fullstack-engineer-rubyvuejs-growth-aa96ee'

  it('sends the filters, reads the landing page of new jobs and skips known ones', async () => {
    const list = fixtureJson('themuse.json')
    const seen = stubFetch({
      [`${base}?page=1&${query}`]: { json: { ...list, page_count: 1 } },
      [landing]: { text: fixtureText('themuse-landing-greenhouse.html') },
      'https://www.themuse.com/jobs/kyndryl/development-lead-va-dmv': { text: fixtureText('themuse-landing-workday.html') }
    })
    const jobs = await fetchTheMuse(params, undefined, { isKnown: (id) => id === '22094568' })
    expect(jobs).toHaveLength(3)
    expect(jobs.find((j) => j.externalId === '22293325')).toMatchObject({ ats: 'greenhouse', atsToken: 'gitlab' })
    expect(jobs.find((j) => j.externalId === '22094568')?.applyUrl).toContain('themuse.com')
    expect(seen).toHaveLength(3)
    expect(seen).not.toContain('https://www.themuse.com/jobs/kyndryl/network-and-security-engineer-cb8f40')
  })

  it('caps pages and landing fetches', async () => {
    const results = Array.from({ length: 25 }, (_, i) => ({
      id: 1000 + i,
      name: `Engineer ${i}`,
      contents: '<p>Build.</p>',
      publication_date: '2026-11-01T00:00:00Z',
      locations: [{ name: 'Flexible / Remote' }],
      company: { name: 'Acme' },
      refs: { landing_page: `https://www.themuse.com/jobs/acme/engineer-${i}` }
    }))
    const routes: Record<string, { json?: unknown; text?: string }> = {}
    for (let p = 1; p <= 3; p++) routes[`${base}?page=${p}`] = { json: { page: p, page_count: 50, results: results.slice((p - 1) * 8, p * 8) } }
    for (const r of results) routes[r.refs.landing_page] = { text: '<html></html>' }
    const seen = stubFetch(routes)
    const jobs = await fetchTheMuse({}, undefined, { maxPages: 3, landingLimit: 5 })
    expect(jobs).toHaveLength(24)
    expect(seen.filter((u) => u.includes('/api/public/jobs'))).toHaveLength(3)
    expect(seen.filter((u) => !u.includes('/api/public/jobs'))).toHaveLength(5)
  })

  it('keeps the pages already read when the limit is reached', async () => {
    const list = fixtureJson('themuse.json')
    stubFetch({
      [`${base}?page=1`]: { json: { ...list, page_count: 9 } },
      [`${base}?page=2`]: { status: 403, text: 'blocked' }
    })
    const jobs = await fetchTheMuse({}, undefined, { maxPages: 5, landingLimit: 0 })
    expect(jobs).toHaveLength(3)
  })

  it('reports a refusal on the first page', async () => {
    stubFetch({ [`${base}?page=1`]: { status: 403, text: 'blocked' } })
    await expect(fetchTheMuse({}, undefined, { landingLimit: 0 })).rejects.toThrow(/403/)
  })
})
