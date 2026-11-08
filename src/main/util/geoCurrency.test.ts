import { describe, expect, it } from 'vitest'
import { countryOf, currencyOf, jobCountry, regionNames } from './geo'

describe('currencyOf', () => {
  it('gives the currency of each country the boards use most', () => {
    const expected: Record<string, string> = {
      'United States': 'USD', Canada: 'CAD', 'United Kingdom': 'GBP', Ireland: 'EUR', Germany: 'EUR', France: 'EUR',
      Netherlands: 'EUR', Sweden: 'SEK', Finland: 'EUR', Denmark: 'DKK', Norway: 'NOK', Poland: 'PLN', Spain: 'EUR',
      Italy: 'EUR', Portugal: 'EUR', Switzerland: 'CHF', Austria: 'EUR', Australia: 'AUD', 'New Zealand': 'NZD',
      Japan: 'JPY', Singapore: 'SGD', India: 'INR', Brazil: 'BRL', Mexico: 'MXN'
    }
    for (const [country, currency] of Object.entries(expected)) expect(currencyOf(country), country).toBe(currency)
  })

  it('reads the currency from a location', () => {
    expect(currencyOf('Austin, TX')).toBe('USD')
    expect(currencyOf('Toronto, ON')).toBe('CAD')
    expect(currencyOf('Helsinki')).toBe('EUR')
    expect(currencyOf('Copenhagen, Denmark')).toBe('DKK')
    expect(currencyOf('Oslo')).toBe('NOK')
    expect(currencyOf('Milan, Italy')).toBe('EUR')
    expect(currencyOf('Vienna, Austria')).toBe('EUR')
  })

  it('returns null when the place is unknown', () => {
    expect(currencyOf('Remote')).toBeNull()
    expect(currencyOf('')).toBeNull()
    expect(currencyOf(null)).toBeNull()
  })
})

describe('the added countries', () => {
  it('finds Finland, Denmark, Norway, Italy and Austria', () => {
    expect(countryOf('Helsinki, Finland')).toBe('Finland')
    expect(countryOf('Aarhus')).toBe('Denmark')
    expect(countryOf('Bergen, Norway')).toBe('Norway')
    expect(countryOf('Rome')).toBe('Italy')
    expect(countryOf('Vienna')).toBe('Austria')
  })

  it('keeps North American towns with the same names in North America', () => {
    expect(countryOf('Vienna, VA')).toBe('United States')
    expect(countryOf('Rome, GA')).toBe('United States')
  })
})

describe('jobCountry', () => {
  it('reads the location first and the board country second', () => {
    expect(jobCountry('Berlin, Germany', 'France')).toBe('Germany')
    expect(jobCountry('Remote', 'Germany')).toBe('Germany')
    expect(jobCountry('Remote - US')).toBe('United States')
    expect(jobCountry('Remote', null)).toBeNull()
    expect(jobCountry(null, 'Canada')).toBe('Canada')
    expect(jobCountry(null)).toBeNull()
  })
})

describe('regionNames', () => {
  it('gives both the code and the name of a region', () => {
    expect(regionNames('TX')).toEqual(['TX', 'Texas'])
    expect(regionNames('Texas')).toEqual(['Texas', 'TX'])
    expect(regionNames('ON')).toEqual(['ON', 'Ontario'])
    expect(regionNames('Bavaria')).toEqual(['Bavaria'])
    expect(regionNames('')).toEqual([])
  })
})
