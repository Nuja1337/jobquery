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
