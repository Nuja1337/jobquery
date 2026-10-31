import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAdzuna } from './adzuna'
import { parseArbeitnow } from './arbeitnow'
import { parseAshby } from './ashby'
import { findJobPostings, fetchJobByUrl, rawFromJsonLd, rawFromPage } from './byUrl'
import { detectAts } from './detect'
import { parseGreenhouse, parseGreenhouseJob } from './greenhouse'
import { parseHnHeader, parseHnThread, pickLatestThread } from './hn'
import { parseLever, parseLeverPosting } from './lever'
import {
  decodeEntities,
  detectRemote,
  escapedHtmlToPlain,
  findSalaryInText,
  htmlToPlain,
  inferRemote,
  matchesQuery,
  parseSalary,
  toIsoDate
} from './normalize'
import { parseRemoteOk } from './remoteok'
import { parseRemotive } from './remotive'
import { parseSmartRecruitersPosting } from './smartrecruiters'
import { parseWorkable } from './workable'

const fixture = <T = any>(name: string): T => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'))

afterEach(() => vi.unstubAllGlobals())

describe('normalize', () => {
  it('decodes entities and turns escaped HTML into text', () => {
    expect(decodeEntities('R&amp;D &#x2F; QA &#39;ok&#39; &nbsp;x')).toBe("R&D / QA 'ok'  x")
    const text = escapedHtmlToPlain('&lt;h2&gt;Who we are&lt;/h2&gt;&lt;p&gt;We build &amp;amp; ship.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;li&gt;Two&lt;/li&gt;&lt;/ul&gt;')
    expect(text).toContain('Who we are')
    expect(text).toContain('We build & ship.')
    expect(text).toMatch(/\* One/)
    expect(text).not.toContain('<')
  })

  it('leaves link targets out of the text', () => {
    expect(htmlToPlain('<p>See <a href="https://x.test/very/long">our site</a></p>')).toBe('See our site')
  })

  it('reads yearly pay ranges', () => {
    expect(findSalaryInText('The base range for this position is $87,069-$124,385 plus equity.')).toEqual({ min: 87069, max: 124385, currency: 'USD' })
    expect(parseSalary('$211.4K – $290.6K')).toEqual({ min: 211400, max: 290600, currency: 'USD' })
    expect(parseSalary('£60,000 - £75,000 per year')).toEqual({ min: 60000, max: 75000, currency: 'GBP' })
    expect(parseSalary('120,000 - 150,000 EUR')).toEqual({ min: 120000, max: 150000, currency: 'EUR' })
    expect(parseSalary('C$90,000 - C$110,000')).toMatchObject({ currency: 'CAD', min: 90000 })
    expect(parseSalary('Salary: $140,000 to $180,000 USD')).toEqual({ min: 140000, max: 180000, currency: 'USD' })
  })

  it('reads loose pay fields and converts hourly and monthly pay', () => {
    expect(parseSalary('70K-80K', { fieldOnly: true, defaultCurrency: 'USD' })).toEqual({ min: 70000, max: 80000, currency: 'USD' })
    expect(parseSalary('$35,3k- $52k', { fieldOnly: true })).toEqual({ min: 35300, max: 52000, currency: 'USD' })
    expect(parseSalary('OTE $25k - $35k', { fieldOnly: true })).toMatchObject({ min: 25000, max: 35000 })
    expect(parseSalary('$50-$75 /hour', { fieldOnly: true })).toEqual({ min: 104000, max: 156000, currency: 'USD' })
    expect(parseSalary('$5,000 - $6,000 per month', { fieldOnly: true })).toMatchObject({ min: 60000, max: 72000 })
    expect(parseSalary('$150k', { fieldOnly: true })).toEqual({ min: 150000, max: 150000, currency: 'USD' })
  })

  it('ignores numbers that are not pay', () => {
    expect(parseSalary('$1000 per task', { fieldOnly: true })).toBeNull()
    expect(findSalaryInText('Founded 2010-2015. We raised $5 - 10 million. 10-20 people.')).toBeNull()
    expect(parseSalary('', { fieldOnly: true })).toBeNull()
  })

  it('detects remote, hybrid and on-site', () => {
    expect(detectRemote('Remote (US)')).toBe('remote')
    expect(detectRemote('Hybrid - London')).toBe('hybrid')
    expect(detectRemote('On-site, Berlin')).toBe('onsite')
    expect(detectRemote('OnSite')).toBe('onsite')
    expect(detectRemote('Berlin')).toBe('unknown')
    expect(inferRemote({ explicit: 'Hybrid', location: 'Remote' })).toBe('hybrid')
    expect(inferRemote({ location: 'Austin', description: 'This is a fully remote role.' })).toBe('remote')
    expect(inferRemote({ location: 'Austin', description: 'We use hybrid cloud setups.' })).toBe('unknown')
  })

  it('turns dates into ISO strings', () => {
    expect(toIsoDate(1792767640768)).toBe('2026-10-23T15:00:40.768Z')
    expect(toIsoDate(1793397632)).toBe('2026-10-30T22:00:32.000Z')
    expect(toIsoDate('2026-10-27')).toBe('2026-10-27T00:00:00.000Z')
    expect(toIsoDate('2026-04-07T17:12:35.753+00:00')).toBe('2026-04-07T17:12:35.753Z')
    expect(toIsoDate('not a date')).toBeNull()
    expect(toIsoDate(null)).toBeNull()
  })

  it('matches search queries with commas as alternatives', () => {
    expect(matchesQuery('Senior React Native engineer', 'react native, flutter')).toBe(true)
    expect(matchesQuery('Flutter developer', 'react native, flutter')).toBe(true)
    expect(matchesQuery('Go developer', 'react native, flutter')).toBe(false)
    expect(matchesQuery('anything', '')).toBe(true)
  })
})

describe('detectAts', () => {
  it('reads Greenhouse URLs', () => {
    expect(detectAts('https://boards.greenhouse.io/stripe')).toMatchObject({ ats: 'greenhouse', token: 'stripe', jobId: null })
    expect(detectAts('https://job-boards.greenhouse.io/stripe/jobs/8172510')).toMatchObject({ ats: 'greenhouse', token: 'stripe', jobId: '8172510' })
    expect(detectAts('https://boards.greenhouse.io/embed/job_app?for=acme&token=123')).toMatchObject({ token: 'acme', jobId: '123' })
  })

  it('reads Lever, Ashby, Workable and SmartRecruiters URLs', () => {
    expect(detectAts('https://jobs.lever.co/spotify/2a55d6c9-c564')).toMatchObject({ ats: 'lever', token: 'spotify', jobId: '2a55d6c9-c564' })
    expect(detectAts('jobs.ashbyhq.com/ramp/34413f8d-26bf')).toMatchObject({ ats: 'ashby', token: 'ramp', jobId: '34413f8d-26bf' })
    expect(detectAts('https://apply.workable.com/huggingface/j/81B46579FE/')).toMatchObject({ ats: 'workable', token: 'huggingface', jobId: '81B46579FE' })
    expect(detectAts('https://apply.workable.com/huggingface/')).toMatchObject({ ats: 'workable', token: 'huggingface', jobId: null })
    expect(detectAts('https://jobs.smartrecruiters.com/SmartRecruiters/744000158320111-senior-lead-engineering-operations-manager')).toMatchObject({
      ats: 'smartrecruiters',
      token: 'SmartRecruiters',
      jobId: '744000158320111'
    })
  })

  it('reads Workday and Recruitee URLs', () => {
    expect(detectAts('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin/Engineer_R12345')).toMatchObject({
      ats: 'workday',
      token: 'acme',
      jobId: 'R12345'
    })
    expect(detectAts('https://acme-labs.recruitee.com/o/backend-engineer')).toMatchObject({ ats: 'recruitee', token: 'acme-labs', jobId: 'backend-engineer', companyName: 'Acme Labs' })
  })

  it('returns null for other sites and bad input', () => {
    expect(detectAts('https://example.com/careers')).toBeNull()
    expect(detectAts('not a url at all')).toBeNull()
    expect(detectAts('')).toBeNull()
  })
})

describe('company board parsers', () => {
  it('Greenhouse: decodes escaped content and keeps ids and dates', () => {
    const jobs = parseGreenhouse(fixture('greenhouse.json'), 'stripe')
    expect(jobs).toHaveLength(3)
    expect(jobs[0]).toMatchObject({
      source: 'greenhouse',
      externalId: '8172510',
      company: 'Stripe',
      title: 'Abuse Investigator',
      location: 'Seattle, San Francisco, New York City',
      ats: 'greenhouse',
      atsToken: 'stripe',
      postedAt: '2026-09-09T14:50:29.000Z'
    })
    expect(jobs[0].description).toContain('About Stripe')
    expect(jobs[0].description).not.toMatch(/&lt;|<h2>/)
    expect(jobs[0].applyUrl).toContain('greenhouse.io/stripe/jobs/8172510')
  })

  it('Greenhouse: prefers the stored company name and parses a single posting', () => {
    const job = parseGreenhouseJob(fixture('greenhouse-single.json'), 'stripe', 'Stripe, Inc.')
    expect(job.company).toBe('Stripe, Inc.')
    expect(job.externalId).toBe('8172510')
  })

  it('Lever: builds the description from the sections and reads pay and workplace type', () => {
    const jobs = parseLever(fixture('lever.json'), 'spotify', 'Spotify')
    expect(jobs).toHaveLength(3)
    expect(jobs[0]).toMatchObject({
      source: 'lever',
      externalId: '2a55d6c9-c564-443a-be3e-a3851db5a93b',
      location: 'New York, NY',
      remote: 'hybrid',
      salaryMin: 87069,
      salaryMax: 124385,
      employmentType: 'Permanent',
      postedAt: '2026-10-23T15:00:40.768Z',
      url: 'https://jobs.lever.co/spotify/2a55d6c9-c564-443a-be3e-a3851db5a93b'
    })
    expect(jobs[0].description).toContain("What You'll Do")
    expect(jobs[2].salaryCurrency).toBe('CAD')
    expect(parseLeverPosting(fixture('lever-single.json'), 'spotify').atsToken).toBe('spotify')
  })

  it('Lever: uses the salaryRange field when present', () => {
    const posting = { ...fixture('lever.json')[1], salaryRange: { currency: 'USD', interval: 'per-year-salary', min: 100000, max: 130000 } }
    expect(parseLeverPosting(posting, 'spotify')).toMatchObject({ salaryMin: 100000, salaryMax: 130000, salaryCurrency: 'USD' })
  })

  it('Ashby: reads compensation, workplace type and employment type', () => {
    const jobs = parseAshby(fixture('ashby.json'), 'ramp', 'Ramp')
    expect(jobs[0]).toMatchObject({
      source: 'ashby',
      externalId: '34413f8d-26bf-4bbc-8ade-eb309a0e2245',
      title: 'Security Engineer, Cloud',
      remote: 'hybrid',
      salaryMin: 211400,
      salaryMax: 290600,
      salaryCurrency: 'USD',
      employmentType: 'Full-time'
    })
    expect(jobs[1].remote).toBe('onsite')
    expect(jobs[1].url).toContain('jobs.ashbyhq.com/ramp/')
  })

  it('Ashby: skips postings that are not listed', () => {
    const json = fixture('ashby.json')
    json.jobs[0].isListed = false
    expect(parseAshby(json, 'ramp')).toHaveLength(2)
  })

  it('SmartRecruiters: joins the list item and its detail', () => {
    const list = fixture('smartrecruiters-list.json')
    const detail = fixture('smartrecruiters-detail.json')
    const job = parseSmartRecruitersPosting(list.content[0], detail, 'SmartRecruiters', 'SmartRecruiters')
    expect(job).toMatchObject({
      source: 'smartrecruiters',
      externalId: '744000158320111',
      title: 'Senior / Lead Engineering Operations Manager',
      remote: 'remote',
      employmentType: 'Full-time',
      atsToken: 'SmartRecruiters'
    })
    expect(job.description.length).toBeGreaterThan(100)
    expect(job.url).toContain('jobs.smartrecruiters.com')
    // A posting that was listed but not fetched has no description yet.
    expect(parseSmartRecruitersPosting(list.content[0], null, 'SmartRecruiters', 'SmartRecruiters').description).toBe('')
  })

  it('Workable: reads the widget feed', () => {
    const jobs = parseWorkable(fixture('workable.json'), 'huggingface')
    expect(jobs).toHaveLength(3)
    expect(jobs[0]).toMatchObject({
      source: 'workable',
      externalId: '81B46579FE',
      company: 'Hugging Face',
      remote: 'remote',
      employmentType: 'Full-time',
      location: 'Paris, Île-de-France, France'
    })
    expect(jobs[0].description).toContain('Hugging Face')
  })
})

describe('aggregator parsers', () => {
  it('Remotive: keeps its own url and reads the salary text', () => {
    const jobs = parseRemotive(fixture('remotive.json'))
    expect(jobs).toHaveLength(4)
    expect(jobs[0]).toMatchObject({ source: 'remotive', externalId: '2091135', company: 'Lemon.io', remote: 'remote', employmentType: 'Full-time' })
    expect(jobs[0].url).toMatch(/^https:\/\/remotive\.com\//)
    expect(jobs[1]).toMatchObject({ salaryMin: 70000, salaryMax: 80000, salaryCurrency: 'USD', employmentType: 'Freelance' })
    expect(jobs[3]).toMatchObject({ salaryMin: 104000, salaryMax: 156000 })
    expect(jobs[0].description).not.toContain('<p>')
  })

  it('RemoteOK: skips the legal notice and keeps the remoteok link', () => {
    const jobs = parseRemoteOk(fixture('remoteok.json'))
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ source: 'remoteok', externalId: '1137603', company: 'GEV Wind Power', remote: 'remote' })
    expect(jobs[0].url.toLowerCase()).toContain('remoteok.com')
    expect(jobs[1]).toMatchObject({ salaryMin: 80000, salaryMax: 100000, salaryCurrency: 'USD' })
    expect(parseRemoteOk(fixture('remoteok.json'), 'front end')).toHaveLength(1)
  })

  it('Arbeitnow: filters by query and location', () => {
    const json = fixture('arbeitnow.json')
    const all = parseArbeitnow(json)
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({ source: 'arbeitnow', company: 'BringLiesel GmbH' })
    expect(parseArbeitnow(json, { query: 'customer success' })).toHaveLength(1)
    expect(parseArbeitnow(json, { query: 'zzzz' })).toHaveLength(0)
    expect(parseArbeitnow(json, { location: 'hamburg' }).map((j) => j.location)).toContain('Hamburg')
  })

  it('HN: reads the first line of each comment', () => {
    const jobs = parseHnThread(fixture('hn-thread.json'))
    expect(jobs).toHaveLength(4)
    const sidekick = jobs.find((j) => j.company === 'Sidekick Labs')!
    expect(sidekick).toMatchObject({
      source: 'hn_whoishiring',
      externalId: '49922609',
      remote: 'remote',
      salaryMin: 170000,
      salaryMax: 230000,
      url: 'https://news.ycombinator.com/item?id=49922609'
    })
    expect(sidekick.title).toContain('Senior SWE')
    const dutch = jobs.find((j) => j.company.startsWith('Open Education'))!
    expect(dutch).toMatchObject({ remote: 'hybrid', location: 'Utrecht, The Netherlands' })
    const dash = jobs.find((j) => j.company === 'PrairieLearn')!
    expect(dash.title).toBe('Full-Stack Software Engineer')
    expect(dash.remote).toBe('remote')
    const noRole = jobs.find((j) => j.company === 'Shepherd')!
    expect(noRole.title).toBe('Open roles at Shepherd')
    expect(noRole.remote).toBe('onsite')
  })

  it('HN: filters by query and picks the newest hiring thread', () => {
    expect(parseHnThread(fixture('hn-thread.json'), 'utrecht')).toHaveLength(1)
    expect(parseHnThread(fixture('hn-thread.json'), 'cobol')).toHaveLength(0)
    expect(pickLatestThread(fixture('hn-search.json').hits)?.objectID).toBe('49922569')
    expect(parseHnHeader('Just a sentence without separators')).toBeNull()
  })

  it('Adzuna: drops predicted salaries and maps the country currency', () => {
    const jobs = parseAdzuna(fixture('adzuna.json'), 'us')
    expect(jobs[0]).toMatchObject({
      source: 'adzuna',
      externalId: '4890123456',
      company: 'Acme Corp',
      salaryMin: 140000,
      salaryMax: 180000,
      salaryCurrency: 'USD',
      employmentType: 'Full-time'
    })
    expect(jobs[1]).toMatchObject({ salaryMin: null, remote: 'remote' })
    expect(parseAdzuna(fixture('adzuna.json'), 'gb')[0].salaryCurrency).toBe('GBP')
  })
})

describe('fetchJobByUrl', () => {
  const page = (body: string) => `<html><head><title>Backend Engineer | Initech</title>${body}</head><body><h1>Backend Engineer</h1><p>Build APIs.</p></body></html>`
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Backend Engineer',
    description: '&lt;p&gt;Build APIs in Go.&lt;/p&gt;',
    datePosted: '2026-10-20',
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: 'Initech' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 130000, maxValue: 160000, unitText: 'YEAR' } }
  }

  function stubFetch(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      seen.push(url)
      const route = routes[url]
      if (!route) return new Response('not found', { status: 404 })
      const body = route.json !== undefined ? JSON.stringify(route.json) : (route.text ?? '')
      return new Response(body, { status: route.status ?? 200 })
    })
    return seen
  }

  it('reads schema.org JobPosting blocks', () => {
    const html = page(`<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'WebSite' }, ld] })}</script>`)
    const postings = findJobPostings(html)
    expect(postings).toHaveLength(1)
    const raw = rawFromJsonLd(postings[0], 'https://careers.initech.test/jobs/42')
    expect(raw).toMatchObject({
      source: 'manual',
      company: 'Initech',
      title: 'Backend Engineer',
      location: 'Austin, TX, US',
      employmentType: 'FULL_TIME',
      salaryMin: 130000,
      salaryMax: 160000,
      salaryCurrency: 'USD',
      postedAt: '2026-10-20T00:00:00.000Z'
    })
    expect(raw.description).toBe('Build APIs in Go.')
  })

  it('falls back to the page title and text', () => {
    const raw = rawFromPage(page(''), 'https://careers.initech.test/jobs/42')
    expect(raw.title).toContain('Backend Engineer')
    expect(raw.description).toContain('Build APIs.')
    expect(raw.company).toBe('Initech')
  })

  it('uses the ATS API for a recognised URL', async () => {
    const seen = stubFetch({ 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8172510': { json: fixture('greenhouse-single.json') } })
    const raw = await fetchJobByUrl('https://job-boards.greenhouse.io/stripe/jobs/8172510')
    expect(raw).toMatchObject({ source: 'greenhouse', externalId: '8172510', atsToken: 'stripe' })
    expect(seen).toHaveLength(1)
  })

  it('finds a Lever posting by id and an Ashby posting by listing the board', async () => {
    stubFetch({
      'https://api.lever.co/v0/postings/spotify/2a55d6c9-c564-443a-be3e-a3851db5a93b': { json: fixture('lever-single.json') },
      'https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true': { json: fixture('ashby.json') }
    })
    expect((await fetchJobByUrl('https://jobs.lever.co/spotify/2a55d6c9-c564-443a-be3e-a3851db5a93b')).source).toBe('lever')
    const ashby = await fetchJobByUrl('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245')
    expect(ashby).toMatchObject({ source: 'ashby', title: 'Security Engineer, Cloud' })
  })

  it('falls back to the page when the ATS API has no such posting', async () => {
    const url = 'https://jobs.lever.co/acme/abc-123'
    stubFetch({ [url]: { text: page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`) } })
    const raw = await fetchJobByUrl(url)
    expect(raw).toMatchObject({ source: 'manual', company: 'Initech', ats: 'lever', atsToken: 'acme' })
  })

  it('rejects links that are not http', async () => {
    await expect(fetchJobByUrl('careers page')).rejects.toThrow(/http/)
  })

  it('explains a missing page', async () => {
    stubFetch({})
    await expect(fetchJobByUrl('https://careers.initech.test/gone')).rejects.toThrow(/not found/i)
  })
})
