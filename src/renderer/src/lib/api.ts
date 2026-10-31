import type { Api, Bridge, PushChannel, PushEvents } from '@shared/api'
import { createMockBridge } from './mockApi'

const hasBridge = typeof window !== 'undefined' && !!window.bridge

/** True when a dev build runs outside Electron (no preload bridge). The UI then uses sample data. */
export const isDemo = import.meta.env.DEV && !hasBridge

/** True when the preload bridge is missing in a real build. The app can't work and says so. */
export const bridgeMissing = !hasBridge && !import.meta.env.DEV

const bridge: Bridge | null = hasBridge ? window.bridge : isDemo ? createMockBridge() : null

/** Typed access to the main process. Every call returns a promise and throws on failure. */
export const api: Api = new Proxy({} as Api, {
  get: (_target, method: string) =>
    (...args: unknown[]) =>
      bridge
        ? (bridge.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args)
        : Promise.reject(new Error("JobPilot couldn't connect to its background process. Restart the app."))
})

export function onPush<C extends PushChannel>(channel: C, listener: (payload: PushEvents[C]) => void): () => void {
  return bridge ? bridge.on(channel, listener) : () => undefined
}
