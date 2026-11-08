import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAshbyBoardChanges } from './ashby'
import { fetchGreenhouseBoardChanges } from './greenhouse'
import { setHttpClock } from './http'
import { fetchLeverBoardChanges } from './lever'
import { fetchWorkableBoardChanges } from './workable'

const fixture = <T = any>(name: string): T => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'))

const LIST = 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs'

interface Reply {
  status?: number
  json?: unknown
  headers?: Record<string, string>
}

/** Answers by URL and records every request with its conditional headers. */
function fakeFetch(routes: Record<string, Reply | ((headers: Record<string, string>) => Reply)>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: { headers?: Record<string, string> }) => {
    const url = String(input)
    const headers = init?.headers ?? {}
    calls.push({ url, headers })
    const route = routes[url]
    if (!route) return new Response('not found', { status: 404 })
    const reply = typeof route === 'function' ? route(headers) : route
    const status = reply.status ?? 200
    return new Response(status === 304 ? null : JSON.stringify(reply.json ?? {}), { status, headers: reply.headers })
  })
  return calls
}

// Waiting moves the clock instead of taking time.
beforeEach(() => {
  let time = 1_000_000
  setHttpClock({
    now: () => time,
    sleep: async (ms) => {
      time += ms
    }
  })
})
afterEach(() => {
  setHttpClock()
  vi.unstubAllGlobals()
})

describe('Greenhouse light read', () => {
  const detail = (id: string) => ({ ...fixture('greenhouse-single.json'), id: Number(id) })

  it('lists without content and fetches only the postings that are not stored', async () => {
    const calls = fakeFetch({
      [LIST]: { json: fixture('greenhouse-light.json'), headers: { etag: 'W/"v1"' } },
      [`${LIST}/8172487`]: { json: detail('8172487') }
    })
    const known = new Set(['8172510', '8172508'])
    const result = await fetchGreenhouseBoardChanges('stripe', 'Stripe', { known })
    expect(calls.map((c) => c.url)).toEqual([LIST, `${LIST}/8172487`])
    expect(calls.some((c) => c.url.includes('content=true'))).toBe(false)
    expect(result).toMatchObject({ changed: true, etag: 'W/"v1"' })
    if (!result.changed) throw new Error('expected a change')
    expect(result.jobs.map((j) => j.externalId)).toEqual(['8172487'])
    expect(result.jobs[0].description.length).toBeGreaterThan(100)
    expect(result.seenExternalIds).toEqual(['8172510', '8172508'])
    expect(result.listHash).toEqual(expect.any(String))
  })

  it('sends the stored ETag and answers unchanged on a 304 with one request', async () => {
    const calls = fakeFetch({ [LIST]: (headers) => (headers['If-None-Match'] === 'W/"v1"' ? { status: 304 } : { json: fixture('greenhouse-light.json') }) })
    const result = await fetchGreenhouseBoardChanges('stripe', 'Stripe', { etag: 'W/"v1"', known: new Set(['8172510']) })
    expect(result).toEqual({ changed: false })
    expect(calls).toHaveLength(1)
  })

  it('answers unchanged when the list is the same although the ETag changed', async () => {
    fakeFetch({ [LIST]: { json: fixture('greenhouse-light.json'), headers: { etag: 'W/"v2"' } } })
    const known = new Set(['8172510', '8172508', '8172487'])
    const a = await fetchGreenhouseBoardChanges('stripe', 'Stripe', { known })
    if (!a.changed) throw new Error('expected a change')
    expect(a.jobs).toEqual([])
    expect(a.seenExternalIds).toHaveLength(3)
    const b = await fetchGreenhouseBoardChanges('stripe', 'Stripe', { listHash: a.listHash, known })
    expect(b).toMatchObject({ changed: false, etag: 'W/"v2"' })
  })

  it('reads a board with many new postings with one full list', async () => {
    const many = { jobs: Array.from({ length: 8 }, (_, i) => ({ ...fixture('greenhouse-light.json').jobs[0], id: 1000 + i })) }
    const calls = fakeFetch({ [LIST]: { json: many }, [`${LIST}?content=true`]: { json: fixture('greenhouse.json') } })
    const result = await fetchGreenhouseBoardChanges('stripe', 'Stripe', { known: new Set() })
    if (!result.changed) throw new Error('expected a change')
    // One list and one full read, instead of one request for each of the eight postings.
    expect(calls.map((c) => c.url)).toEqual([LIST, `${LIST}?content=true`])
    expect(result.jobs).toHaveLength(3)
  })

  it('leaves the validators empty when a posting could not be read, so the next check tries again', async () => {
    fakeFetch({
      [LIST]: { json: fixture('greenhouse-light.json'), headers: { etag: 'W/"v1"' } },
      [`${LIST}/8172487`]: { status: 500 }
    })
    const result = await fetchGreenhouseBoardChanges('stripe', 'Stripe', { known: new Set(['8172510', '8172508']) })
    if (!result.changed) throw new Error('expected a change')
    expect(result.jobs).toEqual([])
    // The posting is still listed, so it is not closed.
    expect(result.seenExternalIds).toContain('8172487')
    expect(result).toMatchObject({ etag: null, listHash: null })
  })

  it('counts requests for a thousand unchanged boards: one each', async () => {
    const calls = fakeFetch({})
    vi.stubGlobal('fetch', async (input: string | URL, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(input), headers: init?.headers ?? {} })
      return new Response(null, { status: 304 })
    })
    for (let i = 0; i < 1000; i++) {
      const result = await fetchGreenhouseBoardChanges(`board${i}`, `Board ${i}`, { etag: 'W/"x"', known: new Set() })
      expect(result).toEqual({ changed: false })
    }
    expect(calls).toHaveLength(1000)
    expect(new Set(calls.map((c) => c.url.split('?')[0].split('/').slice(0, 5).join('/')))).toEqual(new Set(['https://boards-api.greenhouse.io/v1/boards']))
  })
})

describe('Lever and Ashby conditional reads', () => {
  it('Lever: a 304 is unchanged, a 200 returns every posting', async () => {
    const url = 'https://api.lever.co/v0/postings/spotify?mode=json'
    const list = fixture('lever.json')
    const calls = fakeFetch({ [url]: (h) => (h['If-None-Match'] ? { status: 304 } : { json: list, headers: { etag: 'W/"l1"' } }) })
    const fresh = await fetchLeverBoardChanges('spotify', 'Spotify', {})
    if (!fresh.changed) throw new Error('expected a change')
    expect(fresh.jobs).toHaveLength(list.length)
    expect(fresh.etag).toBe('W/"l1"')
    expect(await fetchLeverBoardChanges('spotify', 'Spotify', { etag: 'W/"l1"' })).toEqual({ changed: false })
    expect(calls).toHaveLength(2)
  })

  it('Lever: asks the European API when the global one has no such account, and remembers it', async () => {
    const eu = 'https://api.eu.lever.co/v0/postings/euco?mode=json'
    const calls = fakeFetch({ [eu]: { json: [] , headers: { etag: 'W/"e"' } } })
    await fetchLeverBoardChanges('euco', 'EU Co', {})
    expect(calls.map((c) => c.url)).toEqual(['https://api.lever.co/v0/postings/euco?mode=json', eu])
    calls.length = 0
    await fetchLeverBoardChanges('euco', 'EU Co', { etag: 'W/"e"' })
    expect(calls.map((c) => c.url)).toEqual([eu])
  })

  it('Ashby: a 304 is unchanged, a 200 returns the listed postings', async () => {
    const url = 'https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true'
    const calls = fakeFetch({ [url]: (h) => (h['If-None-Match'] ? { status: 304 } : { json: fixture('ashby.json'), headers: { etag: 'W/"a1"' } }) })
    const fresh = await fetchAshbyBoardChanges('ramp', 'Ramp', {})
    if (!fresh.changed) throw new Error('expected a change')
    expect(fresh.jobs.length).toBeGreaterThan(0)
    expect(await fetchAshbyBoardChanges('ramp', 'Ramp', { etag: 'W/"a1"' })).toEqual({ changed: false })
    expect(calls).toHaveLength(2)
  })
})

describe('Workable light read', () => {
  const account = 'https://apply.workable.com/api/v1/widget/accounts/huggingface'

  it('lists without details and fetches a description only for a posting that is not stored', async () => {
    const board = fixture('workable.json')
    const [first, second] = board.jobs
    const calls = fakeFetch({
      [account]: { json: { name: board.name, jobs: [first, second] } },
      [`https://apply.workable.com/api/v2/accounts/huggingface/jobs/${second.shortcode}`]: {
        json: { description: '<p>Build open-source tools.</p>', requirements: '<p>Python.</p>', benefits: '' }
      }
    })
    const result = await fetchWorkableBoardChanges('huggingface', 'Hugging Face', { known: new Set([first.shortcode]) })
    if (!result.changed) throw new Error('expected a change')
    expect(calls).toHaveLength(2)
    expect(calls.some((c) => c.url.includes('details=true'))).toBe(false)
    expect(result.jobs.map((j) => j.externalId)).toEqual([second.shortcode])
    expect(result.jobs[0].description).toContain('Build open-source tools.')
    expect(result.jobs[0].description).toContain('Python.')
    expect(result.seenExternalIds).toEqual([first.shortcode])
  })

  it('lets a 429 reach the caller so the board is tried later', async () => {
    const board = fixture('workable.json')
    fakeFetch({ [account]: { json: { name: board.name, jobs: board.jobs } } })
    fakeFetch({ [account]: { status: 429, headers: { 'retry-after': '1' } } })
    await expect(fetchWorkableBoardChanges('huggingface', 'Hugging Face', { known: new Set() })).rejects.toMatchObject({ status: 429 })
  })

  it('answers unchanged when the list has not changed and every posting is stored', async () => {
    const board = fixture('workable.json')
    fakeFetch({ [account]: { json: { name: board.name, jobs: board.jobs } } })
    const known = new Set<string>(board.jobs.map((j: { shortcode: string }) => j.shortcode))
    const a = await fetchWorkableBoardChanges('huggingface', 'Hugging Face', { known })
    if (!a.changed) throw new Error('expected a change')
    const b = await fetchWorkableBoardChanges('huggingface', 'Hugging Face', { known, listHash: a.listHash })
    expect(b.changed).toBe(false)
  })
})
