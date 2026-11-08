import { dialog, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
// Inlined into the bundle as data URLs, so the packaged app needs no extra files.
import icon1x from '../../resources/tray.png?inline'
import icon2x from '../../resources/tray@2x.png?inline'
import { statusLine } from './background'
import type { BackgroundControls } from './ipc'

export interface TrayActions {
  /** Shows the main window. */
  open: () => void
  /** Quits the app for real, not just hides the window. */
  quit: () => void
}

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, dataURL: icon1x })
  image.addRepresentation({ scaleFactor: 2, dataURL: icon2x })
  return image
}

/** The icon in the notification area, with a menu that shows what jobpls is doing and can pause it. */
export class AppTray {
  private readonly tray: Tray
  /** What the menu shows now. The menu is only rebuilt when this changes. */
  private shown = ''

  constructor(
    private readonly controls: BackgroundControls,
    private readonly actions: TrayActions
  ) {
    this.tray = new Tray(trayImage())
    this.tray.setToolTip('jobpls')
    this.tray.on('click', () => actions.open())
    this.tray.on('double-click', () => actions.open())
    this.update()
  }

  /** Rebuilds the menu when the status, the autopilot state or the running state changed. */
  update(): void {
    if (this.tray.isDestroyed()) return
    const { autopilot } = this.controls.settings()
    const running = this.controls.isRunning()
    const status = statusLine({ autopilotEnabled: autopilot.enabled, running, progress: this.controls.progress(), nextRunAt: this.controls.nextRunAt(), loop: this.controls.loopStatus() })
    const key = JSON.stringify([status, autopilot.enabled, running])
    if (key === this.shown) return
    this.shown = key

    const items: MenuItemConstructorOptions[] = [
      { label: 'Open jobpls', click: () => this.actions.open() },
      { type: 'separator' },
      { label: status, enabled: false },
      { label: autopilot.enabled ? 'Pause autopilot' : 'Resume autopilot', click: () => void this.toggleAutopilot() },
      { label: 'Run now', enabled: !running, click: () => void this.controls.runNow() },
      { type: 'separator' },
      { label: 'Quit jobpls', click: () => this.actions.quit() }
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  private async toggleAutopilot(): Promise<void> {
    const { autopilot } = this.controls.settings()
    if (!autopilot.enabled && autopilot.autoSubmit && !autopilot.dryRun) {
      // The Settings page asks before this combination starts. The tray asks too.
      const answer = await dialog.showMessageBox({
        type: 'warning',
        title: 'Resume autopilot?',
        message: 'Auto-submit is on, so jobpls will send applications in your name without asking you first.',
        buttons: ['Resume autopilot', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      if (answer.response !== 0) return
    }
    await this.controls.updateSettings({ autopilot: { enabled: !autopilot.enabled } }).catch(() => undefined)
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy()
  }
}
