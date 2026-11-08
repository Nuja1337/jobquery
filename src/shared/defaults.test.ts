import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, VOLUME_PRESET, applyPreset } from './defaults'
import type { Settings } from './types'

describe('applyPreset', () => {
  it('sets every value the preset names', () => {
    const out = applyPreset(DEFAULT_SETTINGS, VOLUME_PRESET)
    expect(out.thresholds).toMatchObject({ shortlistScore: 60, autoPrepareScore: 65, autoSubmitScore: 72 })
    expect(out.budget).toMatchObject({ dailyUsd: 3, monthlyUsd: 60, maxTriagePerDay: 3000, maxPreparePerDay: 400 })
    expect(out.autopilot).toMatchObject({
      enabled: true,
      mode: 'continuous',
      autoPrepare: true,
      autoSubmit: true,
      dryRun: true,
      dailySubmitCap: 300,
      hourlySubmitCap: 40,
      submitConcurrency: 1,
      requireNoFlags: true,
      tickRequiredConsent: true,
      sendSavedUserAnswers: true
    })
    expect(out.preferences).toMatchObject({ perCompanyLimit: 2, companyCooldownDays: 30, maxPostingAgeDays: 21 })
    expect(out.browser.slowMoMs).toBe(25)
    expect(out.writing).toMatchObject({ coverLetterLength: 'short', minLintScore: 75, maxRevisions: 1 })
    expect(out.discovery).toEqual({ autoWatchBoards: true, maxWatchedBoards: 5000, boardsPerRun: 2000 })
    expect(out.system).toMatchObject({ keepAwake: true, closeToTray: true, notifications: true })
  })

  it('keeps everything the preset does not name', () => {
    const mine: Settings = {
      ...DEFAULT_SETTINGS,
      preferences: { ...DEFAULT_SETTINGS.preferences, targetTitles: ['Engineer'], excludedCompanies: ['Acme'], minSalary: 90000 },
      autopilot: { ...DEFAULT_SETTINGS.autopilot, intervalHours: 3 },
      browser: { ...DEFAULT_SETTINGS.browser, channel: 'msedge', keepOpen: true },
      writing: { ...DEFAULT_SETTINGS.writing, bannedPhrases: ['synergy'], styleNotes: 'Dry.' },
      system: { ...DEFAULT_SETTINGS.system, startAtLogin: true },
      onboardingDone: true
    }
    const out = applyPreset(mine, VOLUME_PRESET)
    expect(out.preferences.targetTitles).toEqual(['Engineer'])
    expect(out.preferences.excludedCompanies).toEqual(['Acme'])
    expect(out.preferences.minSalary).toBe(90000)
    expect(out.autopilot.intervalHours).toBe(3)
    expect(out.browser).toMatchObject({ channel: 'msedge', keepOpen: true, slowMoMs: 25 })
    expect(out.writing).toMatchObject({ bannedPhrases: ['synergy'], styleNotes: 'Dry.' })
    expect(out.system.startAtLogin).toBe(true)
    expect(out.onboardingDone).toBe(true)
    expect(out.thresholds.prescoreMin).toBe(DEFAULT_SETTINGS.thresholds.prescoreMin)
  })

  it('does not change its input', () => {
    const before = JSON.stringify(DEFAULT_SETTINGS)
    applyPreset(DEFAULT_SETTINGS, VOLUME_PRESET)
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before)
  })

  it('replaces arrays and ignores undefined', () => {
    const out = applyPreset(DEFAULT_SETTINGS, { preferences: { remote: ['remote'], targetTitles: undefined } })
    expect(out.preferences.remote).toEqual(['remote'])
    expect(out.preferences.targetTitles).toEqual([])
  })

  it('leaves a settings object alone when the preset is empty', () => {
    expect(applyPreset(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS)
  })
})
