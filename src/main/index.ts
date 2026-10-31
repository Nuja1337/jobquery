import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import type { PushChannel, PushEvents } from '@shared/api'
import { createSafeStorageVault } from './secrets'
import { appPaths } from './paths'
import { registerIpc, type Shutdown } from './ipc'

let mainWindow: BrowserWindow | null = null
let shutdown: Shutdown | null = null

const rendererIndex = path.join(__dirname, '../renderer/index.html')
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined

/** True only for the app's own pages. Anything else must never reach the API bridge. */
function isAppUrl(url: string): boolean {
  if (devUrl && url.startsWith(devUrl)) return true
  return url.split('#')[0] === pathToFileURL(rendererIndex).href
}

function emit<C extends PushChannel>(channel: C, payload: PushEvents[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // JOBPILOT_DATA_DIR points the app at another data folder, for tests and side-by-side profiles.
    const paths = appPaths(process.env.JOBPILOT_DATA_DIR || app.getPath('userData'))
    const vault = createSafeStorageVault(safeStorage)
    shutdown = await registerIpc({ ipcMain, paths, vault, emit, appVersion: app.getVersion(), isTrustedSender: isAppUrl })
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Hold the quit until the database is written and the automation browser is closed.
  app.on('before-quit', (event) => {
    if (!shutdown) return
    event.preventDefault()
    const done = shutdown
    shutdown = null
    done()
      .catch(() => {})
      .finally(() => app.quit())
  })
}
