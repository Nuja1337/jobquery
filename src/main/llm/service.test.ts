import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Db } from '../db/database'
import { ProvidersRepo } from '../db/repos/providers'
import { SettingsRepo } from '../db/repos/settings'
import { testVault } from '../secrets'
import { BudgetExceededError, NoModelConfiguredError, RateLimitedError } from './errors'
import { extractJson } from './json'
import { type Clock, LlmService } from './service'
import type { LlmClient, LlmRequest } from './types'

function fakeClient(calls: LlmRequest[]): LlmClient {
  return {
    kind: 'anthropic',
    async complete(model, req) {
      calls.push(req)
      return { text: `reply to ${req.prompt}`, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, truncated: false }
    },
    async completeJson(model, req, schema) {
      calls.push(req)
      const value = schema.parse({ score: 80 })
      return { text: '{"score":80}', value, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, truncated: false }
    },
    async listModels() {
      return ['claude-haiku-5-5', 'claude-sonnet-5-5']
    }
  }
}

async function setup() {
  const db = await Db.open(null)
  const settings = new SettingsRepo(db)
  const providers = new ProvidersRepo(db, testVault)
  const calls: LlmRequest[] = []
  const llm = new LlmService(db, settings, providers, () => fakeClient(calls))
  return { db, settings, providers, llm, calls }
}

const base = { task: 'cover_letter' as const, stage: 'writing' as const, promptVersion: 'v1', system: 'sys', prompt: 'hello' }

describe('LlmService', () => {
  it('fails clearly when no provider is set up', async () => {
    const { llm } = await setup()
    await expect(llm.text(base)).rejects.toBeInstanceOf(NoModelConfiguredError)
  })

  it('falls back to a suggested model for the first provider', async () => {
    const { llm, providers } = await setup()
    await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
    expect(llm.resolveModel('triage').model).toBe('claude-haiku-5-5')
    expect(llm.resolveModel('writing').model).toBe('claude-sonnet-5-5')
  })

  it('records cost and serves repeats from the cache for free', async () => {
    const { llm, providers, calls, db } = await setup()
    await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
    const first = await llm.text(base)
    expect(first.cached).toBe(false)
    // claude-sonnet-5-5: 1000 in at $2/M + 500 out at $10/M
    expect(first.costUsd).toBeCloseTo(0.002 + 0.005, 6)
    const second = await llm.text(base)
    expect(second.cached).toBe(true)
    expect(second.costUsd).toBe(0)
    expect(calls).toHaveLength(1)
    const rows = db.all<{ cache_hit: number }>('SELECT cache_hit FROM llm_calls ORDER BY at')
    expect(rows.map((r) => r.cache_hit)).toEqual([0, 1])
    expect(llm.usageSummary().cacheHitsMonth).toBe(1)
  })

  it('skips the cache when asked to regenerate', async () => {
    const { llm, providers, calls } = await setup()
    await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
    await llm.text(base)
    await llm.text({ ...base, useCache: false })
    expect(calls).toHaveLength(2)
  })

  it('stops before calling the model once the daily budget is spent', async () => {
    const { llm, providers, settings } = await setup()
    await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
    settings.update({ budget: { dailyUsd: 0.005 } })
    await llm.text(base)
    await expect(llm.text({ ...base, prompt: 'another' })).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('validates JSON replies against the schema', async () => {
    const { llm, providers } = await setup()
    await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
    const res = await llm.json({ ...base, task: 'triage', stage: 'triage', schema: z.object({ score: z.number() }), schemaName: 'fit' })
    expect(res.value.score).toBe(80)
  })

  it('keeps API keys encrypted at rest and out of provider listings', async () => {
    const { providers, db } = await setup()
    const saved = await providers.save({ kind: 'openai', label: 'OpenAI', apiKey: 'sk-secret' })
    expect(saved.hasKey).toBe(true)
    expect(JSON.stringify(providers.list())).not.toContain('sk-secret')
    const raw = db.get<{ api_key_enc: string }>('SELECT api_key_enc FROM providers')!
    expect(raw.api_key_enc).not.toContain('sk-secret')
    expect(await providers.getApiKey(saved.id)).toBe('sk-secret')
    // Saving without apiKey keeps the stored key.
    await providers.save({ id: saved.id, kind: 'openai', label: 'Renamed' })
    expect(await providers.getApiKey(saved.id)).toBe('sk-secret')
    // Pointing the provider somewhere else without a new key drops the old one.
    await providers.save({ id: saved.id, kind: 'openai_compatible', label: 'Elsewhere', baseUrl: 'https://example.invalid/v1' })
    expect(await providers.getApiKey(saved.id)).toBeNull()
  })
})

describe('LlmService short rate limits', () => {
  /** A client that fails with the given errors in order, then answers. */
  function flaky(failures: Error[], calls: LlmRequest[]): LlmClient {
    const good = fakeClient(calls)
    return {
      ...good,
      async complete(model, req) {
        const next = failures.shift()
        if (next) {
          calls.push(req)
          throw next
        }
        return good.complete(model, req)
      }
    }
  }

  async function withFlaky(failures: Error[], clock: Clock) {
    const db = await Db.open(null)
    const settings = new SettingsRepo(db)
    const providers = new ProvidersRepo(db, testVault)
    const calls: LlmRequest[] = []
    const llm = new LlmService(db, settings, providers, () => flaky(failures, calls), clock)
    await providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
    return { llm, calls, db, providers, settings }
  }

  function stillClock() {
    const sleeps: number[] = []
    const clock: Clock = { now: () => 0, sleep: async (ms) => void sleeps.push(ms) }
    return { clock, sleeps }
  }

  it('waits out a short retry-after and retries the call once', async () => {
    const { clock, sleeps } = stillClock()
    const { llm, calls } = await withFlaky([new RateLimitedError('Slow down.', 20_000)], clock)
    const res = await llm.text(base)
    expect(res.value).toBe('reply to hello')
    expect(sleeps).toEqual([20_000])
    expect(calls).toHaveLength(2)
  })

  it('throws when the retry is limited again', async () => {
    const { clock, sleeps } = stillClock()
    const { llm, calls } = await withFlaky([new RateLimitedError('Slow down.', 1000), new RateLimitedError('Still slow.', 1000)], clock)
    await expect(llm.text(base)).rejects.toThrow('Still slow.')
    expect(sleeps).toEqual([1000])
    expect(calls).toHaveLength(2)
  })

  it('does not wait for a long retry-after or one the provider did not give', async () => {
    const { clock, sleeps } = stillClock()
    const long = await withFlaky([new RateLimitedError('Come back later.', 10 * 60_000)], clock)
    await expect(long.llm.text(base)).rejects.toBeInstanceOf(RateLimitedError)
    const none = await withFlaky([new RateLimitedError('No hint.')], clock)
    await expect(none.llm.text(base)).rejects.toBeInstanceOf(RateLimitedError)
    expect(sleeps).toEqual([])
  })

  it('does not wait when the run was cancelled', async () => {
    const { clock, sleeps } = stillClock()
    const { llm } = await withFlaky([new RateLimitedError('Slow down.', 1000)], clock)
    const controller = new AbortController()
    controller.abort()
    await expect(llm.text({ ...base, signal: controller.signal })).rejects.toBeDefined()
    expect(sleeps).toEqual([])
  })

  it('still throws at once for the daily limit set in JobPilot', async () => {
    const { clock, sleeps } = stillClock()
    const { llm, providers, settings, calls } = await withFlaky([], clock)
    const p = providers.list()[0]
    await providers.save({ id: p.id, kind: 'anthropic', label: 'Claude', requestsPerDay: 1 })
    settings.update({ routing: { triage: null, writing: { providerId: p.id, model: 'claude-sonnet-5-5' }, extraction: null } })
    await llm.text(base)
    await expect(llm.text({ ...base, prompt: 'two' })).rejects.toBeInstanceOf(RateLimitedError)
    expect(sleeps).toEqual([])
    expect(calls).toHaveLength(1)
  })
})

describe('extractJson', () => {
  it('reads JSON wrapped in fences and chatter', () => {
    expect(extractJson('Sure! ```json\n{"a": [1, 2], "b": "x}"}\n``` done')).toEqual({ a: [1, 2], b: 'x}' })
    expect(extractJson('Result: {"ok": true} trailing text {"no": 1}')).toEqual({ ok: true })
  })
})
