import type { OutgoingHttpHeaders } from 'node:http'
import { RELEASES_URL } from '@shared/defaults'
import type { UpdateStatus } from '@shared/types'

/**
 * The parts of electron-updater's autoUpdater that JobQuery uses. Tests pass a fake.
 *
 * Updates come from the public releases repo set in `build.publish` in package.json. The updater
 * checks each download against the SHA-512 hash in the release's latest.yml before installing it.
 */
export interface UpdaterBackend {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  requestHeaders: OutgoingHttpHeaders | null
  isUpdaterActive(): boolean
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'download-progress', listener: (info: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdaterOptions {
  backend: UpdaterBackend
  currentVersion: string
  isPackaged: boolean
  platform: NodeJS.Platform
  emit: (status: UpdateStatus) => void
  isAutoCheckOn: () => boolean
  /** Saves everything and closes the automation browser. Runs before the installer starts. */
  beforeInstall: () => Promise<void>
  /** Quits the app. Used when the installer fails to start after everything was closed. */
  quit: () => void
  firstCheckDelayMs?: number
  intervalMs?: number
  now?: () => Date
}

/**
 * electron-updater sends a random ID, kept per install, with each check. JobQuery doesn't use
 * staged rollouts, so every install sends this same blank ID and GitHub can't tell them apart.
 */
export const BLANK_INSTALL_ID = '00000000-0000-0000-0000-000000000000'

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** How long to wait for the installer to close the app before quitting by hand. */
const INSTALL_FALLBACK_MS = 15_000

export class Updater {
  private status: UpdateStatus
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private installing = false
  /** macOS installs only signed updates, and JobQuery isn't signed yet, so there it only reports them. */
  private readonly notifyOnly: boolean

  constructor(private readonly o: UpdaterOptions) {
    const active = o.backend.isUpdaterActive()
    this.notifyOnly = o.platform === 'darwin'
    this.status = {
      state: active ? 'idle' : 'disabled',
      currentVersion: o.currentVersion,
      version: null,
      percent: null,
      checkedAt: null,
      message: active ? null : disabledReason(o),
      // An installed copy that can't update itself can still point to the download page.
      downloadUrl: !active && o.isPackaged ? RELEASES_URL : null
    }
    if (!active) return

    const b = o.backend
    b.autoDownload = !this.notifyOnly
    b.autoInstallOnAppQuit = !this.notifyOnly
    b.allowDowngrade = false
    b.allowPrerelease = false
    b.requestHeaders = { ...b.requestHeaders, 'x-user-staging-id': BLANK_INSTALL_ID }

    b.on('checking-for-update', () => this.set({ state: 'checking', message: null }))
    b.on('update-not-available', () => this.set({ state: 'up_to_date', version: null, percent: null, checkedAt: this.now(), downloadUrl: null }))
    b.on('update-available', (info) => {
      if (this.notifyOnly) this.set({ state: 'available', version: info.version, checkedAt: this.now(), downloadUrl: RELEASES_URL })
      else this.set({ state: 'downloading', version: info.version, percent: 0, checkedAt: this.now() })
    })
    b.on('download-progress', (p) => {
      const percent = Math.max(0, Math.min(100, Math.floor(p.percent)))
      if (this.status.state !== 'downloading' || percent !== this.status.percent) this.set({ state: 'downloading', percent })
    })
    b.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version, percent: null }))
    b.on('error', (err) => {
      console.warn('[updater]', err?.message ?? err)
      const message = this.status.state === 'downloading'
        ? "The update didn't finish downloading. JobQuery tries again at the next check."
        : "JobQuery couldn't check for updates. Check your internet connection, or try again later."
      this.set({ state: 'error', percent: null, message })
    })
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** Starts the automatic checks. Each one runs only while automatic checks are on in Settings. */
  start(): void {
    if (this.status.state === 'disabled') return
    this.schedule(this.o.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Checks now and resolves with the status once the check finishes. Errors become an 'error' status. */
  async check(): Promise<UpdateStatus> {
    const { state } = this.status
    // A downloaded update stays until the app restarts, so there's nothing more to check.
    if (state === 'disabled' || state === 'checking' || state === 'downloading' || state === 'ready' || this.installing) return this.status
    try {
      const result = await this.o.backend.checkForUpdates()
      // A failed download also arrives as an 'error' event, which sets the status.
      result?.downloadPromise?.catch(() => {})
    } catch {
      // Same here: the 'error' event already set the status.
    }
    return this.status
  }

  /** Saves everything, then closes the app, installs the update silently and opens the app again. */
  async install(): Promise<void> {
    if (this.status.state !== 'ready') throw new Error('No update is ready to install yet.')
    if (this.installing) return
    this.installing = true
    this.stop()
    try {
      // The installer closes the app about a second after it starts, so the data is saved first.
      await this.o.beforeInstall()
    } catch (err) {
      this.installing = false
      throw err
    }
    this.o.backend.quitAndInstall(true, true)
    // Everything is closed by now. If the installer didn't start, quit so the app isn't left half shut down.
    setTimeout(() => this.o.quit(), INSTALL_FALLBACK_MS).unref?.()
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    if (this.o.isAutoCheckOn()) await this.check()
    this.schedule(this.o.intervalMs ?? CHECK_INTERVAL_MS)
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString()
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.o.emit(this.status)
  }
}

function disabledReason(o: Pick<UpdaterOptions, 'isPackaged' | 'platform'>): string {
  if (!o.isPackaged) return 'Updates work only in the installed app.'
  if (o.platform === 'linux') return 'Updates work only in the AppImage version. Download new versions from the releases page.'
  return "This copy of JobQuery can't update itself. Download new versions from the releases page."
}
