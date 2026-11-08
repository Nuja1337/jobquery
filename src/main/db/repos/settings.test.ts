import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { makeTestEnv } from '../../testing'
import { SettingsRepo } from './settings'

describe('SettingsRepo system settings', () => {
  it('defaults to closing to the tray and keeping the PC awake', async () => {
    const { ctx } = await makeTestEnv()
    expect(ctx.settings.get().system).toEqual({ closeToTray: true, startAtLogin: false, keepAwake: true, notifications: true })
  })

  it('fills in the defaults for settings saved before the system section existed', async () => {
    const { ctx } = await makeTestEnv()
    // What an older version of the app left in the database: other sections, no "system" row.
    ctx.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', {
      key: 'autopilot',
      value: JSON.stringify({ ...DEFAULT_SETTINGS.autopilot, enabled: true })
    })
    const loaded = new SettingsRepo(ctx.db).get()
    expect(loaded.autopilot.enabled).toBe(true)
    expect(loaded.system).toEqual(DEFAULT_SETTINGS.system)
  })

  it('fills in the continuous mode settings for settings saved before they existed', async () => {
    const { ctx } = await makeTestEnv()
    // What the previous version saved: whole sections without the new fields.
    const { mode: _mode, hourlySubmitCap: _hourly, submitConcurrency: _tabs, ...autopilot } = DEFAULT_SETTINGS.autopilot
    const { maxTriagePerDay: _triage, maxPreparePerDay: _prepare, ...budget } = DEFAULT_SETTINGS.budget
    const { perCompanyLimit: _limit, ...preferences } = DEFAULT_SETTINGS.preferences
    for (const [key, value] of Object.entries({ autopilot: { ...autopilot, enabled: true, dailySubmitCap: 25 }, budget: { ...budget, dailyUsd: 3 }, preferences: { ...preferences, companyCooldownDays: 30 } })) {
      ctx.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', { key, value: JSON.stringify(value) })
    }
    const loaded = new SettingsRepo(ctx.db).get()
    expect(loaded.autopilot).toEqual({ ...DEFAULT_SETTINGS.autopilot, enabled: true, dailySubmitCap: 25 })
    expect(loaded.autopilot).toMatchObject({ mode: 'interval', submitConcurrency: 1, hourlySubmitCap: 40 })
    expect(loaded.budget).toEqual({ ...DEFAULT_SETTINGS.budget, dailyUsd: 3 })
    expect(loaded.budget).toMatchObject({ maxTriagePerDay: 3000, maxPreparePerDay: 400 })
    expect(loaded.preferences).toEqual({ ...DEFAULT_SETTINGS.preferences, companyCooldownDays: 30 })
    expect(loaded.preferences.perCompanyLimit).toBe(1)
  })

  it('keeps the saved values of a partly saved system section', async () => {
    const { ctx } = await makeTestEnv()
    ctx.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', {
      key: 'system',
      value: JSON.stringify({ closeToTray: false })
    })
    expect(new SettingsRepo(ctx.db).get().system).toEqual({ ...DEFAULT_SETTINGS.system, closeToTray: false })
  })

  it('saves one system toggle without touching the others', async () => {
    const { ctx } = await makeTestEnv()
    ctx.settings.update({ system: { startAtLogin: true } })
    expect(new SettingsRepo(ctx.db).get().system).toEqual({ ...DEFAULT_SETTINGS.system, startAtLogin: true })
  })
})

describe('SettingsRepo employment types', () => {
  it('reads employmentTypes as an empty list for preferences saved without it', async () => {
    const { ctx } = await makeTestEnv()
    const { employmentTypes: _types, ...preferences } = DEFAULT_SETTINGS.preferences
    ctx.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', {
      key: 'preferences',
      value: JSON.stringify({ ...preferences, targetTitles: ['Game Programmer'] })
    })
    const loaded = new SettingsRepo(ctx.db).get().preferences
    expect(loaded.employmentTypes).toEqual([])
    expect(loaded.targetTitles).toEqual(['Game Programmer'])
  })

  it('saves chosen employment types', async () => {
    const { ctx } = await makeTestEnv()
    ctx.settings.update({ preferences: { employmentTypes: ['full_time', 'contract'] } })
    expect(new SettingsRepo(ctx.db).get().preferences.employmentTypes).toEqual(['full_time', 'contract'])
  })
})

describe('SettingsRepo self-identification', () => {
  const put = (ctx: Awaited<ReturnType<typeof makeTestEnv>>['ctx'], value: unknown): void => {
    ctx.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', { key: 'eeo', value: JSON.stringify(value) })
  }

  it('defaults every family to decline', async () => {
    const { ctx } = await makeTestEnv()
    expect(ctx.settings.get().eeo).toEqual(DEFAULT_SETTINGS.eeo)
    expect(ctx.settings.get().eeo).toMatchObject({ version: 2, gender: 'decline', race: [], birthYear: null })
  })

  it('reads a legacy row from the raw stored value', async () => {
    const { ctx } = await makeTestEnv()
    put(ctx, { gender: 'Male', veteran: 'No' })
    expect(new SettingsRepo(ctx.db).get().eeo).toEqual({ ...DEFAULT_SETTINGS.eeo, gender: 'man', veteran: 'not_protected' })
  })

  it('reads a full legacy row, including the whitespace the old card stored', async () => {
    const { ctx } = await makeTestEnv()
    put(ctx, { gender: ' ', race: 'Asian', veteran: 'decline', disability: ' ', pronouns: 'they/them' })
    expect(new SettingsRepo(ctx.db).get().eeo).toEqual({ ...DEFAULT_SETTINGS.eeo, race: ['asian'], pronouns: 'they' })
  })

  it('does not throw on a malformed row', async () => {
    const { ctx } = await makeTestEnv()
    ctx.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', { key: 'eeo', value: '{not json' })
    expect(new SettingsRepo(ctx.db).get().eeo).toEqual(DEFAULT_SETTINGS.eeo)
    put(ctx, [1, 2])
    expect(new SettingsRepo(ctx.db).get().eeo).toEqual(DEFAULT_SETTINGS.eeo)
    put(ctx, { version: 2, race: 'white', gender: 9 })
    expect(new SettingsRepo(ctx.db).get().eeo).toEqual(DEFAULT_SETTINGS.eeo)
  })

  it('round-trips a v2 row through save and read', async () => {
    const { ctx } = await makeTestEnv()
    const eeo = {
      ...DEFAULT_SETTINGS.eeo,
      gender: 'non_binary' as const,
      hispanicLatino: 'no' as const,
      race: ['asian_south' as const, 'white' as const],
      veteran: 'protected' as const,
      veteranCategories: ['recently_separated' as const],
      disability: 'yes' as const,
      sexualOrientation: ['queer' as const],
      pronouns: 'they' as const,
      birthYear: 1992
    }
    ctx.settings.update({ eeo })
    expect(ctx.settings.get().eeo).toEqual(eeo)
    expect(new SettingsRepo(ctx.db).get().eeo).toEqual(eeo)
  })

  it('saves a legacy row as version 2 on the next save', async () => {
    const { ctx } = await makeTestEnv()
    put(ctx, { gender: 'Female' })
    const repo = new SettingsRepo(ctx.db)
    repo.update({ eeo: { race: ['white'] } })
    const stored = JSON.parse(ctx.db.all<{ value: string }>("SELECT value FROM settings WHERE key = 'eeo'")[0].value)
    expect(stored).toMatchObject({ version: 2, gender: 'woman', race: ['white'] })
    expect(new SettingsRepo(ctx.db).get().eeo.gender).toBe('woman')
  })

  it('drops an invalid value in a saved patch instead of storing it', async () => {
    const { ctx } = await makeTestEnv()
    ctx.settings.update({ eeo: { gender: 'Male' as never, birthYear: 12 } })
    expect(ctx.settings.get().eeo).toEqual(DEFAULT_SETTINGS.eeo)
  })

  it('clears a birth year with null', async () => {
    const { ctx } = await makeTestEnv()
    ctx.settings.update({ eeo: { birthYear: 1990 } })
    ctx.settings.update({ eeo: { birthYear: null } })
    expect(new SettingsRepo(ctx.db).get().eeo.birthYear).toBeNull()
  })
})
