import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RateLimitedError } from './errors'
import { OpenAiCompatClient } from './openaiCompat'
import type { LlmRequest } from './types'

const req: LlmRequest = { system: 'Be brief.', prompt: 'Score it.', maxTokens: 500 }
const schema = z.object({ score: z.number() })

/** A client whose API call fails with the given error. */
function clientFailing(error: Error): OpenAiCompatClient {
  const client = new OpenAiCompatClient('gemini', 'key', 'https://example.invalid/v1')
  const sdk = (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client
  sdk.chat.completions.create = async () => {
    throw error
  }
  return client
}

describe('OpenAiCompatClient rate limits', () => {
  it('turns an HTTP 429 into RateLimitedError with the retry-after delay', async () => {
    const client = clientFailing(new OpenAI.RateLimitError(429, { message: 'quota' }, 'quota exceeded', new Headers({ 'retry-after': '12' })))
    const err = await client.complete('gemini-2.5-flash', req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBe(12_000)
    const json = await client.completeJson('gemini-2.5-flash', req, schema, 'fit').catch((e: unknown) => e)
    expect(json).toBeInstanceOf(RateLimitedError)
  })

  it('maps a plain APIError with status 429', async () => {
    const client = clientFailing(new OpenAI.APIError(429, undefined, 'RESOURCE_EXHAUSTED', new Headers()))
    const err = await client.complete('gemini-2.5-flash', req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBeNull()
  })

  it('does not try the other JSON modes after a 429', async () => {
    let attempts = 0
    const client = new OpenAiCompatClient('gemini', 'key', 'https://example.invalid/v1')
    const sdk = (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client
    sdk.chat.completions.create = async () => {
      attempts += 1
      throw new OpenAI.RateLimitError(429, undefined, 'x', new Headers())
    }
    await client.completeJson('m', req, schema, 'fit').catch(() => {})
    expect(attempts).toBe(1)
  })

  it('leaves other errors alone', async () => {
    const boom = new OpenAI.InternalServerError(500, undefined, 'down', new Headers())
    const err = await clientFailing(boom).complete('m', req).catch((e: unknown) => e)
    expect(err).toBe(boom)
  })
})
