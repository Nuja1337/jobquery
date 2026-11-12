import { describe, expect, it } from 'vitest'
import type { ModelRef, ProviderInput } from '@shared/types'
import { Db } from '../db/database'
import { ProvidersRepo } from '../db/repos/providers'
import { SettingsRepo } from '../db/repos/settings'
import { testVault } from '../secrets'
import { BudgetExceededError, LlmCancelledError, OutOfCreditsError, RateLimitedError } from './errors'
import { type Clock, LlmService, pickChatModel } from './service'
import type { LlmClient, LlmRequest } from './types'

interface Fake {
  calls: Array<{ model: string; req: LlmRequest }>
  fail: Error | null
  models: string[]
}

function fakeClient(fake: Fake): LlmClient {
  return {
    kind: 'openai',
    async complete(model, req) {
      fake.calls.push({ model, req })
      if (fake.fail) throw fake.fail
      return { text: `reply to ${req.prompt}`, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, truncated: false }
    },
    async completeJson(model, req, schema) {
      fake.calls.push({ model, req })
      return { text: '{}', value: schema.parse({ score: 80 }), usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, truncated: false }
    },
    async listModels() {
      return fake.models
    }
  }
}

/** A clock that stands still. sleep() returns at once and remembers how long it was asked to wait. */
function stillClock(start = 1_000_000) {
  const state = { now: start, sleeps: [] as number[] }
  const clock: Clock = {
    now: () => state.now,
    sleep: async (ms) => {
      state.sleeps.push(ms)
    }
  }
  return { state, clock }
}

async function setup(clock?: Clock) {
  const db = await Db.open(null)
  const settings = new SettingsRepo(db)
  const providers = new ProvidersRepo(db, testVault)
  const fake: Fake = { calls: [], fail: null, models: [] }
  const llm = new LlmService(db, settings, providers, () => fakeClient(fake), clock)
  /** Adds a provider and routes every stage to the model. */
  const add = async (input: ProviderInput, model: string | null) => {
    const p = await providers.save({ apiKey: 'key', ...input })
    const ref: ModelRef | null = model ? { providerId: p.id, model } : null
    settings.update({ routing: { triage: ref, writing: ref, extraction: ref } })
    return p
  }
  return { db, settings, providers, llm, fake, add }
}

const writing = { task: 'cover_letter' as const, stage: 'writing' as const, promptVersion: 'v1', system: 'sys', prompt: 'hello' }
const GEMINI = { kind: 'gemini' as const, label: 'Gemini' }

describe('free providers', () => {
  it('costs nothing on a free provider but still records tokens, the provider and the free flag', async () => {
    const { llm, add, db } = await setup()
    const p = await add({ ...GEMINI, billing: 'free' }, 'gemini-2.5-flash')
    const out = await llm.text(writing)
    expect(out.costUsd).toBe(0)
    expect(out.tokens).toBe(1500)
    const row = db.get<Record<string, number | string>>('SELECT * FROM llm_calls')!
    expect(row).toMatchObject({ provider_id: p.id, free: 1, cost_usd: 0, input_tokens: 1000, output_tokens: 500, cache_hit: 0 })
  })

  it('prices the same model on a paid provider', async () => {
    const { llm, add, db } = await setup()
    const p = await add({ ...GEMINI, billing: 'paid' }, 'gemini-2.5-flash')
    const out = await llm.text(writing)
    // 1000 in at $0.30/M and 500 out at $2.50/M
    expect(out.costUsd).toBeCloseTo(0.0003 + 0.00125, 6)
    expect(db.get<{ free: number; provider_id: string }>('SELECT free, provider_id FROM llm_calls')).toEqual({ free: 0, provider_id: p.id })
  })

  it('treats models ending in :free as free on a paid provider', async () => {
    const { llm, add, db } = await setup()
    await add({ kind: 'openrouter', label: 'OpenRouter', billing: 'paid' }, 'meta-llama/llama-3.3-70b-instruct:free')
    const out = await llm.text(writing)
    expect(out.costUsd).toBe(0)
    expect(db.get<{ free: number }>('SELECT free FROM llm_calls')?.free).toBe(1)
  })

  it('still prices an OpenRouter model without the :free suffix as paid', async () => {
    const { llm, add } = await setup()
    await add({ kind: 'openrouter', label: 'OpenRouter', billing: 'paid' }, 'meta-llama/llama-3.3-70b-instruct')
    expect((await llm.text(writing)).costUsd).toBeGreaterThan(0)
  })

  it('records provider and free flag on cache hits and failures too', async () => {
    const { llm, add, db, fake } = await setup()
    const p = await add({ ...GEMINI, billing: 'free' }, 'gemini-2.5-flash')
    await llm.text(writing)
    await llm.text(writing)
    fake.fail = Object.assign(new Error('boom'), { status: 400 })
    await expect(llm.text({ ...writing, prompt: 'other' })).rejects.toThrow('boom')
    const rows = db.all<{ cache_hit: number; ok: number; free: number; provider_id: string }>('SELECT cache_hit, ok, free, provider_id FROM llm_calls ORDER BY at, rowid')
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r).toMatchObject({ free: 1, provider_id: p.id })
    expect(rows.map((r) => [r.cache_hit, r.ok])).toEqual([[0, 1], [1, 1], [0, 0]])
  })

  it('names the provider when it says the account is out of credits, and records the refused call once', async () => {
    const { llm, add, db, fake } = await setup()
    await add({ ...GEMINI, label: 'My Gemini', billing: 'free' }, 'gemini-2.5-flash')
    fake.fail = new OutOfCreditsError()
    const err = await llm.text(writing).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OutOfCreditsError)
    expect((err as Error).message.startsWith('My Gemini says the account is out of credits.')).toBe(true)
    expect((err as Error).message).toMatch(/after midnight/)
    const rows = db.all<{ ok: number; error: string | null }>('SELECT ok, error FROM llm_calls')
    expect(rows).toHaveLength(1)
    expect(rows[0].ok).toBe(0)
    expect(rows[0].error).toBeTruthy()
  })

  it('counts free calls today without cache hits', async () => {
    const { llm, add } = await setup()
    await add({ ...GEMINI, billing: 'free' }, 'gemini-2.5-flash')
    await llm.text(writing)
    await llm.text(writing)
    await llm.text({ ...writing, prompt: 'two' })
    expect(llm.usageSummary().freeCallsToday).toBe(2)
  })

  it('reports whether a stage uses a free model', async () => {
    const { llm, add } = await setup()
    await add({ ...GEMINI, billing: 'free' }, 'gemini-2.5-flash')
    expect(llm.isFreeStage('triage')).toBe(true)
  })
})

describe('OpenRouter billing', () => {
  it('charges a paid model even when the provider is marked free, and the budget still stops it', async () => {
    const { llm, add, settings } = await setup()
    await add({ kind: 'openrouter', label: 'OpenRouter', billing: 'free' }, 'anthropic/claude-sonnet-4.5')
    expect((await llm.text(writing)).costUsd).toBeGreaterThan(0)
    settings.update({ budget: { dailyUsd: 0.001 } })
    await expect(llm.text({ ...writing, prompt: 'again' })).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('does not treat a ":free" suffix as free on other providers', async () => {
    const { llm, add } = await setup()
    await add({ kind: 'openai_compatible', label: 'Proxy', baseUrl: 'https://proxy.example/v1', billing: 'paid' }, 'some-model:free')
    expect((await llm.text(writing)).costUsd).toBeGreaterThan(0)
  })

  it('tests a free OpenRouter key with a free model', () => {
    expect(pickChatModel(['anthropic/claude-sonnet-4.5', 'meta-llama/llama-3.3-70b-instruct:free'], true)).toBe('meta-llama/llama-3.3-70b-instruct:free')
    expect(pickChatModel(['anthropic/claude-sonnet-4.5', 'meta-llama/llama-3.3-70b-instruct:free'])).toBe('anthropic/claude-sonnet-4.5')
  })
})

describe('calls that never reached the provider', () => {
  it("aren't recorded and don't use up the daily limit", async () => {
    const { llm, add, fake, db } = await setup()
    await add({ ...GEMINI, billing: 'free', requestsPerDay: 1 }, 'gemini-2.5-flash')
    fake.fail = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { cause: 'refused' })
    await expect(llm.text(writing)).rejects.toThrow(/ECONNREFUSED/)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM llm_calls')?.n).toBe(0)
    fake.fail = null
    await expect(llm.text({ ...writing, prompt: 'after' })).resolves.toMatchObject({ cached: false })
  })

  it('are recorded when the provider answered with an error status', async () => {
    const { llm, add, fake, db } = await setup()
    await add({ ...GEMINI, billing: 'free' }, 'gemini-2.5-flash')
    fake.fail = Object.assign(new Error('Internal server error'), { status: 500 })
    await expect(llm.text(writing)).rejects.toThrow(/Internal/)
    expect(db.get<{ n: number; ok: number }>('SELECT COUNT(*) AS n, MAX(ok) AS ok FROM llm_calls')).toEqual({ n: 1, ok: 0 })
  })
})

describe('cancelling while waiting for a slot', () => {
  it('stops a waiting call before it is sent and records nothing', async () => {
    // sleep() only returns when the signal aborts, like a long wait cut short.
    const clock: Clock = {
      now: () => 1_000_000,
      sleep: (_ms, signal) =>
        new Promise((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener('abort', () => resolve(), { once: true })))
    }
    const { llm, add, fake, db } = await setup(clock)
    await add({ ...GEMINI, billing: 'free', requestsPerMinute: 1 }, 'gemini-2.5-flash')
    await llm.text(writing)
    const controller = new AbortController()
    const waiting = llm.text({ ...writing, prompt: 'second', signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await expect(waiting).rejects.toBeInstanceOf(LlmCancelledError)
    expect(fake.calls).toHaveLength(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM llm_calls')?.n).toBe(1)
  })
})

describe('budget and free providers', () => {
  it('blocks a paid provider once the budget is used up but keeps a free one working', async () => {
    const { llm, providers, settings, db } = await setup()
    const paid = await providers.save({ kind: 'openai', label: 'OpenAI', apiKey: 'k', billing: 'paid' })
    const free = await providers.save({ kind: 'gemini', label: 'Gemini', apiKey: 'k', billing: 'free' })
    settings.update({
      budget: { dailyUsd: 0.001 },
      routing: { triage: { providerId: free.id, model: 'gemini-2.5-flash' }, writing: { providerId: paid.id, model: 'gpt-5' } }
    })
    await llm.text(writing)
    expect(llm.budgetStatus().ok).toBe(false)
    await expect(llm.text({ ...writing, prompt: 'again' })).rejects.toBeInstanceOf(BudgetExceededError)

    const triage = { ...writing, task: 'triage' as const, stage: 'triage' as const, prompt: 'free one' }
    await expect(llm.text(triage)).resolves.toMatchObject({ costUsd: 0, cached: false })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM llm_calls WHERE free = 1')?.n).toBe(1)
    expect(llm.isFreeStage('triage')).toBe(true)
    expect(llm.isFreeStage('writing')).toBe(false)
  })
})

describe('pacing', () => {
  it('starts calls at least 60000 / requestsPerMinute ms apart even when callers run together', async () => {
    const { state, clock } = stillClock()
    const { llm, add, fake } = await setup(clock)
    await add({ ...GEMINI, billing: 'free', requestsPerMinute: 10 }, 'gemini-2.5-flash')
    await Promise.all([1, 2, 3, 4].map((n) => llm.text({ ...writing, prompt: `p${n}` })))
    expect(fake.calls).toHaveLength(4)
    // The first call starts at once. The rest wait for slots 6, 12 and 18 seconds out.
    expect(state.sleeps).toEqual([6000, 12000, 18000])
  })

  it('does not wait once enough time has passed, and does not pace cache hits', async () => {
    const { state, clock } = stillClock()
    const { llm, add } = await setup(clock)
    await add({ ...GEMINI, billing: 'free', requestsPerMinute: 30 }, 'gemini-2.5-flash')
    await llm.text(writing)
    await llm.text(writing)
    expect(state.sleeps).toEqual([])
    state.now += 1000
    await llm.text({ ...writing, prompt: 'two' })
    // 2000 ms gap, 1000 ms already passed.
    expect(state.sleeps).toEqual([1000])
    state.now += 60_000
    await llm.text({ ...writing, prompt: 'three' })
    expect(state.sleeps).toEqual([1000])
  })

  it('does not pace a provider with no limit, and paces providers separately', async () => {
    const { state, clock } = stillClock()
    const { llm, providers, settings } = await setup(clock)
    const a = await providers.save({ kind: 'gemini', label: 'A', apiKey: 'k', billing: 'free', requestsPerMinute: 6 })
    const b = await providers.save({ kind: 'openai', label: 'B', apiKey: 'k', billing: 'paid' })
    settings.update({ routing: { triage: { providerId: a.id, model: 'm' }, writing: { providerId: b.id, model: 'gpt-5' } } })
    const triage = { ...writing, task: 'triage' as const, stage: 'triage' as const }
    await Promise.all([llm.text(writing), llm.text({ ...writing, prompt: 'x' }), llm.text(triage), llm.text({ ...triage, prompt: 'y' })])
    expect(state.sleeps).toEqual([10_000])
  })
})

describe('daily request limit', () => {
  it('throws RateLimitedError naming the provider once today\'s calls reach the limit', async () => {
    const { llm, add, fake, db } = await setup()
    await add({ ...GEMINI, label: 'My Gemini', billing: 'free', requestsPerDay: 2 }, 'gemini-2.5-flash')
    await llm.text(writing)
    await llm.text({ ...writing, prompt: 'two' })
    // A repeat is a cache hit and does not use a request.
    await expect(llm.text(writing)).resolves.toMatchObject({ cached: true })
    const err = await llm.text({ ...writing, prompt: 'three' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as Error).message).toContain('My Gemini')
    expect((err as Error).message).toMatch(/after midnight/)
    expect(fake.calls).toHaveLength(2)
    // The refused call is not recorded as a request.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM llm_calls WHERE cache_hit = 0')?.n).toBe(2)
  })

  it('ignores yesterday\'s calls and other providers', async () => {
    const { llm, add, db, providers } = await setup()
    const p = await add({ ...GEMINI, billing: 'free', requestsPerDay: 1 }, 'gemini-2.5-flash')
    const other = await providers.save({ kind: 'openai', label: 'Other', apiKey: 'k' })
    const row = (providerId: string, at: string) =>
      db.run(
        `INSERT INTO llm_calls (id, at, task, stage, provider_kind, provider_id, model, cache_hit) VALUES (:id, :at, 'triage', 'triage', 'gemini', :providerId, 'm', 0)`,
        { id: `${providerId}-${at}`, at, providerId }
      )
    row(p.id, new Date(Date.now() - 2 * 86_400_000).toISOString())
    row(other.id, new Date().toISOString())
    await expect(llm.text(writing)).resolves.toMatchObject({ cached: false })
    await expect(llm.text({ ...writing, prompt: 'two' })).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('counts calls that are still running, so callers started together cannot pass the limit', async () => {
    const { llm, add, fake } = await setup()
    await add({ ...GEMINI, billing: 'free', requestsPerDay: 2 }, 'gemini-2.5-flash')
    const results = await Promise.allSettled([1, 2, 3, 4].map((n) => llm.text({ ...writing, prompt: `p${n}` })))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2)
    expect(fake.calls).toHaveLength(2)
  })
})

describe('testProvider', () => {
  it('skips embedding, speech and guard models when it has to pick one', async () => {
    const { llm, add, fake } = await setup()
    const p = await add({ kind: 'openai_compatible', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', billing: 'free' }, null)
    fake.models = ['whisper-large-v3', 'llama-guard-4-12b', 'text-embedding-3', 'playai-tts', 'llama-3.3-70b-versatile']
    const result = await llm.testProvider(p.id)
    expect(result.ok).toBe(true)
    expect(fake.calls[0].model).toBe('llama-3.3-70b-versatile')
  })

  it('uses the model of the matching ready-made setup first', async () => {
    const { llm, add, fake } = await setup()
    const p = await add({ ...GEMINI, billing: 'free' }, null)
    fake.models = ['models/embedding-001', 'models/gemini-2.5-pro']
    await llm.testProvider(p.id)
    expect(fake.calls[0].model).toBe('gemini-2.5-flash-lite')
  })

  it('pickChatModel falls back to the first model when none looks like chat', () => {
    expect(pickChatModel(['a-embed', 'b-whisper'])).toBe('a-embed')
    expect(pickChatModel([])).toBeUndefined()
    expect(pickChatModel(['dall-e-3', 'gpt-5-mini'])).toBe('gpt-5-mini')
  })
})
