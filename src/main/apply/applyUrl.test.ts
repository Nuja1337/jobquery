import { describe, expect, it } from 'vitest'
import { applyUrlFor } from './prepare'

describe('applyUrlFor for Rippling, Breezy and Personio', () => {
  const base = { applyUrl: null, source: 'breezy' as const }

  it('opens the Breezy application page', () => {
    expect(applyUrlFor({ ...base, ats: 'breezy', url: 'https://acme.breezy.hr/p/98323abf2296-employee-12' })).toBe('https://acme.breezy.hr/p/98323abf2296-employee-12/apply')
    expect(applyUrlFor({ ...base, ats: 'breezy', url: 'https://acme.breezy.hr/p/98323abf2296-employee-12/?source=x' })).toBe('https://acme.breezy.hr/p/98323abf2296-employee-12/apply')
    expect(applyUrlFor({ ...base, ats: 'breezy', url: 'https://acme.breezy.hr/p/98323abf2296-employee-12/apply' })).toBe('https://acme.breezy.hr/p/98323abf2296-employee-12/apply')
  })

  it('opens the Personio form on the posting page', () => {
    expect(applyUrlFor({ ...base, source: 'personio', ats: 'personio', url: 'https://demo.jobs.personio.de/job/1822268?language=en' })).toBe('https://demo.jobs.personio.de/job/1822268#apply')
    expect(applyUrlFor({ ...base, source: 'personio', ats: 'personio', url: 'https://demo.jobs.personio.com/job/42' })).toBe('https://demo.jobs.personio.com/job/42#apply')
  })

  it('uses the Rippling posting address', () => {
    const url = 'https://ats.rippling.com/rippling/jobs/ef0b7266-678c-4a23-a439-1a5e7362b604'
    expect(applyUrlFor({ ...base, source: 'rippling', ats: 'rippling', url })).toBe(url)
    expect(applyUrlFor({ ...base, source: 'rippling', ats: 'rippling', url: `${url}?utm=x` })).toBe(url)
  })

  it('prefers a stored apply address, as for the other systems', () => {
    expect(applyUrlFor({ ...base, ats: 'breezy', url: 'https://acme.breezy.hr/p/1-a', applyUrl: 'https://acme.breezy.hr/p/1-a/apply' })).toBe('https://acme.breezy.hr/p/1-a/apply')
  })

  it('leaves an address that is not on the system alone', () => {
    expect(applyUrlFor({ ...base, ats: 'breezy', url: 'https://acme.com/careers/1' })).toBe('https://acme.com/careers/1')
  })
})
