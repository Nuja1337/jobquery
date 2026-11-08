import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { applyFilters } from '../pipeline/filters'
import { countryOf, isCountryName, regionOf } from './geo'

describe('countryOf', () => {
  it('reads countries from cities, states and provinces', () => {
    expect(countryOf('San Francisco, CA')).toBe('United States')
    expect(countryOf('Austin, Texas')).toBe('United States')
    expect(countryOf('New York, NY')).toBe('United States')
    expect(countryOf('Toronto, ON')).toBe('Canada')
    expect(countryOf('London, ON')).toBe('Canada')
    expect(countryOf('London, UK')).toBe('United Kingdom')
    expect(countryOf('Cambridge, MA')).toBe('United States')
    expect(countryOf('Berlin')).toBe('Germany')
    expect(countryOf('Bengaluru, India')).toBe('India')
    expect(countryOf('Somewhere')).toBeNull()
  })

  it('tells country names from cities and finds regions', () => {
    expect(isCountryName('USA')).toBe(true)
    expect(isCountryName('United States')).toBe(true)
    expect(isCountryName('Seattle')).toBe(false)
    expect(regionOf('San Jose, CA')).toBe('CA')
    expect(regionOf('California')).toBe('CA')
    expect(regionOf('Vancouver, British Columbia')).toBe('BC')
  })
})

describe('location filter with countries and states', () => {
  const ctx = { now: Date.now(), blockedCompanies: new Set<string>(), lastAppliedAt: () => null }
  const job = (location: string) => ({ company: 'Acme', title: 'Engineer', description: '', location, remote: 'onsite' as const, salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null })
  const prefs = (locations: string[]) => ({ ...DEFAULT_SETTINGS.preferences, locations })

  it('keeps US jobs for a United States preference and drops others', () => {
    expect(applyFilters(job('San Francisco, CA'), prefs(['United States']), ctx).pass).toBe(true)
    expect(applyFilters(job('Austin, TX'), prefs(['USA']), ctx).pass).toBe(true)
    expect(applyFilters(job('Toronto, ON'), prefs(['United States']), ctx).pass).toBe(false)
  })

  it('keeps cities in a preferred state', () => {
    expect(applyFilters(job('San Jose, CA'), prefs(['California']), ctx).pass).toBe(true)
    expect(applyFilters(job('Portland, OR'), prefs(['California']), ctx).pass).toBe(false)
  })
})

describe('region names', () => {
  it('does not read North, South, Latin or Central America as the United States', () => {
    expect(countryOf('North America')).toBeNull()
    expect(countryOf('Remote, South America')).toBeNull()
    expect(countryOf('Latin America')).toBeNull()
    expect(countryOf('Central-America')).toBeNull()
    expect(isCountryName('North America')).toBe(false)
  })

  it('still reads America and the United States of America as the United States', () => {
    expect(countryOf('America')).toBe('United States')
    expect(countryOf('United States of America')).toBe('United States')
    expect(countryOf('Remote, USA')).toBe('United States')
  })
})
