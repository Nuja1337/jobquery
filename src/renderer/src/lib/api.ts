import type { Api, Bridge, PushChannel, PushEvents } from '@shared/api'
import { createMockBridge } from './mockApi'

/** True when the renderer runs outside Electron (no preload bridge). The UI then uses sample data. */
export const isDemo = typeof window !== 'undefined' && !window.bridge

const bridge: Bridge = isDemo ? createMockBridge() : window.bridge

/** Typed access to the main process. Every call returns a promise and throws on failure. */
export const api: Api = new Proxy({} as Api, {
  get: (_target, method: string) =>
    (...args: unknown[]) =>
      (bridge.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args)
})

export function onPush<C extends PushChannel>(channel: C, listener: (payload: PushEvents[C]) => void): () => void {
  return bridge.on(channel, listener)
}
