import path from 'node:path'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import type { PushChannel, PushEvents } from '@shared/api'
import { createSafeStorageVault } from './secrets'
import { appPaths } from './paths'
import { registerIpc, type Shutdown } from './ipc'

let mainWindow: BrowserWindow | null = null
let shutdown: Shutdown | null = null

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
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Links open in the user's browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
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
    const paths = appPaths(app.getPath('userData'))
    const vault = createSafeStorageVault(safeStorage)
    shutdown = await registerIpc({ ipcMain, paths, vault, emit, appVersion: app.getVersion() })
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    // Writes the database to disk and closes the automation browser.
    void shutdown?.()
    shutdown = null
  })
}
