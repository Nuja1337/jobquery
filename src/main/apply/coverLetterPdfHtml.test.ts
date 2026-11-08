import { describe, expect, it } from 'vitest'
import { EMPTY_PROFILE } from '@shared/defaults'
import { coverLetterFileName, coverLetterHtml, stripLegalSuffix } from './coverLetterPdf'

const profile = {
  ...EMPTY_PROFILE,
  fullName: 'Sam Rivera',
  email: 'sam@example.com',
  phone: '555 0100',
  location: 'Austin, TX',
  links: { linkedin: 'https://www.linkedin.com/in/samrivera', github: 'github.com/samrivera', portfolio: 'https://sam.dev/', website: 'https://old.example.com', other: [] }
}

describe('stripLegalSuffix', () => {
  it('drops legal endings and the punctuation before them', () => {
    expect(stripLegalSuffix('Riot Games, Inc.')).toBe('Riot Games')
    expect(stripLegalSuffix('Acme Ltd')).toBe('Acme')
    expect(stripLegalSuffix('Nordlicht GmbH')).toBe('Nordlicht')
    expect(stripLegalSuffix('Foo Pty Ltd.')).toBe('Foo')
    expect(stripLegalSuffix('Smith & Co.')).toBe('Smith')
    expect(stripLegalSuffix('Fizz L.L.C.')).toBe('Fizz')
  })

  it('keeps names that only look like they end in a suffix', () => {
    expect(stripLegalSuffix('Inc')).toBe('Inc')
    expect(stripLegalSuffix('The Walt Disney Company')).toBe('The Walt Disney Company')
    expect(stripLegalSuffix('Incredible Games')).toBe('Incredible Games')
    expect(stripLegalSuffix('Foo, Bar Studios')).toBe('Foo, Bar Studios')
  })

  it('shows in the file name', () => {
    expect(coverLetterFileName(profile, 'Riot Games, Inc.')).toBe('Sam Rivera - Cover Letter - Riot Games.pdf')
  })
})

describe('coverLetterHtml', () => {
  const html = coverLetterHtml('Hello there.\n\nThanks.', profile, 'Riot Games, Inc.')

  it('has a title naming the letter', () => {
    expect(html).toContain('<title>Sam Rivera - Cover Letter - Riot Games</title>')
  })

  it('links the email, LinkedIn, GitHub and portfolio in the header', () => {
    expect(html).toContain('<a href="mailto:sam@example.com">sam@example.com</a>')
    expect(html).toContain('<a href="https://www.linkedin.com/in/samrivera">linkedin.com/in/samrivera</a>')
    expect(html).toContain('<a href="https://github.com/samrivera">github.com/samrivera</a>')
    expect(html).toContain('<a href="https://sam.dev/">sam.dev</a>')
    // The personal site is only used when there is no portfolio.
    expect(html).not.toContain('old.example.com')
  })

  it('falls back to the personal site and skips links that are not web addresses', () => {
    const other = coverLetterHtml('Hi.', { ...profile, links: { ...profile.links, portfolio: '', github: 'javascript:alert(1)', linkedin: 'not a link' } })
    expect(other).toContain('<a href="https://old.example.com/">old.example.com</a>')
    expect(other).not.toContain('javascript:')
    expect(other).not.toContain('not a link')
  })

  it('escapes what a person typed', () => {
    const odd = coverLetterHtml('Hi.', { ...profile, fullName: 'Sam <b>', links: { ...profile.links, portfolio: 'https://x.dev/?a="b"' } }, 'A<B>')
    expect(odd).not.toContain('<b>')
    expect(odd).not.toContain('"b"')
  })
})
