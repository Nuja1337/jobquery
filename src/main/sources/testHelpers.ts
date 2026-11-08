import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { resetHttpState, setHttpClock } from './http'

// Shared by the source tests. Nothing in the app imports this file.

export const fixtureText = (name: string): string => fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8')
export const fixtureJson = <T = any>(name: string): T => JSON.parse(fixtureText(name))

export interface Route {
  status?: number
  json?: unknown
  text?: string
}

/**
 * Replaces global fetch. A route key is the full URL. Unknown URLs answer 404. Returns the list of
 * URLs that were requested, in order. Undo with vi.unstubAllGlobals().
 */
export function stubFetch(routes: Record<string, Route>): string[] {
  const seen: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    seen.push(url)
    const route = routes[url]
    if (!route) return new Response('not found', { status: 404 })
    const body = route.json !== undefined ? JSON.stringify(route.json) : (route.text ?? '')
    return new Response(body, { status: route.status ?? 200 })
  })
  return seen
}

/**
 * Call once at the top of a test file that stubs fetch. The HTTP helper spaces out requests to one host,
 * and this swaps its clock for one that moves forward by the time it is asked to sleep, so a test with many
 * requests does not wait.
 */
export function useFastHttp(): void {
  beforeEach(() => {
    resetHttpState()
    let now = Date.now()
    setHttpClock({
      now: () => now,
      sleep: async (ms) => {
        now += ms
      }
    })
  })
  afterEach(() => {
    setHttpClock()
    vi.unstubAllGlobals()
  })
}
