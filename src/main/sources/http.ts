import type { RawJob } from '@shared/types'

export const USER_AGENT = 'jobpls/0.1 (+https://github.com/Nuja1337/jobpls)'

const DEFAULT_TIMEOUT_MS = 20_000

/** Requests per second one host gets over time, and how many may go out back to back. */
export interface HostRate {
  perSecond: number
  burst: number
}

const DEFAULT_RATE: HostRate = { perSecond: 1, burst: 3 }
/** Hosts that rate-limit sooner than the default allows. Workable answers 429 after a few dozen requests in a minute. */
const HOST_RATES: Record<string, HostRate> = {
  'apply.workable.com': { perSecond: 1 / 3, burst: 2 }
}

/** The longest an in-request retry waits for Retry-After. */
const RETRY_AFTER_CAP_MS = 60_000
/** Two 429s from one host inside this window pause the host. */
const THROTTLE_WINDOW_MS = 5 * 60_000
const HOST_PAUSE_MS = 10 * 60_000
/** With a signal, a request that would wait longer than this for a paused host fails at once. */
const FAIL_FAST_WAIT_MS = 30_000

/** Time and waiting, so tests can run pacing without real delays. Same shape as the AI service's clock. */
export interface Clock {
  now(): number
  /** Resolves after ms, or early when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
    /** Set on a 429 from a paused host: when the host may be asked again, as a clock time in ms. */
    readonly retryAt: number | null = null
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface HttpOptions {
  timeoutMs?: number
  headers?: Record<string, string>
  method?: 'GET' | 'POST'
  body?: string
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Per-host pacing
// ---------------------------------------------------------------------------

interface HostState {
  tokens: number
  refilledAt: number
  /** Callers wait in line, so one host sees one request at a time through the bucket. */
  queue: Promise<void>
  throttledAt: number[]
  pausedUntil: number
}

let clock: Clock = realClock
const hosts = new Map<string, HostState>()

/** Replaces the clock the pacing uses. Tests only. Pass nothing to go back to the real one. */
export function setHttpClock(next?: Clock): void {
  clock = next ?? realClock
  hosts.clear()
}

/** Forgets every host's tokens and pauses. Tests only. */
export function resetHttpState(): void {
  hosts.clear()
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

function rateFor(host: string): HostRate {
  return HOST_RATES[host] ?? DEFAULT_RATE
}

function stateOf(host: string): HostState {
  let state = hosts.get(host)
  if (!state) {
    state = { tokens: rateFor(host).burst, refilledAt: clock.now(), queue: Promise.resolve(), throttledAt: [], pausedUntil: 0 }
    hosts.set(host, state)
  }
  return state
}

/** When a paused host may be asked again, as a clock time in ms, or null when it is not paused. */
export function hostPauseUntil(host: string): number | null {
  const state = hosts.get(host)
  if (!state || state.pausedUntil <= clock.now()) return null
  return state.pausedUntil
}

/** Stops requests to a host until `until`. Used for a 429 and for a Retry-After longer than a retry waits. */
function pauseHost(host: string, until: number): void {
  const state = stateOf(host)
  state.pausedUntil = Math.max(state.pausedUntil, until)
}

/** Notes a 429. The second one inside five minutes pauses the host for ten. */
function noteThrottled(host: string): void {
  const state = stateOf(host)
  const at = clock.now()
  state.throttledAt = state.throttledAt.filter((t) => at - t < THROTTLE_WINDOW_MS)
  state.throttledAt.push(at)
  if (state.throttledAt.length >= 2) {
    state.pausedUntil = Math.max(state.pausedUntil, at + HOST_PAUSE_MS)
    state.throttledAt = []
  }
}

/**
 * Waits for the host's turn and one token. Requests to a host take turns, and the bucket refills at
 * the host's rate, so a run over many boards doesn't hammer anyone. A paused host makes the request wait,
 * or fail with a 429 when a signal is given and the wait would be long, so the caller can reschedule.
 */
async function waitForHost(url: string, signal?: AbortSignal): Promise<void> {
  const host = hostOf(url)
  if (!host) return
  const state = stateOf(host)
  const turn = state.queue
  let release!: () => void
  state.queue = new Promise<void>((resolve) => (release = resolve))
  try {
    await turn
    const rate = rateFor(host)
    for (;;) {
      if (signal?.aborted) return
      const at = clock.now()
      if (state.pausedUntil > at) {
        const wait = state.pausedUntil - at
        if (signal && wait > FAIL_FAST_WAIT_MS) {
          throw new HttpError(`${host} asked us to slow down`, 429, url, state.pausedUntil)
        }
        await clock.sleep(wait, signal)
        continue
      }
      state.tokens = Math.min(rate.burst, state.tokens + ((at - state.refilledAt) / 1000) * rate.perSecond)
      state.refilledAt = at
      if (state.tokens >= 1) {
        state.tokens -= 1
        return
      }
      await clock.sleep(Math.ceil(((1 - state.tokens) / rate.perSecond) * 1000), signal)
    }
  } finally {
    release()
  }
}

/** Retry-After as milliseconds, from seconds or an HTTP date. Null when missing or unreadable. */
export function parseRetryAfter(value: string | null, at: number): number | null {
  if (!value) return null
  const text = value.trim()
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  const date = Date.parse(text)
  return Number.isFinite(date) ? Math.max(0, date - at) : null
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function request(url: string, options: HttpOptions, accept: string, attempt = 0, allow304 = false): Promise<Response> {
  await waitForHost(url, options.signal)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  let res: Response
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      body: options.body,
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: accept, ...options.headers }
    })
  } catch (err) {
    if (options.signal?.aborted) throw err
    const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message
    throw new HttpError(`Could not reach ${new URL(url).host}: ${reason}`, null, url)
  }
  const host = new URL(url).host
  if (res.status === 429) noteThrottled(host)
  if (res.status === 429 || res.status === 503) {
    const asked = parseRetryAfter(res.headers.get('retry-after'), clock.now())
    if (asked !== null && asked > RETRY_AFTER_CAP_MS) {
      // A host that asks for more than a retry may wait is left alone for that long.
      if (res.status === 429) pauseHost(host, clock.now() + Math.min(asked, HOST_PAUSE_MS))
    } else if (attempt < 1 && hostPauseUntil(host) === null) {
      await clock.sleep(asked ?? 2000, options.signal)
      return request(url, options, accept, attempt + 1, allow304)
    }
  }
  if (allow304 && res.status === 304) return res
  if (!res.ok) throw new HttpError(`${host} answered ${res.status}`, res.status, url, res.status === 429 ? hostPauseUntil(host) : null)
  return res
}

export async function fetchText(url: string, options: HttpOptions = {}): Promise<string> {
  const res = await request(url, options, 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8')
  return res.text()
}

export async function fetchJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  const res = await request(url, options, 'application/json')
  try {
    return (await res.json()) as T
  } catch {
    throw new HttpError(`${new URL(url).host} did not return JSON`, res.status, url)
  }
}

/** What a board answered last time. Sent back so the board can say nothing changed. */
export interface Validators {
  etag?: string | null
  lastModified?: string | null
}

export type ConditionalResult<T> =
  | { status: 200; json: T; etag: string | null; lastModified: string | null }
  | { status: 304 }

/** A GET that sends If-None-Match and If-Modified-Since when it has them. A 304 comes back as a result, not an error. */
export async function fetchConditional<T = unknown>(url: string, options: HttpOptions & Validators = {}): Promise<ConditionalResult<T>> {
  const { etag, lastModified, ...rest } = options
  const headers: Record<string, string> = { ...rest.headers }
  if (etag) headers['If-None-Match'] = etag
  if (lastModified) headers['If-Modified-Since'] = lastModified
  const res = await request(url, { ...rest, headers }, 'application/json', 0, true)
  if (res.status === 304) return { status: 304 }
  let json: T
  try {
    json = (await res.json()) as T
  } catch {
    throw new HttpError(`${new URL(url).host} did not return JSON`, res.status, url)
  }
  return { status: 200, json, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') }
}

/** What a conditional read of a company board found. */
export type BoardChanges =
  | {
      changed: false
      /** Set when the board sent new validators but the same list. */
      etag?: string | null
      lastModified?: string | null
      listHash?: string | null
    }
  | {
      changed: true
      jobs: RawJob[]
      /** Listed postings that are stored already and were not fetched again. They stay open and count as seen. */
      seenExternalIds?: string[]
      etag: string | null
      lastModified: string | null
      /** Null when the read was partial, so the next check reads the board again. */
      listHash: string | null
      /** False when some listed postings were left out. Nothing may be closed on this read. */
      complete?: boolean
    }

/** What the stored board state hands a conditional read. */
export interface BoardReadState extends Validators {
  listHash?: string | null
  /** Postings already stored with a description. */
  known?: ReadonlySet<string>
}

/** Runs fn over items with at most `limit` in flight. Results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
