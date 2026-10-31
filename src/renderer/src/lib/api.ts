import type { Api, PushChannel, PushEvents } from '@shared/api'

/** Typed access to the main process. Every call returns a promise and throws on failure. */
export const api: Api = new Proxy({} as Api, {
  get: (_target, method: string) =>
    (...args: unknown[]) =>
      (window.bridge.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args)
})

export function onPush<C extends PushChannel>(channel: C, listener: (payload: PushEvents[C]) => void): () => void {
  return window.bridge.on(channel, listener)
}
