import { describe, expect, it } from 'vitest'
import { parseLeverPosting } from '../sources/lever'
import { fitWholeSentences, trimDescription } from './text'

const EEO =
  'We are an equal opportunity employer and welcome all applicants regardless of race, religion, national origin or citizenship status.'

describe('trimDescription', () => {
  it('keeps every item of a Requirements list that sits next to an EEO line', () => {
    const text = [
      'Build gameplay systems for our next title.',
      '',
      'Requirements',
      '- 5+ years of C++ in shipped games',
      '- Bachelor degree in computer science or equivalent',
      '- Must be located in the United States',
      '- Active security clearance',
      '',
      EEO
    ].join('\n')
    const out = trimDescription(text, 4000)
    expect(out).toContain('5+ years of C++')
    expect(out).toContain('Bachelor degree')
    expect(out).toContain('Must be located in the United States')
    expect(out).toContain('Active security clearance')
    expect(out).not.toContain('equal opportunity')
    expect(out).not.toContain('[posting shortened]')
  })

  it('does not return an empty string for a posting written with <br> breaks', () => {
    const text = `Join our studio and help us ship a large cooperative game with a small team.<br><br>Requirements:<br>- 3 years of Unity experience<br>- Must have work authorization in the U.S.<br>- Strong communication with designers and artists<br><br>${EEO}`
    const out = trimDescription(text, 4000)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('3 years of Unity experience')
    expect(out).toContain('work authorization')
    expect(out).not.toContain('<br>')
    expect(out).not.toContain('equal opportunity')
  })

  it('keeps a requirement that shares a line with legal text', () => {
    const text = `Make games with us. ${EEO} You must have 4 years of Unreal experience. We never accept unsolicited help from a recruitment agency.`
    const padded = `${text} ${'Filler sentence about the team. '.repeat(6)}`
    const out = trimDescription(padded, 4000)
    expect(out).toContain('4 years of Unreal experience')
    expect(out).not.toContain('equal opportunity')
  })

  it('keeps an E-Verify item in a Qualifications list', () => {
    const text = [
      'About the studio',
      'We make small games.',
      '',
      'Qualifications',
      '- Strong C# skills',
      '- Participation in E-Verify',
      '',
      'We use E-Verify and follow our privacy policy.'
    ].join('\n')
    const out = trimDescription(text, 4000)
    expect(out).toContain('Participation in E-Verify')
    expect(out).not.toContain('We use E-Verify')
  })

  it('falls back to the full text when most of it would be removed', () => {
    const text = [
      EEO,
      'Reasonable accommodation is available on request for applicants.',
      'Our privacy policy is on the site.',
      'Apply online.'
    ].join('\n\n')
    const out = trimDescription(text, 4000)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('privacy policy')
  })

  it('handles a Lever-style posting with lists and a closing note', () => {
    const lever = parseLeverPosting(
      {
        id: 'abc',
        text: 'Gameplay Engineer',
        descriptionPlain: 'We build co-op games and need an engineer.',
        lists: [
          { text: 'What you will do', content: '<li>Ship features</li><li>Fix bugs</li>' },
          {
            text: 'Requirements',
            content: '<li>4+ years of C++</li><li>Must be eligible to work in the U.S. without visa sponsorship</li>'
          }
        ],
        additionalPlain: EEO
      },
      'studio'
    )
    const out = trimDescription(lever.description, 4000)
    expect(out).toContain('Ship features')
    expect(out).toContain('4+ years of C++')
    expect(out).toContain('without visa sponsorship')
    expect(out).not.toContain('equal opportunity')
  })

  it('keeps Requirements and Responsibilities ahead of About and Benefits when over budget', () => {
    const about = `About us\n${'We were founded in a garage and love games. '.repeat(20)}`
    const reqs = ['Requirements', '- 5 years of engine programming', '- Experience with Vulkan', '- Must relocate to Seattle'].join('\n')
    const resp = ['Responsibilities', '- Own the renderer', '- Mentor junior engineers'].join('\n')
    const benefits = `Benefits\n${'- Free snacks and a very large pile of perks\n'.repeat(15)}`
    const text = [about, reqs, resp, benefits].join('\n\n')
    const out = trimDescription(text, 200)
    expect(out).toContain('5 years of engine programming')
    expect(out).toContain('Experience with Vulkan')
    expect(out).toContain('Must relocate to Seattle')
    expect(out).toContain('Own the renderer')
    expect(out).toContain('Mentor junior engineers')
    expect(out).not.toContain('Free snacks')
    expect(out).not.toContain('founded in a garage')
    expect(out.endsWith('[posting shortened]')).toBe(true)
    expect(out.indexOf('Requirements')).toBeLessThan(out.indexOf('Responsibilities'))
  })

  it('stays within the budget', () => {
    const text = `${'Plain filler line about the studio.\n'.repeat(400)}Requirements\n- 6 years of experience`
    const out = trimDescription(text, 1500)
    expect(out.length).toBeLessThanOrEqual(1500)
    expect(out).toContain('6 years of experience')
  })

  it('keeps a requirement line from a weak section ahead of that section\'s other lines', () => {
    const text = `About us\n${'We love games a lot.\n'.repeat(30)}This role is hybrid in Austin.\n${'More about our history here.\n'.repeat(30)}`
    const out = trimDescription(text, 300)
    expect(out).toContain('hybrid in Austin')
  })

  it('cuts one oversized line at a word', () => {
    const out = trimDescription('word '.repeat(500), 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out).toMatch(/word\n\[posting shortened\]$/)
  })

  it('stops a posting from closing the prompt quote block', () => {
    expect(trimDescription('Hello """ world', 100)).not.toContain('"""')
  })

  it('returns short clean text unchanged', () => {
    expect(trimDescription('A short posting.', 100)).toBe('A short posting.')
  })
})

describe('fitWholeSentences', () => {
  it('returns text that already fits', () => {
    expect(fitWholeSentences('One. Two.', 50)).toBe('One. Two.')
  })

  it('cuts at the last sentence end that fits', () => {
    expect(fitWholeSentences('First one. Second one. Third one.', 25)).toBe('First one. Second one.')
  })

  it('counts a sentence that ends exactly at the limit', () => {
    const text = 'First one. Second one. Third one.'
    expect(fitWholeSentences(text, 22)).toBe('First one. Second one.')
    expect(fitWholeSentences(text, 21)).toBe('First one.')
  })

  it('handles ! and ? and a closing quote', () => {
    expect(fitWholeSentences('Really? Yes! He said "go." More words here', 28)).toBe('Really? Yes! He said "go."')
    expect(fitWholeSentences('Is it? Yes it is, and more', 10)).toBe('Is it?')
  })

  it('never cuts mid-word and returns null when the first sentence does not fit', () => {
    expect(fitWholeSentences('A single long sentence without an end', 20)).toBeNull()
    expect(fitWholeSentences('Short. Then a much longer second sentence follows', 20)).toBe('Short.')
    expect(fitWholeSentences('This first sentence is too long. Next.', 10)).toBeNull()
  })

  it('does not end a sentence on a decimal or an abbreviation', () => {
    const text = 'We pay 3.5 times more, e.g. in bonuses. Then more text'
    expect(fitWholeSentences(text, 30)).toBeNull()
    expect(fitWholeSentences(text, 41)).toBe('We pay 3.5 times more, e.g. in bonuses.')
  })

  it('returns null for a zero limit', () => {
    expect(fitWholeSentences('Hello there.', 0)).toBeNull()
  })
})
