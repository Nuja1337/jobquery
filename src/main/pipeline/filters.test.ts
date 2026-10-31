import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { JobPreferences } from '@shared/types'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { canonicalKey, contentHash, normalizeCompany } from './dedupe'
import { type FilterContext, type FilterJob, applyFilters, groupReason, titleSeniority, titleWords } from './filters'
import { ingestRaw } from './ingest'
import { prescore } from './prescore'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const DAY = 86_400_000

function prefs(overrides: Partial<JobPreferences> = {}): JobPreferences {
  return { ...structuredClone(DEFAULT_SETTINGS.preferences), ...overrides }
}

function job(overrides: Partial<FilterJob> = {}): FilterJob {
  return {
    title: 'Software Engineer',
    company: 'Acme',
    location: 'Remote',
    remote: 'remote',
    salaryMax: null,
    salaryCurrency: null,
    postedAt: new Date(NOW - 2 * DAY).toISOString(),
    description: 'Build web apps in TypeScript.',
    ...overrides
  }
}

function fctx(overrides: Partial<FilterContext> = {}): FilterContext {
  return { now: NOW, blockedCompanies: new Set(), lastAppliedAt: () => null, ...overrides }
}

function reasonOf(j: FilterJob, p: JobPreferences, c: FilterContext = fctx()): string | null {
  const result = applyFilters(j, p, c)
  return result.pass ? null : result.reason
}

describe('applyFilters', () => {
  it('passes everything with default preferences', () => {
    expect(applyFilters(job(), prefs(), fctx())).toEqual({ pass: true })
  })

  it('drops blocked companies, including ones typed in settings', () => {
    expect(reasonOf(job({ company: 'Acme, Inc.' }), prefs(), fctx({ blockedCompanies: new Set(['acme']) }))).toBe('company blocked')
  })

  it('drops excluded title and description words, matching whole words only', () => {
    const p = prefs({ excludeTitleKeywords: ['intern'], excludeDescriptionKeywords: ['clearance'] })
    expect(reasonOf(job({ title: 'Software Engineering Intern' }), p)).toBe('excluded title word: intern')
    expect(reasonOf(job({ title: 'Internal Tools Engineer' }), p)).toBeNull()
    expect(reasonOf(job({ description: 'Requires a security clearance.' }), p)).toBe('excluded description word: clearance')
  })

  it('needs a shared meaningful word with a target title and ignores seniority and plurals', () => {
    const p = prefs({ targetTitles: ['Software Engineer', 'Data Analyst'] })
    expect(reasonOf(job({ title: 'Senior Software Engineers' }), p)).toBeNull()
    expect(reasonOf(job({ title: 'Staff Data Analyst, Growth' }), p)).toBeNull()
    expect(reasonOf(job({ title: 'Head of Sales' }), p)).toBe("title doesn't match your target roles")
    // "Senior" alone is not a shared word.
    expect(reasonOf(job({ title: 'Senior Nurse' }), prefs({ targetTitles: ['Senior Engineer'] }))).toBe("title doesn't match your target roles")
  })

  it('reads seniority from title words', () => {
    expect(titleSeniority('Senior Backend Engineer')?.level).toBe('senior')
    expect(titleSeniority('Staff Engineer')?.level).toBe('staff')
    expect(titleSeniority('Head of Engineering')?.level).toBe('director')
    expect(titleSeniority('VP, Product')?.level).toBe('executive')
    expect(titleSeniority('Software Engineering Intern')?.level).toBe('intern')
    expect(titleSeniority('Product Manager')).toBeNull()
    expect(titleSeniority('Engineering Manager')?.level).toBe('manager')
    expect(titleSeniority('Software Engineer')).toBeNull()
    expect(titleWords('Senior Software Engineers (Remote)')).toEqual(['software', 'engineer'])
  })

  it('drops a seniority the user does not want and lets unlabeled titles through', () => {
    const p = prefs({ seniority: ['mid', 'senior'] })
    expect(reasonOf(job({ title: 'Principal Engineer' }), p)).toBe('seniority: principal')
    expect(reasonOf(job({ title: 'Senior Engineer' }), p)).toBeNull()
    expect(reasonOf(job({ title: 'Software Engineer' }), p)).toBeNull()
  })

  it('checks remote type and ignores unknown', () => {
    const p = prefs({ remote: ['remote'] })
    expect(reasonOf(job({ remote: 'onsite' }), p)).toBe('on-site, you want remote')
    expect(reasonOf(job({ remote: 'hybrid' }), p)).toBe('hybrid, you want remote')
    expect(reasonOf(job({ remote: 'unknown' }), p)).toBeNull()
    expect(reasonOf(job({ remote: 'remote' }), prefs({ remote: ['onsite', 'hybrid'] }))).toBe('remote, you want on-site or hybrid')
  })

  it('checks locations for non-remote jobs and passes vague ones', () => {
    const p = prefs({ locations: ['Berlin', 'San Francisco Bay Area'] })
    expect(reasonOf(job({ remote: 'onsite', location: 'Berlin, Germany' }), p)).toBeNull()
    expect(reasonOf(job({ remote: 'onsite', location: 'San Francisco, CA' }), p)).toBeNull()
    expect(reasonOf(job({ remote: 'onsite', location: 'Austin, TX' }), p)).toBe("location doesn't match")
    expect(reasonOf(job({ remote: 'remote', location: 'Austin, TX' }), p)).toBeNull()
    expect(reasonOf(job({ remote: 'hybrid', location: 'Multiple locations' }), p)).toBeNull()
    expect(reasonOf(job({ remote: 'onsite', location: null }), p)).toBeNull()
  })

  it('drops old postings', () => {
    const p = prefs({ maxPostingAgeDays: 30 })
    expect(reasonOf(job({ postedAt: new Date(NOW - 45 * DAY).toISOString() }), p)).toBe('posted 45 days ago')
    expect(reasonOf(job({ postedAt: new Date(NOW - 10 * DAY).toISOString() }), p)).toBeNull()
    expect(reasonOf(job({ postedAt: null }), p)).toBeNull()
  })

  it('compares pay only when the currency matches', () => {
    const p = prefs({ minSalary: 100000, salaryCurrency: 'USD' })
    expect(reasonOf(job({ salaryMax: 80000, salaryCurrency: 'USD' }), p)).toBe('pay below your minimum')
    expect(reasonOf(job({ salaryMax: 120000, salaryCurrency: 'USD' }), p)).toBeNull()
    expect(reasonOf(job({ salaryMax: 60000, salaryCurrency: 'EUR' }), p)).toBeNull()
    expect(reasonOf(job({ salaryMax: null }), p)).toBeNull()
  })

  it('catches "no visa sponsorship" wording only when the user needs sponsorship', () => {
    const p = prefs({ needsVisaSponsorship: true })
    for (const text of [
      'We do not offer visa sponsorship.',
      'Unfortunately we are unable to sponsor work visas.',
      'Sponsorship is not available for this role.',
      'Candidates must be authorized to work in the US without sponsorship.'
    ]) {
      expect(reasonOf(job({ description: text }), p)).toBe('says no visa sponsorship')
    }
    expect(reasonOf(job({ description: 'We sponsor visas for the right candidate.' }), p)).toBeNull()
    expect(reasonOf(job({ description: 'No visa sponsorship.' }), prefs())).toBeNull()
  })

  it('skips companies applied to recently', () => {
    const c = fctx({ lastAppliedAt: (norm) => (norm === 'acme' ? new Date(NOW - 20 * DAY).toISOString() : null) })
    expect(reasonOf(job({ company: 'Acme Inc' }), prefs({ companyCooldownDays: 90 }), c)).toBe('applied to this company 20 days ago')
    expect(reasonOf(job({ company: 'Acme Inc' }), prefs({ companyCooldownDays: 10 }), c)).toBeNull()
    expect(reasonOf(job({ company: 'Other' }), prefs(), c)).toBeNull()
  })

  it('groups reasons that differ by a number', () => {
    expect(groupReason('posted 45 days ago')).toBe('posted too long ago')
    expect(groupReason('applied to this company 20 days ago')).toBe('applied to this company recently')
    expect(groupReason('keyword match too low (12)')).toBe('keyword match too low')
    expect(groupReason('company blocked')).toBe('company blocked')
  })
})

describe('prescore', () => {
  const profile = makeProfile({ skills: ['TypeScript', 'React', 'Node.js'], experience: [{ company: 'X', title: 'Software Engineer', highlights: [] }] })

  it('returns 50 when there is nothing to compare', () => {
    expect(prescore({ title: 'Anything', description: 'Whatever' }, makeProfile({ skills: [], experience: [] }), prefs())).toBe(50)
  })

  it('scores a matching posting high and an unrelated one low', () => {
    const good = prescore({ title: 'Software Engineer', description: 'TypeScript, React and Node.js every day.' }, profile, prefs())
    const bad = prescore({ title: 'Registered Nurse', description: 'Care for patients on the ward.' }, profile, prefs())
    expect(good).toBeGreaterThanOrEqual(90)
    expect(bad).toBeLessThan(10)
  })

  it('weights the title more than the description', () => {
    const p = makeProfile({ skills: ['React', 'Vue', 'Svelte', 'Angular', 'Rust', 'Elixir'], experience: [] })
    const inTitle = prescore({ title: 'React Specialist', description: 'We hire people.' }, p, prefs())
    const inBody = prescore({ title: 'Specialist', description: 'We use React.' }, p, prefs())
    expect(inTitle).toBeGreaterThan(inBody)
  })

  it('uses target titles and include keywords', () => {
    const p = makeProfile({ skills: [], experience: [] })
    const withTitle = prescore({ title: 'Data Analyst', description: '' }, p, prefs({ targetTitles: ['Data Analyst'] }))
    expect(withTitle).toBe(100)
    const withKeyword = prescore({ title: 'Engineer', description: 'We use Rust.' }, p, prefs({ includeKeywords: ['Rust'] }))
    expect(withKeyword).toBeGreaterThan(0)
  })

  it('handles terms with symbols and matches short terms by case', () => {
    const p = makeProfile({ skills: ['C++', 'R'], experience: [] })
    expect(prescore({ title: 'Engineer', description: 'Daily C++ work.' }, p, prefs())).toBeGreaterThan(0)
    expect(prescore({ title: 'Researcher', description: 'We run experiments for the team.' }, p, prefs())).toBe(0)
    expect(prescore({ title: 'Analyst', description: 'Statistics in R and Python.' }, p, prefs())).toBeGreaterThan(0)
  })
})

describe('dedupe', () => {
  it('normalizes company names', () => {
    expect(normalizeCompany('Acme, Inc.')).toBe('acme')
    expect(normalizeCompany('ACME LLC')).toBe('acme')
    expect(normalizeCompany('Johnson & Johnson')).toBe('johnson and johnson')
    expect(normalizeCompany('Inc')).toBe('inc')
  })

  it('builds the canonical key and a content hash that ignores source and formatting', () => {
    const a = makeRaw({ source: 'greenhouse', externalId: '1', company: 'Acme Inc', title: 'Backend Engineer', description: 'Build APIs.  Fast!' })
    const b = makeRaw({ source: 'remoteok', externalId: '99', company: 'ACME', title: 'backend engineer', description: 'build apis fast' })
    expect(canonicalKey(a)).toBe('greenhouse:acme:1')
    expect(contentHash(a)).toBe(contentHash(b))
    expect(contentHash(a)).not.toBe(contentHash({ ...a, title: 'Frontend Engineer' }))
    expect(contentHash(a)).not.toBe(contentHash({ ...a, description: 'Something else entirely.' }))
  })

  it('only the first 600 characters of the description count', () => {
    const base = 'word '.repeat(150)
    expect(contentHash(makeRaw({ description: `${base} ending one` }))).toBe(contentHash(makeRaw({ description: `${base} ending two` })))
  })

  it('marks a posting seen on another board as a duplicate of the first', async () => {
    const { ctx } = await makeTestEnv()
    const first = ingestRaw(ctx, makeRaw({ source: 'greenhouse', externalId: '1', title: 'Backend Engineer', description: 'Same text.' }))
    const second = ingestRaw(ctx, makeRaw({ source: 'remoteok', externalId: 'r-9', title: 'Backend Engineer', description: 'Same text.' }))
    const third = ingestRaw(ctx, makeRaw({ source: 'remotive', externalId: 'm-3', title: 'Backend Engineer', description: 'Same text.' }))
    expect(first.duplicate).toBe(false)
    expect(second).toMatchObject({ isNew: true, duplicate: true })
    expect(second.job).toMatchObject({ stage: 'duplicate', dupOf: first.job.id })
    expect(third.job.dupOf).toBe(first.job.id)
  })

  it('keeps one role in two offices of the same board as separate jobs', async () => {
    const { ctx } = await makeTestEnv()
    const a = ingestRaw(ctx, makeRaw({ source: 'lever', externalId: 'ny', location: 'New York', description: 'Same text.' }))
    const b = ingestRaw(ctx, makeRaw({ source: 'lever', externalId: 'ldn', location: 'London', description: 'Same text.' }))
    const c = ingestRaw(ctx, makeRaw({ source: 'lever', externalId: 'ny2', location: 'New York', description: 'Same text.' }))
    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(false)
    expect(c.job.dupOf).toBe(a.job.id)
  })

  it('is idempotent for the same posting', async () => {
    const { ctx } = await makeTestEnv()
    const raw = makeRaw({ externalId: 'same' })
    expect(ingestRaw(ctx, raw).isNew).toBe(true)
    const again = ingestRaw(ctx, { ...raw, title: 'Software Engineer II' })
    expect(again.isNew).toBe(false)
    expect(again.job.title).toBe('Software Engineer II')
    expect(ctx.jobs.list({}).total).toBe(1)
  })
})
