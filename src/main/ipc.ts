import type { IpcMain } from 'electron'
import type { PushChannel, PushEvents } from '@shared/api'
import type { KeyVault } from './secrets'
import type { AppPaths } from './paths'

export type Shutdown = () => Promise<void>

export interface IpcDeps {
  ipcMain: IpcMain
  paths: AppPaths
  vault: KeyVault
  emit: <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void
  appVersion: string
}

// Placeholder until the services are wired in. Every call reports that it isn't ready yet.
export async function registerIpc(deps: IpcDeps): Promise<Shutdown> {
  deps.ipcMain.handle('api', async (_event, method: string) => ({
    ok: false,
    error: `${method} is not implemented yet.`,
    name: 'NotImplemented'
  }))
  return async () => {}
}
