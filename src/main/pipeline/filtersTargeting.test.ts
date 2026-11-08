import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { JobPreferences } from '@shared/types'
import { makeProfile } from '../testing'
import { locationParts } from '../util/geo'
import { type FilterJob, applyFilters, titleSeniority, titleWords } from './filters'
import { prescore } from './prescore'

const NOW = Date.parse('2026-10-30T12:00:00Z')

function prefs(overrides: Partial<JobPreferences> = {}): JobPreferences {
  return { ...structuredClone(DEFAULT_SETTINGS.preferences), ...overrides }
}

function job(overrides: Partial<FilterJob> = {}): FilterJob {
  return { title: 'Software Engineer', company: 'Acme', location: 'Remote', remote: 'remote', salaryMax: null, salaryCurrency: null, postedAt: null, description: 'Build things.', ...overrides }
}

const ctx = { now: NOW, blockedCompanies: new Set<string>(), lastAppliedAt: () => null }

function reasonOf(j: FilterJob, p: JobPreferences): string | null {
  const r = applyFilters(j, p, ctx)
  return r.pass ? null : r.reason
}

describe('title words', () => {
  it('treats engineer, developer, programmer, SDE and SWE as one role noun', () => {
    for (const title of ['Game Developer', 'Game Programmer', 'Game SDE', 'Game SWE 2', 'Games Engineers']) {
      expect(titleWords(title), title).toEqual(['game', 'engineer'])
    }
    expect(titleWords('Software Development Engineer II')).toEqual(['software', 'development', 'engineer'])
  })

  it('treats gameplay as game and design as designer', () => {
    expect(titleWords('Gameplay Programmer')).toEqual(['game', 'engineer'])
    expect(titleWords('Game Design Intern')).toEqual(['game', 'designer'])
  })

  it('drops level markers and keeps words such as 3D', () => {
    expect(titleWords('Software Engineer L5')).toEqual(['software', 'engineer'])
    expect(titleWords('Software Engineer IC3')).toEqual(['software', 'engineer'])
    expect(titleWords('Software Engineer 2')).toEqual(['software', 'engineer'])
    expect(titleWords('3D Artist')).toEqual(['3d', 'artist'])
  })

  it('keeps developer titles when the target says engineer, programmer or SDE', () => {
    const p = prefs({ targetTitles: ['Software Engineer', 'Game Programmer'] })
    for (const title of ['Software Developer', 'SDE II', 'SWE, Payments', 'Gameplay Engineer', 'Game Developer', 'Programmer']) {
      expect(reasonOf(job({ title }), p), title).toBeNull()
    }
    expect(reasonOf(job({ title: 'Registered Nurse' }), p)).toBe("title doesn't match your target roles")
  })
})

describe('seniority from levels and aliases', () => {
  it('reads numbers and roman numerals after a role noun', () => {
    expect(titleSeniority('Software Engineer I')?.level).toBe('junior')
    expect(titleSeniority('Software Engineer 2')?.level).toBe('mid')
    expect(titleSeniority('Software Engineer III')?.level).toBe('senior')
    expect(titleSeniority('SDE 3')?.level).toBe('senior')
    expect(titleSeniority('Software Engineer (II) - Payments')?.level).toBe('mid')
    expect(titleSeniority('Software Engineer, Level 5')?.level).toBe('staff')
  })

  it('reads L, P and IC codes', () => {
    expect(titleSeniority('Software Engineer L3')?.level).toBe('junior')
    expect(titleSeniority('Software Engineer L4')?.level).toBe('mid')
    expect(titleSeniority('L5 Software Engineer')?.level).toBe('senior')
    expect(titleSeniority('Engineer (L6)')?.level).toBe('staff')
    expect(titleSeniority('Engineer P4')?.level).toBe('senior')
    expect(titleSeniority('Engineer IC3')?.level).toBe('mid')
    expect(titleSeniority('Engineer IC5')?.level).toBe('staff')
  })

  it('does not read numbers that are not levels', () => {
    for (const title of ['3D Engine Programmer', 'Unity 6 Developer', 'Software Engineer in Test', 'Windows 11 Engineer', 'Engineer I/O', 'P2P Network Engineer', 'L3Harris Engineer']) {
      expect(titleSeniority(title), title).toBeNull()
    }
  })

  it('reads Snr, Architect, co-op and apprentice', () => {
    expect(titleSeniority('Snr Game Programmer')?.level).toBe('senior')
    expect(titleSeniority('Software Architect')?.level).toBe('staff')
    expect(titleSeniority('Software Developer Co-op')?.level).toBe('intern')
    expect(titleSeniority('Game Design Apprentice')?.level).toBe('intern')
    expect(titleSeniority('Senior Engineer II')?.level).toBe('senior')
  })

  it('drops a level the owner does not want', () => {
    const p = prefs({ seniority: ['junior', 'mid', 'intern'] })
    expect(reasonOf(job({ title: 'Software Engineer III' }), p)).toBe('seniority: III')
    expect(reasonOf(job({ title: 'Software Engineer L6' }), p)).toBe('seniority: l6')
    expect(reasonOf(job({ title: 'Software Engineer II' }), p)).toBeNull()
    expect(reasonOf(job({ title: 'Software Engineer Co-op' }), p)).toBeNull()
  })
})

describe('locations', () => {
  const onsite = (location: string): FilterJob => job({ remote: 'onsite', location })

  it('splits several offices', () => {
    expect(locationParts('New York; London')).toEqual(['New York', 'London'])
    expect(locationParts('Austin, TX | Berlin')).toEqual(['Austin, TX', 'Berlin'])
    expect(locationParts('Austin, TX, New York, NY')).toEqual(['Austin, TX', 'New York, NY'])
    expect(locationParts('Portland, OR')).toEqual(['Portland, OR'])
    expect(locationParts('Austin or Denver')).toEqual(['Austin', 'Denver'])
  })

  it('passes a multi-city job when any city fits', () => {
    expect(reasonOf(onsite('Berlin; Austin, TX'), prefs({ locations: ['United States'] }))).toBeNull()
    expect(reasonOf(onsite('London; Berlin'), prefs({ locations: ['United States'] }))).toBe("location doesn't match")
    expect(reasonOf(onsite('Austin, TX, New York, NY'), prefs({ locations: ['New York'] }))).toBeNull()
    expect(reasonOf(onsite('Toronto, ON; Seattle, WA'), prefs({ locations: ['Washington'] }))).toBeNull()
  })

  it('passes a city the place table does not know and drops a known one', () => {
    const p = prefs({ locations: ['United States'] })
    expect(reasonOf(onsite('Provo'), p)).toBeNull()
    expect(reasonOf(onsite('Kuala Lumpur'), p)).toBeNull()
    expect(reasonOf(onsite('Berlin'), p)).toBe("location doesn't match")
    expect(reasonOf(onsite('Seoul, South Korea'), p)).toBe("location doesn't match")
  })
})

describe('no-sponsorship wording', () => {
  const p = prefs({ needsVisaSponsorship: true })
  const blocked = (text: string) => reasonOf(job({ description: text }), p) === 'says no visa sponsorship'

  it('catches real refusals', () => {
    for (const text of [
      'We do not offer visa sponsorship.',
      'We are unable to sponsor work visas at this time.',
      'We cannot sponsor candidates for this role.',
      "We can't sponsor visas.",
      'The company does not currently provide employment sponsorship.',
      'We will not be able to sponsor.',
      "We aren't able to sponsor H-1B visas.",
      'We are not sponsoring visas for this position.',
      'We are not offering visa sponsorship.',
      'No visa sponsorship is available.',
      'No relocation or visa sponsorship.',
      'Sponsorship is not available for this role.',
      'Visa sponsorship is unavailable.',
      'Visa sponsorship: not available.',
      'Applicants must be authorized to work in the US without sponsorship.',
      'You must be able to work without requiring visa sponsorship.',
      'You must not require sponsorship now or in the future.',
      'Candidates who require visa sponsorship will not be considered.',
      'We do not consider candidates who need sponsorship.',
      'Not eligible for visa sponsorship.',
      'We don’t offer visa sponsorship.'
    ]) {
      expect(blocked(text), text).toBe(true)
    }
  })

  it('lets sentences that only mention sponsorship through', () => {
    for (const text of [
      'We sponsor visas for the right candidate.',
      'Visa sponsorship is available.',
      'Visa sponsorship may be offered for senior roles.',
      'Not sure if we sponsor? Ask the recruiter.',
      'No agencies please. Visa sponsorship is available for this role.',
      'We do not discriminate. Sponsorship is offered to eligible hires.',
      'Open to candidates with or without sponsorship.',
      'We do not sponsor events, but we do sponsor visas.',
      'We are a proud sponsor of the local game jam.',
      'Do you require visa sponsorship? Tell us in the form.',
      'We are not offering a signing bonus, but we do offer relocation and sponsorship.',
      "We can't wait to sponsor your visa."
    ]) {
      expect(blocked(text), text).toBe(false)
    }
  })

  it('does nothing when the owner does not need sponsorship', () => {
    expect(reasonOf(job({ description: 'We do not offer visa sponsorship.' }), prefs())).toBeNull()
  })
})

describe('prescore needs a real hit', () => {
  const profile = makeProfile({ skills: [], experience: [{ company: 'X', title: 'Software Engineer', highlights: [] }] })
  const p = prefs()

  it('gives no title credit for one shared word', () => {
    expect(prescore({ title: 'Mechanical Engineer', description: 'Design pumps.' }, profile, p)).toBe(0)
    expect(prescore({ title: 'Software Engineer', description: '' }, profile, p)).toBe(100)
    expect(prescore({ title: 'Senior Software Developer', description: '' }, profile, p)).toBe(100)
  })

  it('counts developer and programmer titles against engineer targets', () => {
    const games = makeProfile({ skills: [], experience: [] })
    const g = prefs({ targetTitles: ['Game Developer'] })
    expect(prescore({ title: 'Gameplay Programmer', description: '' }, games, g)).toBe(100)
    expect(prescore({ title: 'Game Designer', description: '' }, games, g)).toBe(0)
  })

  it('credits software qualifiers as the second shared word', () => {
    const none = makeProfile({ skills: [], experience: [] })
    const se = prefs({ targetTitles: ['Software Engineer'] })
    const gp = prefs({ targetTitles: ['Game Programmer'] })
    for (const title of ['Backend Engineer', 'Back-end Developer', 'Full Stack Engineer', 'Tools Engineer', 'Engine Programmer', 'Graphics Programmer', 'Unreal Developer', 'Platform Engineers']) {
      expect(prescore({ title, description: '' }, none, se), `${title} vs software`).toBeGreaterThan(0)
      expect(prescore({ title, description: '' }, none, gp), `${title} vs game`).toBeGreaterThan(0)
    }
    for (const title of ['Mechanical Engineer', 'Sales Engineer', 'Civil Engineer']) {
      expect(prescore({ title, description: '' }, none, se), title).toBe(0)
      expect(prescore({ title, description: '' }, none, gp), title).toBe(0)
    }
  })

  it('credits designer qualifiers the same way', () => {
    const none = makeProfile({ skills: [], experience: [] })
    const gd = prefs({ targetTitles: ['Game Designer'] })
    for (const title of ['Level Designer', 'Systems Designer', 'Narrative Designer', 'Combat Design Lead', 'UX Designer']) {
      expect(prescore({ title, description: '' }, none, gd), title).toBeGreaterThan(0)
    }
    for (const title of ['Interior Designer', 'Graphic Designer', 'Fashion Designer']) {
      expect(prescore({ title, description: '' }, none, gd), title).toBe(0)
    }
  })

  it('lets a one-word target match on that word', () => {
    const none = makeProfile({ skills: [], experience: [] })
    expect(prescore({ title: 'Game Developer', description: '' }, none, prefs({ targetTitles: ['Programmer'] }))).toBe(100)
  })
})
