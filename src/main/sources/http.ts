export const USER_AGENT = 'JobPilot/0.1 (+https://github.com/ajshaham1337/jobpilot)'

const DEFAULT_TIMEOUT_MS = 20_000
/** Minimum gap between two requests to the same host. */
const HOST_GAP_MS = 200

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string
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

const hostQueues = new Map<string, Promise<void>>()

/** Spaces out requests to one host so a run over many boards doesn't hammer anyone. */
function waitForHost(url: string): Promise<void> {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return Promise.resolve()
  }
  const previous = hostQueues.get(host) ?? Promise.resolve()
  const next = previous.then(() => new Promise<void>((resolve) => setTimeout(resolve, HOST_GAP_MS)))
  hostQueues.set(host, next)
  // The caller waits for the previous request's gap, not its own.
  return previous
}

async function request(url: string, options: HttpOptions, accept: string, attempt = 0): Promise<Response> {
  await waitForHost(url)
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
  if ((res.status === 429 || res.status === 503) && attempt < 1) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 5)
    await new Promise((resolve) => setTimeout(resolve, wait * 1000))
    return request(url, options, accept, attempt + 1)
  }
  if (!res.ok) throw new HttpError(`${new URL(url).host} answered ${res.status}`, res.status, url)
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
