import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, Notification, powerMonitor, powerSaveBlocker, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { PushChannel, PushEvents } from '@shared/api'
import { KeepAwake, shouldKeepAwake } from './background'
import { Notifier } from './notify'
import { createSafeStorageVault } from './secrets'
import { appPaths } from './paths'
import { recordProcessError, registerIpc, type BackgroundControls, type Shutdown } from './ipc'
import { AppTray } from './tray'

// An error nobody caught would otherwise end an unattended run with Electron's error dialog. It goes to the
// activity log, and the app carries on.
process.on('unhandledRejection', (reason) => recordProcessError('A background task failed.', reason))
process.on('uncaughtException', (err) => recordProcessError('An unexpected error happened.', err))

let mainWindow: BrowserWindow | null = null
let shutdown: Shutdown | null = null
let controls: BackgroundControls | null = null
let tray: AppTray | null = null
let notifier: Notifier | null = null
/** Set once the app is really quitting, so closing the window stops hiding it. */
let quitting = false
/** The "keeps running in the tray" note goes out once per session. */
let trayHintShown = false
const keepAwake = new KeepAwake(powerSaveBlocker)

/** Windows starts the app with this flag at sign-in, so the window stays in the tray until the user opens it. */
const LOGIN_ARG = '--hidden'
const startedHidden = process.argv.includes(LOGIN_ARG)
/** Matches build.appId in package.json, which electron-builder gives the Start menu shortcut. */
const APP_USER_MODEL_ID = 'dev.jobpilot.app'

const rendererIndex = path.join(__dirname, '../renderer/index.html')
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined

/** True only for the app's own page. Compares origins and file paths, not raw URL strings. */
function isAppUrl(url: string): boolean {
  try {
    const target = new URL(url)
    if (devUrl) return target.origin === new URL(devUrl).origin
    if (target.protocol !== 'file:') return false
    return path.resolve(fileURLToPath(target)).toLowerCase() === path.resolve(rendererIndex).toLowerCase()
  } catch {
    return false
  }
}

/** Only the main frame of the app's own window may call the API. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame
}

function emit<C extends PushChannel>(channel: C, payload: PushEvents[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  // The same pushes drive the tray, the sleep blocker and the notifications.
  if (channel === 'pipeline:progress' || channel === 'loop:status') {
    syncBackground()
  } else if (channel === 'event:new') {
    const event = payload as PushEvents['event:new']
    if (event.type === 'run_started') syncBackground()
    notifier?.handle(event)
  }
}

/** Brings the sleep blocker and the tray menu in line with the settings and the run state. */
function syncBackground(): void {
  if (!controls) return
  keepAwake.set(shouldKeepAwake(controls.settings(), controls.isRunning()))
  tray?.update()
}

/** Shows the window, bringing it back from the tray or from being minimized. */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Notifications stay referenced until they close, or Electron may drop them before the user clicks. */
const shownNotes = new Set<Notification>()
function showNote(title: string, body: string): void {
  const note = new Notification({ title, body })
  shownNotes.add(note)
  note.on('click', showWindow)
  note.on('close', () => shownNotes.delete(note))
  note.show()
}

let appliedLoginItem: boolean | null = null

/**
 * Registers or removes the start at sign-in entry. In development (an unpackaged app) it does
 * nothing, because the entry would point at the Electron binary and not at JobPilot.
 */
function applyLoginItem(wanted: boolean): void {
  if (!app.isPackaged || appliedLoginItem === wanted) return
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  appliedLoginItem = wanted
  app.setLoginItemSettings({ openAtLogin: wanted, path: process.execPath, args: [LOGIN_ARG] })
}

/** What the system reports about the start at sign-in entry, or null where the app can't register one. */
function loginItemState(): boolean | null {
  if (!app.isPackaged || (process.platform !== 'win32' && process.platform !== 'darwin')) return null
  const state = app.getLoginItemSettings({ path: process.execPath, args: [LOGIN_ARG] })
  return process.platform === 'win32' ? state.openAtLogin && state.executableWillLaunchAtLogin !== false : state.openAtLogin
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'JobPilot',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  // The window only ever shows the app. A dropped link or a redirect can't load another page
  // into it, because that page would get the API bridge.
  const blockForeign = (event: Electron.Event, url: string) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  }
  mainWindow.webContents.on('will-navigate', blockForeign)
  mainWindow.webContents.on('will-redirect', blockForeign)
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  // A start at sign-in leaves the window in the tray until the user opens it.
  mainWindow.on('ready-to-show', () => {
    if (!startedHidden || !tray) mainWindow?.show()
  })

  // With "keep running in the tray" on, the close button hides the window. The tray's Quit and a
  // real shutdown set `quitting` first, so they are not held back.
  mainWindow.on('close', (event) => {
    if (quitting || !tray || !controls?.settings().system.closeToTray) return
    event.preventDefault()
    mainWindow?.hide()
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true
      showNote('JobPilot keeps running in the tray.', 'Open it from the tray icon, or quit it from the tray menu.')
    }
  })
  // Windows is signing out or shutting down.
  mainWindow.on('session-end', () => {
    quitting = true
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Links open in the user's browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(rendererIndex)
  }
}

// JOBPILOT_DATA_DIR points the app at another data folder, for tests and side-by-side profiles.
// Electron's own files and the one-copy-at-a-time lock follow it, so a second profile can run
// while the normal one is open.
if (process.env.JOBPILOT_DATA_DIR) app.setPath('userData', process.env.JOBPILOT_DATA_DIR)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    // Notifications on Windows are filed under this ID. Unpackaged, the Electron binary is the app.
    if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath)
    const paths = appPaths(app.getPath('userData'))
    const vault = await createSafeStorageVault(safeStorage)
    const ipc = await registerIpc({
      ipcMain,
      paths,
      vault,
      emit,
      appVersion: app.getVersion(),
      isTrustedSender,
      updates: { backend: autoUpdater, isPackaged: app.isPackaged, platform: process.platform, quit: () => app.quit() },
      openAtLogin: loginItemState
    })
    shutdown = ipc.shutdown
    controls = ipc.controls

    notifier = new Notifier({
      canNotify: () => Notification.isSupported() && (controls?.settings().system.notifications ?? false),
      show: (note) => showNote(note.title, note.body),
      companyFor: (jobId) => controls?.companyFor(jobId) ?? null
    })
    tray = new AppTray(ipc.controls, {
      open: showWindow,
      quit: () => {
        quitting = true
        app.quit()
      }
    })
    // Settings and the schedule can change from the window or from the tray menu.
    ipc.controls.onChange(() => {
      applyLoginItem(ipc.controls.settings().system.startAtLogin)
      syncBackground()
    })
    applyLoginItem(ipc.controls.settings().system.startAtLogin)
    syncBackground()
    // Timers don't count the time the computer slept, so a run that came due meanwhile is rearmed.
    powerMonitor.on('resume', () => ipc.controls.resume())

    createWindow()
    app.on('activate', showWindow)
  })

  // With the tray running and "keep running in the tray" on, closing the last window leaves the app up.
  app.on('window-all-closed', () => {
    const staysInTray = tray !== null && controls?.settings().system.closeToTray === true
    if (process.platform !== 'darwin' && (quitting || !staysInTray)) app.quit()
  })

  // Hold the quit until the database is written and the automation browser is closed.
  app.on('before-quit', (event) => {
    quitting = true
    if (!shutdown) return
    event.preventDefault()
    const done = shutdown
    shutdown = null
    // The services are about to close, so nothing may read them or hold the PC awake from here on.
    controls = null
    notifier = null
    keepAwake.set(false)
    done()
      .catch(() => {})
      .finally(() => {
        tray?.destroy()
        tray = null
        app.quit()
      })
  })
}
