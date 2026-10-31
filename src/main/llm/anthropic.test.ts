import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AnthropicClient } from './anthropic'
import { LlmFormatError, LlmRefusalError } from './errors'
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
