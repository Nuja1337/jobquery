import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELEASES_URL } from '@shared/defaults'
import type { UpdateStatus } from '@shared/types'
import { BLANK_INSTALL_ID, Updater, type UpdaterBackend, type UpdaterOptions } from './updater'

/** Stands in for electron-updater. Each check plays the events queued in `script`. */
class FakeBackend extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowDowngrade = true
  allowPrerelease = true
  requestHeaders: Record<string, string> | null = null
  active = true
  checks = 0
  installs: Array<[boolean | undefined, boolean | undefined]> = []
  script: Array<() => void> = []

  isUpdaterActive(): boolean {
    return this.active
  }

  async checkForUpdates() {
    this.checks++
    this.emit('checking-for-update')
    for (const step of this.script) step()
    return { downloadPromise: Promise.resolve([]) }
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }
}

function setup(over: Partial<UpdaterOptions> = {}) {
  const backend = new FakeBackend()
  const pushed: UpdateStatus[] = []
  let autoCheck = true
  const beforeInstall = vi.fn(async () => {})
  const quit = vi.fn()
  const make = () =>
    new Updater({
      backend: backend as unknown as UpdaterBackend,
      currentVersion: '0.1.0',
      isPackaged: true,
      platform: 'win32',
      emit: (s) => pushed.push(s),
      isAutoCheckOn: () => autoCheck,
      beforeInstall,
      quit,
      now: () => new Date('2026-11-03T12:00:00Z'),
      ...over
    })
  return { backend, pushed, beforeInstall, quit, make, setAutoCheck: (v: boolean) => (autoCheck = v) }
}

describe('Updater', () => {
  it('is disabled in a development build and never checks', async () => {
    const { backend, make } = setup({ isPackaged: false })
    backend.active = false
    const u = make()
    expect(u.getStatus()).toMatchObject({ state: 'disabled', message: 'Updates work only in the installed app.', downloadUrl: null })
    await u.check()
    expect(backend.checks).toBe(0)
  })

  it('points an installed Linux copy outside the AppImage at the download page', () => {
    const { backend, make } = setup({ platform: 'linux' })
    backend.active = false
    expect(make().getStatus()).toMatchObject({ state: 'disabled', downloadUrl: RELEASES_URL })
  })

  it('downloads automatically on Windows and refuses downgrades and prereleases', () => {
    const { backend, make } = setup()
    make()
    expect(backend).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: false, allowPrerelease: false })
  })

  it('sends the same blank install ID from every copy', () => {
    const { backend, make } = setup()
    make()
    expect(backend.requestHeaders).toEqual({ 'x-user-staging-id': BLANK_INSTALL_ID })
  })

  it('reports a found update through download to ready', async () => {
    const { backend, pushed, make } = setup()
    backend.script = [
      () => backend.emit('update-available', { version: '0.2.0' }),
      () => backend.emit('download-progress', { percent: 41.7 }),
      () => backend.emit('download-progress', { percent: 41.9 }),
      () => backend.emit('update-downloaded', { version: '0.2.0' })
    ]
    const u = make()
    const status = await u.check()
    expect(status).toMatchObject({ state: 'ready', version: '0.2.0', percent: null, checkedAt: '2026-11-03T12:00:00.000Z' })
    // The same whole percent isn't pushed twice.
    expect(pushed.map((s) => [s.state, s.percent])).toEqual([
      ['checking', null],
      ['downloading', 0],
      ['downloading', 41],
      ['ready', null]
    ])
  })

  it("doesn't check again once an update is downloaded", async () => {
    const { backend, make } = setup()
    backend.script = [() => backend.emit('update-available', { version: '0.2.0' }), () => backend.emit('update-downloaded', { version: '0.2.0' })]
    const u = make()
    await u.check()
    await u.check()
    expect(backend.checks).toBe(1)
  })

  it('says when the app is up to date', async () => {
    const { backend, make } = setup()
    backend.script = [() => backend.emit('update-not-available', { version: '0.1.0' })]
    expect(await make().check()).toMatchObject({ state: 'up_to_date', version: null, checkedAt: '2026-11-03T12:00:00.000Z' })
  })

  it('turns a failed check into an error status instead of throwing', async () => {
    const { backend, make } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend.checkForUpdates = async () => {
      backend.checks++
      backend.emit('checking-for-update')
      const err = new Error('net::ERR_INTERNET_DISCONNECTED')
      backend.emit('error', err)
      throw err
    }
    const status = await make().check()
    expect(status.state).toBe('error')
    expect(status.message).toMatch(/couldn't check for updates/)
    warn.mockRestore()
  })

  it('only reports updates on macOS, with a link to the download page', async () => {
    const { backend, make } = setup({ platform: 'darwin' })
    backend.script = [() => backend.emit('update-available', { version: '0.2.0' })]
    const u = make()
    expect(backend.autoDownload).toBe(false)
    expect(backend.autoInstallOnAppQuit).toBe(false)
    expect(await u.check()).toMatchObject({ state: 'available', version: '0.2.0', downloadUrl: RELEASES_URL })
  })

  describe('install', () => {
    it('refuses when nothing is downloaded', async () => {
      const { make, beforeInstall } = setup()
      await expect(make().install()).rejects.toThrow(/No update is ready/)
      expect(beforeInstall).not.toHaveBeenCalled()
    })

    it('saves everything before starting the installer, then reopens the app', async () => {
      const { backend, make, beforeInstall } = setup()
      const order: string[] = []
      beforeInstall.mockImplementation(async () => {
        order.push('saved')
      })
      backend.quitAndInstall = (silent, runAfter) => {
        order.push('install')
        backend.installs.push([silent, runAfter])
      }
      backend.script = [() => backend.emit('update-available', { version: '0.2.0' }), () => backend.emit('update-downloaded', { version: '0.2.0' })]
      const u = make()
      await u.check()
      await u.install()
      expect(order).toEqual(['saved', 'install'])
      expect(backend.installs).toEqual([[true, true]])
    })

    it("doesn't start the installer when saving fails", async () => {
      const { backend, make, beforeInstall } = setup()
      beforeInstall.mockRejectedValue(new Error('disk full'))
      backend.script = [() => backend.emit('update-available', { version: '0.2.0' }), () => backend.emit('update-downloaded', { version: '0.2.0' })]
      const u = make()
      await u.check()
      await expect(u.install()).rejects.toThrow('disk full')
      expect(backend.installs).toEqual([])
    })
  })

  describe('automatic checks', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('checks shortly after launch and then every few hours while turned on', async () => {
      const { backend, make, setAutoCheck } = setup({ firstCheckDelayMs: 1000, intervalMs: 60_000 })
      backend.script = [() => backend.emit('update-not-available', { version: '0.1.0' })]
      const u = make()
      u.start()
      await vi.advanceTimersByTimeAsync(999)
      expect(backend.checks).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(backend.checks).toBe(1)
      setAutoCheck(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(backend.checks).toBe(1)
      setAutoCheck(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(backend.checks).toBe(2)
      u.stop()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(backend.checks).toBe(2)
    })
  })
})

describe('release settings', () => {
  it('sends installed copies to the same page the app links to', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))
    const publish = [pkg.build.publish].flat()[0]
    expect(publish.provider).toBe('github')
    expect(RELEASES_URL).toBe(`https://github.com/${publish.owner}/${publish.repo}/releases/latest`)
  })

  it('names installers without spaces, which GitHub would rename', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))
    for (const target of ['nsis', 'linux']) expect(pkg.build[target].artifactName).not.toMatch(/\s/)
  })
})
