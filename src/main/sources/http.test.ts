import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, fetchConditional, fetchJson, hostPauseUntil, parseRetryAfter, setHttpClock } from './http'

/** A clock that only moves when something sleeps, so pacing tests run at once. */
function fakeClock(start = 1_000_000) {
  const clock = {
    time: start,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms)
      clock.time += ms
    }
  }
  return clock
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> }

/** Answers each call from the list in order. The last reply repeats. */
function stubFetch(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), headers: init?.headers ?? {} })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
    const status = reply.status ?? 200
    return new Response(status === 304 ? null : JSON.stringify(reply.json ?? {}), { status, headers: reply.headers })
  })
  return calls
}

describe('http pacing', () => {
  let clock: ReturnType<typeof fakeClock>
  beforeEach(() => {
    clock = fakeClock()
    setHttpClock(clock)
  })
  afterEach(() => {
    setHttpClock()
    vi.unstubAllGlobals()
  })

  it('lets three requests to a host go out at once and then spaces them one second apart', async () => {
    stubFetch([{ json: {} }])
    for (let i = 0; i < 3; i++) await fetchJson('https://a.example/x')
    expect(clock.sleeps).toEqual([])
    for (let i = 0; i < 3; i++) await fetchJson('https://a.example/x')
    expect(clock.sleeps).toEqual([1000, 1000, 1000])
  })

  it('refills the bucket while nothing is asked', async () => {
    stubFetch([{ json: {} }])
    for (let i = 0; i < 3; i++) await fetchJson('https://a.example/x')
    clock.time += 5000
    for (let i = 0; i < 3; i++) await fetchJson('https://a.example/x')
    expect(clock.sleeps).toEqual([])
  })

  it('paces each host on its own', async () => {
    stubFetch([{ json: {} }])
    for (let i = 0; i < 3; i++) await fetchJson('https://a.example/x')
    await fetchJson('https://b.example/x')
    expect(clock.sleeps).toEqual([])
  })

  it('paces Workable slower than other hosts', async () => {
    stubFetch([{ json: {} }])
    for (let i = 0; i < 3; i++) await fetchJson('https://apply.workable.com/x')
    expect(clock.sleeps).toEqual([3000])
  })

  it('waits for Retry-After in seconds and retries once', async () => {
    const calls = stubFetch([{ status: 429, headers: { 'retry-after': '7' } }, { json: { ok: true } }])
    expect(await fetchJson('https://a.example/x')).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(clock.sleeps).toEqual([7000])
  })

  it('reads Retry-After as an HTTP date on a 503', async () => {
    const date = new Date(clock.time + 12_000).toUTCString()
    stubFetch([{ status: 503, headers: { 'retry-after': date } }, { json: {} }])
    await fetchJson('https://a.example/x')
    // The date has whole seconds only, so the wait is between 11 and 12 seconds.
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(11_000)
    expect(clock.sleeps[0]).toBeLessThanOrEqual(12_000)
  })

  it('parses Retry-After values', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000)
    expect(parseRetryAfter(new Date(5000).toUTCString(), 0)).toBe(5000)
    expect(parseRetryAfter('soon', 0)).toBeNull()
    expect(parseRetryAfter(null, 0)).toBeNull()
  })

  it('does not retry again after a second 429 and pauses the host for ten minutes', async () => {
    const calls = stubFetch([{ status: 429, headers: { 'retry-after': '1' } }])
    await expect(fetchJson('https://a.example/x')).rejects.toMatchObject({ status: 429 })
    expect(calls).toHaveLength(2)
    const until = hostPauseUntil('a.example')
    expect(until).not.toBeNull()
    expect(until! - clock.time).toBe(10 * 60_000)
    expect(hostPauseUntil('b.example')).toBeNull()
  })

  it('fails fast on a paused host when a signal is given', async () => {
    stubFetch([{ status: 429 }])
    await expect(fetchJson('https://a.example/x')).rejects.toBeInstanceOf(HttpError)
    const calls = stubFetch([{ json: {} }])
    const err = await fetchJson('https://a.example/y', { signal: new AbortController().signal }).catch((e) => e)
    expect(err).toMatchObject({ status: 429 })
    expect((err as HttpError).retryAt).toBe(hostPauseUntil('a.example'))
    expect(calls).toHaveLength(0)
  })

  it('waits out a pause when no signal is given, and the pause ends', async () => {
    stubFetch([{ status: 429 }])
    await expect(fetchJson('https://a.example/x')).rejects.toBeInstanceOf(HttpError)
    const until = hostPauseUntil('a.example')!
    stubFetch([{ json: { ok: 1 } }])
    expect(await fetchJson('https://a.example/y')).toEqual({ ok: 1 })
    expect(clock.time).toBeGreaterThanOrEqual(until)
    expect(hostPauseUntil('a.example')).toBeNull()
  })

  it('does not pause for two 429s more than five minutes apart', async () => {
    stubFetch([{ status: 429 }, { json: {} }])
    // The first call gets a 429, retries, and gets a 200. One 429 is on record.
    await fetchJson('https://a.example/x')
    clock.time += 6 * 60_000
    stubFetch([{ status: 429 }, { json: {} }])
    await fetchJson('https://a.example/x')
    expect(hostPauseUntil('a.example')).toBeNull()
  })

  it('pauses a host that asks for a wait longer than a retry allows', async () => {
    const calls = stubFetch([{ status: 429, headers: { 'retry-after': '300' } }])
    await expect(fetchJson('https://a.example/x')).rejects.toMatchObject({ status: 429 })
    expect(calls).toHaveLength(1)
    expect(hostPauseUntil('a.example')! - clock.time).toBe(300_000)
  })
})

describe('fetchConditional', () => {
  beforeEach(() => setHttpClock(fakeClock()))
  afterEach(() => {
    setHttpClock()
    vi.unstubAllGlobals()
  })

  it('sends the stored validators and returns 304 as a result', async () => {
    const calls = stubFetch([{ status: 304 }])
    const result = await fetchConditional('https://a.example/list', { etag: 'W/"abc"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' })
    expect(result).toEqual({ status: 304 })
    expect(calls[0].headers['If-None-Match']).toBe('W/"abc"')
    expect(calls[0].headers['If-Modified-Since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT')
  })

  it('returns the body and the new validators on a 200', async () => {
    const calls = stubFetch([{ json: { jobs: [1] }, headers: { etag: 'W/"def"', 'last-modified': 'Thu, 22 Oct 2026 07:28:00 GMT' } }])
    const result = await fetchConditional('https://a.example/list')
    expect(result).toEqual({ status: 200, json: { jobs: [1] }, etag: 'W/"def"', lastModified: 'Thu, 22 Oct 2026 07:28:00 GMT' })
    expect(calls[0].headers['If-None-Match']).toBeUndefined()
  })

  it('still throws for other errors', async () => {
    stubFetch([{ status: 404 }])
    await expect(fetchConditional('https://a.example/list', { etag: 'x' })).rejects.toMatchObject({ status: 404 })
  })
})
