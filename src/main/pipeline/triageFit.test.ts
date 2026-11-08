import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { ApplicationFacts, JobPreferences, Profile } from '@shared/types'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { renderProfile } from '../writing/prompts'
import { ingestRaw } from './ingest'
import { TRIAGE_BATCH_PROMPT_VERSION, TRIAGE_PROMPT_VERSION, preferencesSummary, scoreJobWithAi, triageContext, triagePrompt } from './triage'

function withApplication(patch: Partial<ApplicationFacts>, profile: Partial<Profile> = {}): Profile {
  const base = makeProfile(profile)
  return { ...base, application: { ...base.application, ...patch } }
}

describe('fit view of the profile', () => {
  it('lists work authorization per country with sponsorship, visa type and expiry', () => {
    const text = renderProfile(
      withApplication({
        authorization: [
          { country: 'Germany', status: 'citizen', needsSponsorship: false, notes: 'EU citizen.' },
          { country: 'United States', status: 'visa', needsSponsorship: true, notes: '', visaType: 'h1b', expires: '2028-03-01', anyEmployer: false },
          { country: 'Canada', status: 'none', needsSponsorship: true, notes: '' }
        ],
        citizenships: ['Germany']
      }),
      'fit'
    )
    expect(text).toContain('Work authorization by country:')
    expect(text).toContain('- Germany: citizen, no sponsorship needed, EU citizen.')
    expect(text).toContain('- United States: work visa (H-1B), needs sponsorship, expires 2028-03-01, any employer: no')
    expect(text).toContain('- Canada: not authorized to work, needs sponsorship')
    expect(text).toContain('Citizenships: Germany')
  })

  it('reads an unanswered any-employer fact as not stated', () => {
    const text = renderProfile(withApplication({ authorization: [{ country: 'United States', status: 'visa', needsSponsorship: false, notes: '', visaType: 'tn', expires: null, anyEmployer: null }] }), 'fit')
    expect(text).toContain('- United States: work visa (TN), no sponsorship needed, any employer: not stated')
  })

  it('keeps the global summary when no country is listed, and drops it when countries are listed', () => {
    const summary = { authorizedCountries: ['Germany'], needsSponsorship: true, notes: '' }
    expect(renderProfile(makeProfile({ workAuthorization: summary }), 'fit')).toContain('Work authorization: Germany, needs visa sponsorship')
    const listed = renderProfile(withApplication({ authorization: [{ country: 'Germany', status: 'citizen', needsSponsorship: false, notes: '' }] }, { workAuthorization: summary }), 'fit')
    expect(listed).not.toContain('Work authorization: Germany')
    expect(listed).toContain('- Germany: citizen')
  })

  it('shows relocation and its places, and reads null as not stated', () => {
    expect(renderProfile(withApplication({ relocation: { willing: true, places: ['Berlin', 'Austin'] } }), 'fit')).toContain('Relocation: willing. Places they would move to: Berlin, Austin')
    expect(renderProfile(withApplication({ relocation: { willing: false, places: [] } }), 'fit')).toContain('Relocation: not willing')
    const unknown = renderProfile(makeProfile(), 'fit')
    expect(unknown).toContain('Relocation: not stated')
    expect(unknown).not.toContain('Relocation: not willing')
  })

  it('shows the work arrangement facts with not stated for unanswered ones', () => {
    const text = renderProfile(
      withApplication({ workArrangement: { remote: true, hybrid: null, onsite: false, maxOfficeDaysPerWeek: 3, commutableCities: ['Seattle'] } }),
      'fit'
    )
    expect(text).toContain('Work arrangement: remote yes; hybrid not stated; on-site no; up to 3 office days a week; can commute to Seattle')
    expect(renderProfile(makeProfile(), 'fit')).toContain('Work arrangement: remote not stated; hybrid not stated; on-site not stated')
  })

  it('shows language levels and clearance', () => {
    const text = renderProfile(
      withApplication({ languageLevels: { English: 'native', German: 'conversational' }, clearance: 'TS/SCI', clearanceEligible: true }, { languages: ['English', 'German', 'French'] }),
      'fit'
    )
    expect(text).toContain('Languages: English (native), German (conversational), French')
    expect(text).toContain('Security clearance held: TS/SCI. Could obtain one: yes')
  })

  it('does not read an unanswered clearance as none', () => {
    expect(renderProfile(makeProfile(), 'fit')).toContain('Security clearance held: not stated. Could obtain one: not stated')
    expect(renderProfile(withApplication({ clearance: 'None', clearanceEligible: false }), 'fit')).toContain('Security clearance held: none. Could obtain one: no')
  })

  it('leaves the writing view without these lines', () => {
    const text = renderProfile(withApplication({ authorization: [{ country: 'Germany', status: 'citizen', needsSponsorship: false, notes: '' }], relocation: { willing: true, places: ['Berlin'] } }, { languages: ['English'] }))
    expect(text).not.toContain('Work authorization by country')
    expect(text).not.toContain('Relocation:')
    expect(text).not.toContain('Security clearance held')
    expect(text).toContain('Languages: English')
  })
})

describe('triage prompt', () => {
  it('has a new version for the changed prompt', () => {
    expect(TRIAGE_PROMPT_VERSION).toBe('triage-v3')
    expect(TRIAGE_BATCH_PROMPT_VERSION).toBe('triage-batch-v2')
  })

  it('derives the sponsorship line from the authorization entries when they exist', () => {
    const prefs: JobPreferences = { ...structuredClone(DEFAULT_SETTINGS.preferences), needsVisaSponsorship: true }
    expect(preferencesSummary(prefs)).toContain('Needs visa sponsorship: yes')
    const profile = withApplication({
      authorization: [
        { country: 'Germany', status: 'citizen', needsSponsorship: false, notes: '' },
        { country: 'United States', status: 'none', needsSponsorship: true, notes: '' }
      ]
    })
    const summary = preferencesSummary(prefs, profile)
    expect(summary).toContain('Needs visa sponsorship in: United States')
    expect(summary).not.toContain('Germany')
    const free = withApplication({ authorization: [{ country: 'Germany', status: 'citizen', needsSponsorship: false, notes: '' }] })
    expect(preferencesSummary(prefs, free)).not.toContain('sponsorship')
  })

  it('lists the employment types wanted', () => {
    const prefs: JobPreferences = { ...structuredClone(DEFAULT_SETTINGS.preferences), employmentTypes: ['full_time', 'contract'] }
    expect(preferencesSummary(prefs)).toContain('Employment types wanted: full_time, contract')
  })

  it('puts the fit facts in the context', () => {
    const context = triageContext(withApplication({ relocation: { willing: true, places: ['Berlin'] } }), DEFAULT_SETTINGS.preferences)
    expect(context).toContain('Places they would move to: Berlin')
  })

  it('shows the level and minimum years a source states', () => {
    const job = { company: 'Acme', title: 'Engineer', location: null, remote: 'remote' as const, salaryMin: null, salaryMax: null, salaryCurrency: null, employmentType: null, postedAt: null, description: 'Text.' }
    expect(triagePrompt({ ...job, seniority: ['mid', 'senior'], minYears: 5 })).toContain('Level stated by the source: mid, senior')
    expect(triagePrompt({ ...job, seniority: ['mid', 'senior'], minYears: 5 })).toContain('Experience stated by the source: at least 5 years')
    expect(triagePrompt({ ...job, minYears: 0 })).toContain('at least 0 years')
    expect(triagePrompt(job)).not.toContain('stated by the source')
  })

  it('sends the fit facts to the model', async () => {
    const env = await makeTestEnv()
    env.ctx.profile.save(withApplication({ relocation: { willing: true, places: ['Berlin'] } }))
    const job = ingestRaw(env.ctx, makeRaw({ externalId: 'a', title: 'Engineer a', seniority: ['senior'], minYears: 4 })).job
    expect(job).toMatchObject({ seniority: ['senior'], minYears: 4 })
    await scoreJobWithAi(env.ctx, job)
    expect(env.llmCalls[0].context).toContain('Places they would move to: Berlin')
    expect(env.llmCalls[0].prompt).toContain('Level stated by the source: senior')
  })
})
