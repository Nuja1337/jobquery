import type { LlmUsage } from './types'

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export class NoModelConfiguredError extends Error {
  constructor(message = 'No AI model is set up yet. Add a provider and pick models in Settings.') {
    super(message)
    this.name = 'NoModelConfiguredError'
  }
}

/**
 * The provider refused because a rate or quota limit was reached (HTTP 429, or the provider's
 * per-day limit set in JobPilot). The caller should stop starting new AI work for this run and
 * pick up again later. It is not the item's fault, so it never counts as a failure of the job.
 */
export class RateLimitedError extends Error {
  constructor(
    message = 'Your AI provider says too many requests were sent. JobPilot will try again on a later run.',
    /** When the provider said to try again, if it said. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
    this.name = 'RateLimitedError'
  }
}

/**
 * Turns an SDK error into a RateLimitedError when the provider answered HTTP 429, even after the
 * SDK's own retries. Returns null for anything else. Both the Anthropic and OpenAI SDK errors carry
 * `status` and `headers`, so one check covers RateLimitError and a plain APIError with status 429.
 * A 429 reports no billed usage.
 */
export function asRateLimited(err: unknown): RateLimitedError | null {
  if (err instanceof RateLimitedError) return err
  if (typeof err !== 'object' || err === null || (err as { status?: unknown }).status !== 429) return null
  return new RateLimitedError('The provider said it received too many requests.', retryAfterMs((err as { headers?: unknown }).headers))
}

/** Reads retry-after-ms, or retry-after as seconds or a date, from response headers. Null when absent or unreadable. */
export function retryAfterMs(headers: unknown): number | null {
  const get = (name: string): string | null => {
    if (!headers || typeof headers !== 'object') return null
    const h = headers as { get?: (n: string) => string | null | undefined } & Record<string, unknown>
    if (typeof h.get === 'function') return h.get(name) ?? null
    const v = h[name]
    return typeof v === 'string' ? v : null
  }
  const ms = Number(get('retry-after-ms'))
  if (get('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return Math.round(ms)
  const after = get('retry-after')
  if (!after) return null
  const seconds = Number(after)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(after)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

/** The call was cancelled before it was sent, for example while it waited for its turn under a rate limit. */
export class LlmCancelledError extends Error {
  constructor(message = 'The AI call was cancelled before it was sent.') {
    super(message)
    this.name = 'LlmCancelledError'
  }
}

/** The model declined the request. The caller should flag the item for the user instead of retrying. */
export class LlmRefusalError extends Error {
  constructor(
    message = 'The model declined to answer this request.',
    /** Tokens the provider billed for the declined reply. */
    readonly usage?: LlmUsage
  ) {
    super(message)
    this.name = 'LlmRefusalError'
  }
}

/** The model answered, but not in the shape we asked for, even after a repair attempt. */
export class LlmFormatError extends Error {
  constructor(
    message: string,
    readonly raw: string,
    /** Tokens the provider billed for the unusable reply. */
    readonly usage?: LlmUsage
  ) {
    super(message)
    this.name = 'LlmFormatError'
  }
}
