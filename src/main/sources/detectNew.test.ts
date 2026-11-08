import { describe, expect, it } from 'vitest'
import { detectAts, READABLE_ATS, withAtsIdentity } from './detect'
import { findAtsLink, payPeriodFrom, yearlyPay } from './feeds'

describe('detectAts for Rippling, Breezy and Personio', () => {
  it('reads Rippling boards and postings', () => {
    expect(detectAts('https://ats.rippling.com/rippling/jobs')).toMatchObject({ ats: 'rippling', token: 'rippling', jobId: null })
    expect(detectAts('https://ats.rippling.com/rippling/jobs/ef0b7266-678c-4a23-a439-1a5e7362b604')).toMatchObject({
      ats: 'rippling',
      token: 'rippling',
      jobId: 'ef0b7266-678c-4a23-a439-1a5e7362b604'
    })
    expect(detectAts('ats.rippling.com/en-GB/acme-corp/jobs/abc-123')).toMatchObject({ token: 'acme-corp', jobId: 'abc-123' })
    expect(detectAts('https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs/abc')).toMatchObject({ ats: 'rippling', token: 'rippling', jobId: 'abc' })
    expect(detectAts('https://ats.rippling.com/')).toBeNull()
    expect(detectAts('https://www.rippling.com/careers')).toBeNull()
  })

  it('reads Breezy boards and postings', () => {
    expect(detectAts('https://acme.breezy.hr')).toMatchObject({ ats: 'breezy', token: 'acme', jobId: null })
    expect(detectAts('https://acme.breezy.hr/p/98323abf2296-employee-12')).toMatchObject({ ats: 'breezy', token: 'acme', jobId: '98323abf2296' })
    expect(detectAts('https://jobs.breezy.hr/p/493d0eedba0f-sales-executive/apply')).toMatchObject({ token: 'jobs', jobId: '493d0eedba0f' })
    expect(detectAts('https://breezy.hr/pricing')).toBeNull()
    expect(detectAts('https://app.breezy.hr/x')).toBeNull()
  })

  it('reads Personio boards and postings on both domains', () => {
    expect(detectAts('https://demo.jobs.personio.de')).toMatchObject({ ats: 'personio', token: 'demo', jobId: null })
    expect(detectAts('https://demo.jobs.personio.de/job/1822268?language=en#apply')).toMatchObject({ token: 'demo', jobId: '1822268' })
    expect(detectAts('https://acme-gmbh.jobs.personio.com/job/42')).toMatchObject({ token: 'acme-gmbh', jobId: '42' })
    expect(detectAts('https://www.personio.de/jobs')).toBeNull()
    expect(detectAts('https://jobs.personio.de/')).toBeNull()
  })

  it('lists the three families as readable', () => {
    expect(READABLE_ATS).toEqual(expect.arrayContaining(['rippling', 'breezy', 'personio']))
  })

  it('fills in the identity of a posting from a job board', () => {
    const base = { url: 'https://jobicy.com/jobs/1', ats: 'unknown' as const, atsToken: null as string | null }
    expect(withAtsIdentity({ ...base, applyUrl: 'https://acme.breezy.hr/p/98323abf2296-role' })).toMatchObject({ ats: 'breezy', atsToken: 'acme', atsJobId: '98323abf2296' })
    expect(withAtsIdentity({ ...base, applyUrl: 'https://demo.jobs.personio.de/job/7' })).toMatchObject({ ats: 'personio', atsToken: 'demo', atsJobId: '7' })
    expect(withAtsIdentity({ ...base, applyUrl: 'https://ats.rippling.com/acme/jobs' })).toMatchObject({ ats: 'unknown' })
  })
})

describe('feed helpers', () => {
  it('finds the first posting link on a readable system', () => {
    const html = '<p>See <a href="https://boards.greenhouse.io/acme">our board</a> or <a href="https://job-boards.greenhouse.io/acme/jobs/55?gh_src=x">the role</a>.</p>'
    expect(findAtsLink(html)).toBe('https://job-boards.greenhouse.io/acme/jobs/55?gh_src=x')
    expect(findAtsLink('<a href="https://acme.wd5.myworkdayjobs.com/en/Site/job/Place/Title_R-1">x</a>')).toBeNull()
    expect(findAtsLink('plain text')).toBeNull()
    expect(findAtsLink('Apply at https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666.')).toBe('https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666')
  })

  it('converts pay to a yearly amount', () => {
    expect(yearlyPay(50, 60, payPeriodFrom('hourly'), 'usd')).toEqual({ min: 104000, max: 124800, currency: 'USD' })
    expect(yearlyPay(5000, 6000, payPeriodFrom('MONTH'), 'EUR')).toEqual({ min: 60000, max: 72000, currency: 'EUR' })
    expect(yearlyPay(12_000_000, 14_000_000, payPeriodFrom('annual'), 'JPY')).toEqual({ min: 12_000_000, max: 14_000_000, currency: 'JPY' })
    expect(yearlyPay(null, null, 'year', 'USD')).toBeNull()
    expect(yearlyPay(5, 6, 'year', 'USD')).toBeNull()
    expect(payPeriodFrom('')).toBeNull()
  })
})
