import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, VOLUME_PRESET, applyPreset } from '@shared/defaults'
import { PRESET_FIELDS, presetChanges } from './presetChanges'

describe('presetChanges', () => {
  it('lists each value that would change, old to new, as a sentence', () => {
    const changes = presetChanges(DEFAULT_SETTINGS, VOLUME_PRESET)
    const by = Object.fromEntries(changes.map((c) => [c.path, c]))
    expect(by['budget.dailyUsd'].sentence).toBe('The daily AI spend limit goes from $1 to $3.')
    expect(by['autopilot.dailySubmitCap'].sentence).toBe('The most applications sent per day goes from 10 to 300.')
    expect(by['autopilot.mode'].sentence).toBe('The autopilot mode goes from on a schedule to continuous.')
    expect(by['autopilot.dryRun'].sentence).toBe('Dry run goes from off to on.')
    expect(by['preferences.companyCooldownDays'].sentence).toBe('The cooldown between applications to one company goes from 90 days to 30 days.')
    expect(by['browser.slowMoMs'].sentence).toBe('The pause between browser actions goes from 60 ms to 25 ms.')
    expect(by['writing.coverLetterLength'].sentence).toBe('The cover letter length goes from medium to short.')
  })

  it('leaves out values that already match', () => {
    const paths = presetChanges(DEFAULT_SETTINGS, VOLUME_PRESET).map((c) => c.path)
    expect(paths).not.toContain('budget.maxTriagePerDay')
    expect(paths).not.toContain('thresholds.shortlistScore')
    expect(paths).not.toContain('system.keepAwake')
  })

  it('finds nothing to change after the preset is applied', () => {
    expect(presetChanges(applyPreset(DEFAULT_SETTINGS, VOLUME_PRESET), VOLUME_PRESET)).toEqual([])
  })

  it('has a name for every setting the volume preset touches', () => {
    const paths = Object.entries(VOLUME_PRESET).flatMap(([group, values]) => Object.keys(values as object).map((k) => `${group}.${k}`))
    for (const path of paths) expect(PRESET_FIELDS[path], path).toBeDefined()
  })

  it('writes one day as "1 day"', () => {
    const current = { ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, companyCooldownDays: 1 } }
    expect(presetChanges(current, { preferences: { companyCooldownDays: 30 } })[0].sentence).toBe('The cooldown between applications to one company goes from 1 day to 30 days.')
  })
})
