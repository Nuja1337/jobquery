import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AnthropicClient } from './anthropic'
import { LlmFormatError, LlmRefusalError, OutOfCreditsError, RateLimitedError } from './errors'
import { priceFor } from './pricing'
import type { LlmRequest } from './types'

const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const req: LlmRequest = { system: 'Be brief.', prompt: 'Score it.', maxTokens: 500 } as LlmRequest
const schema = z.object({ score: z.number() })

/** A client whose API call returns the given message instead of going to the network. */
function clientReturning(message: Record<string, unknown>): AnthropicClient {
  const client = new AnthropicClient('sk-ant-test')
  const sdk = (client as unknown as { client: { beta: { messages: { create: unknown } } } }).client
  sdk.beta.messages.create = async () => ({ model: 'claude-sonnet-5-5', usage, stop_reason: 'end_turn', ...message })
  return client
}

describe('AnthropicClient.completeJson', () => {
  it('parses the JSON reply', async () => {
    const client = clientReturning({ content: [{ type: 'text', text: '{"score": 80}' }] })
    const res = await client.completeJson('claude-sonnet-5-5', req, schema, 'fit')
    expect(res.value).toEqual({ score: 80 })
    expect(res.usage.inputTokens).toBe(1000)
  })

  it('keeps the billed usage when the reply is not valid JSON', async () => {
    const client = clientReturning({ content: [{ type: 'text', text: '{"score": ' }], stop_reason: 'max_tokens' })
    const err = await client.completeJson('claude-sonnet-5-5', req, schema, 'fit').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmFormatError)
    expect((err as LlmFormatError).usage?.outputTokens).toBe(200)
    expect((err as Error).message).toMatch(/cut off/)
  })

  it('reports a refusal with its usage', async () => {
    const client = clientReturning({ content: [{ type: 'text', text: 'I can' }], stop_reason: 'refusal' })
    const err = await client.completeJson('claude-sonnet-5-5', req, schema, 'fit').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmRefusalError)
    expect((err as LlmRefusalError).usage?.inputTokens).toBe(1000)
  })

  it('uses only the text after a server-side fallback', async () => {
    const client = clientReturning({
      content: [
        { type: 'text', text: '{"score": 1' },
        { type: 'fallback', from: { model: 'claude-fable-5-1' }, to: { model: 'claude-opus-5-5' }, trigger: { type: 'refusal' } },
        { type: 'text', text: '{"score": 72}' }
      ]
    })
    const res = await client.completeJson('claude-fable-5-1', req, schema, 'fit')
    expect(res.value).toEqual({ score: 72 })
  })
})

describe('AnthropicClient rate limits', () => {
  /** A client whose API call fails with the given error. */
  function clientFailing(error: Error): AnthropicClient {
    const client = new AnthropicClient('sk-ant-test')
    const sdk = (client as unknown as { client: { beta: { messages: { create: unknown } } } }).client
    sdk.beta.messages.create = async () => {
      throw error
    }
    return client
  }

  it('turns an HTTP 429 into RateLimitedError with the retry-after delay', async () => {
    const client = clientFailing(new Anthropic.RateLimitError(429, { type: 'error' }, 'rate limited', new Headers({ 'retry-after': '7' })))
    const err = await client.complete('claude-sonnet-5-5', req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBe(7000)
    const json = await client.completeJson('claude-sonnet-5-5', req, schema, 'fit').catch((e: unknown) => e)
    expect(json).toBeInstanceOf(RateLimitedError)
  })

  it('maps a plain APIError with status 429 and leaves the delay empty without a header', async () => {
    const client = clientFailing(new Anthropic.APIError(429, undefined, 'slow down', new Headers()))
    const err = await client.complete('claude-sonnet-5-5', req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBeNull()
  })

  it('prefers retry-after-ms and reads a date', async () => {
    const ms = clientFailing(new Anthropic.RateLimitError(429, undefined, 'x', new Headers({ 'retry-after-ms': '1500', 'retry-after': '9' })))
    expect(((await ms.complete('m', req).catch((e: unknown) => e)) as RateLimitedError).retryAfterMs).toBe(1500)
    const date = new Date(Date.now() + 30_000).toUTCString()
    const dated = clientFailing(new Anthropic.RateLimitError(429, undefined, 'x', new Headers({ 'retry-after': date })))
    const wait = ((await dated.complete('m', req).catch((e: unknown) => e)) as RateLimitedError).retryAfterMs!
    expect(wait).toBeGreaterThan(20_000)
    expect(wait).toBeLessThanOrEqual(30_000)
  })

  it('leaves other errors alone', async () => {
    const boom = new Anthropic.InternalServerError(500, undefined, 'down', new Headers())
    const err = await clientFailing(boom).complete('m', req).catch((e: unknown) => e)
    expect(err).toBe(boom)
  })
})

describe('AnthropicClient out of credits', () => {
  /** A client whose API call fails with the given error, and counts the calls. */
  function clientFailing(error: Error): { client: AnthropicClient; calls: () => number } {
    let calls = 0
    const client = new AnthropicClient('sk-ant-test')
    const sdk = (client as unknown as { client: { beta: { messages: { create: unknown } } } }).client
    sdk.beta.messages.create = async () => {
      calls += 1
      throw error
    }
    return { client, calls: () => calls }
  }

  const creditsBody = {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' }
  }

  it('turns a 400 about the credit balance into OutOfCreditsError and does not retry with a JSON prompt', async () => {
    const { client, calls } = clientFailing(new Anthropic.BadRequestError(400, creditsBody, undefined, new Headers()))
    const text = await client.complete('claude-sonnet-5-5', req).catch((e: unknown) => e)
    expect(text).toBeInstanceOf(OutOfCreditsError)
    expect(calls()).toBe(1)
    const json = await client.completeJson('claude-sonnet-5-5', req, schema, 'fit').catch((e: unknown) => e)
    expect(json).toBeInstanceOf(OutOfCreditsError)
    expect(calls()).toBe(2)
  })

  it('turns a 402 billing_error into OutOfCreditsError', async () => {
    const { client } = clientFailing(new Anthropic.APIError(402, { type: 'error', error: { type: 'billing_error', message: 'Billing problem.' } }, 'Billing problem.', new Headers()))
    const err = await client.complete('claude-sonnet-5-5', req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OutOfCreditsError)
  })
})

describe('priceFor', () => {
  it('prices dated snapshots like their base model', () => {
    expect(priceFor('gpt-5-mini-2025-08-07', {})).toEqual(priceFor('gpt-5-mini', {}))
    expect(priceFor('openai/gpt-5-mini', {})).toEqual(priceFor('gpt-5-mini', {}))
  })

  it('does not price a different model as a cheaper one with a shared prefix', () => {
    expect(priceFor('gpt-5', {})).not.toBeNull()
    expect(priceFor('gpt-5-pro', {})).toBeNull()
    expect(priceFor('openai/gpt-5-pro', {})).toBeNull()
  })

  it('prefers the user\'s own price', () => {
    const own = { inputPerMTok: 15, outputPerMTok: 120 }
    expect(priceFor('gpt-5-pro', { 'gpt-5-pro': own })).toBe(own)
  })
})
