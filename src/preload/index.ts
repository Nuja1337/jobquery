import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Bridge, PushChannel } from '@shared/api'

type Envelope = { ok: true; value: unknown } | { ok: false; error: string; name: string }

// The renderer gets exactly two functions: call an API method, and listen for pushed events.
// Node, the filesystem and the API keys stay in the main process.
const bridge: Bridge = {
  call: (async (method: string, ...args: unknown[]) => {
    const res = (await ipcRenderer.invoke('api', method, args)) as Envelope
    if (res.ok) return res.value
    const err = new Error(res.error)
    err.name = res.name
    throw err
  }) as Bridge['call'],
  on: ((channel: PushChannel, listener: (payload: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }) as Bridge['on']
}

contextBridge.exposeInMainWorld('bridge', bridge)
