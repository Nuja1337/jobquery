import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { ProviderTestResult } from '@shared/api'
import { PROVIDER_DEFAULT_BASE_URL, PROVIDER_PRESETS, SUGGESTED_MODELS } from '@shared/defaults'
import type { LlmStage, LlmTask, ModelRef, ProviderInfo, UsageSummary } from '@shared/types'
import { type Db, newId, now, parseJson } from '../db/database'
import type { ProvidersRepo } from '../db/repos/providers'
import type { SettingsRepo } from '../db/repos/settings'
import { AnthropicClient } from './anthropic'
import { BudgetExceededError, LlmCancelledError, LlmFormatError, LlmRefusalError, NoModelConfiguredError, RateLimitedError } from './errors'
import { OpenAiCompatClient } from './openaiCompat'
import { costOf, priceFor, totalTokens, UNKNOWN_MODEL_PRICE } from './pricing'
import { type Effort, type LlmClient, type LlmUsage, ZERO_USAGE } from './types'

export interface LlmCallOptions {
  task: LlmTask
  stage: LlmStage
  jobId?: string | null
  /** Bump when the prompt template changes so old cached answers are not reused. */
  promptVersion: string
  system: string
  context?: string
  prompt: string
  maxTokens?: number
  effort?: Effort
  /** Reuse an earlier answer to the exact same request. Default true. Turn off for "regenerate". */
  useCache?: boolean
  /** Cancels the call while it waits for its turn under a rate limit. A call already sent finishes. */
  signal?: AbortSignal
}

export interface LlmOutcome<T> {
  value: T
  model: string
  costUsd: number
  tokens: number
  cached: boolean
  truncated: boolean
}

export type ClientFactory = (provider: ProviderInfo, apiKey: string | null) => LlmClient

export const defaultClientFactory: ClientFactory = (provider, apiKey) => {
  const baseUrl = provider.baseUrl ?? PROVIDER_DEFAULT_BASE_URL[provider.kind]
  if (provider.kind === 'anthropic') return new AnthropicClient(apiKey ?? '', baseUrl)
  return new OpenAiCompatClient(provider.kind, apiKey, baseUrl)
}

/** Time and waiting, so tests can run pacing without real delays. */
export interface Clock {
  now(): number
  /** Resolves after ms, or early when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

const realClock: Clock = {
  // performance.now() never jumps when the system clock is changed, so a wait can't stretch.
  now: () => performance.now(),
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

/** Model ids that are not chat models. Used when a test call has to pick one from a provider's list. */
const NOT_A_CHAT_MODEL = /embed|whisper|tts|speech|audio|transcribe|guard|moderation|rerank|image|imagen|dall-e|vision-only|veo|aqa|realtime|ocr/i

/** The first listed model that looks like a chat model, or the first one when none does. With preferFree, an OpenRouter ":free" model comes first. */
export function pickChatModel(models: string[], preferFree = false): string | undefined {
  const chat = models.filter((m) => !NOT_A_CHAT_MODEL.test(m))
  return (preferFree ? chat.find(isFreeModelId) : undefined) ?? chat[0] ?? models[0]
}

/**
 * True when the provider got the request and answered, even with an error: an HTTP status, a
 * refusal, a reply that couldn't be read or a rate limit. A refused connection or a dropped
 * network has no status.
 */
function providerAnswered(err: unknown): boolean {
  if (err instanceof RateLimitedError || err instanceof LlmFormatError || err instanceof LlmRefusalError) return true
  return typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
}

/** OpenRouter's free models end in ":free". */
export function isFreeModelId(model: string): boolean {
  return model.endsWith(':free')
}

/**
 * Whether a call costs nothing. OpenRouter serves free and paid models through the same key, so
 * there only ":free" models are free, whatever the provider is marked as. Elsewhere the user's
 * choice of free or paid decides.
 */
export function callIsFree(provider: Pick<ProviderInfo, 'kind' | 'billing'>, model: string): boolean {
  if (provider.kind === 'openrouter') return isFreeModelId(model)
  return provider.billing === 'free'
}

/** The longest "try again in" a provider can ask for and still have the call wait and retry once. */
const MAX_RETRY_WAIT_MS = 5 * 60_000

const DEFAULT_MAX_TOKENS: Record<LlmStage, number> = { triage: 4000, extraction: 8000, writing: 16000 }

function startOfToday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function startOfMonth(): string {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/**
 * Every model call in the app goes through here. It picks the model for the stage,
 * enforces the spending caps, answers repeat requests from the local cache and
 * records tokens and cost for each call.
 */
export class LlmService {
  private readonly clients = new Map<string, LlmClient>()
  /** Bumped by resetClients, so a client built from a key read before a reset is never cached. */
  private clientGeneration = 0
  /** When the next call to a provider may start. Slots are handed out in order, so callers running together stay spaced. */
  private readonly nextStart = new Map<string, number>()
  /** Calls to a provider that passed the daily check but are not recorded yet. */
  private readonly pending = new Map<string, number>()

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsRepo,
    private readonly providers: ProvidersRepo,
    private readonly factory: ClientFactory = defaultClientFactory,
    private readonly clock: Clock = realClock
  ) {}

  /** Drops cached clients, for example after a key changes. */
  resetClients(): void {
    this.clients.clear()
    this.clientGeneration += 1
  }

  private async client(providerId: string): Promise<{ client: LlmClient; provider: ProviderInfo }> {
    const provider = this.providers.get(providerId)
    if (!provider) throw new NoModelConfiguredError('The AI provider picked for this step no longer exists. Check Settings.')
    let client = this.clients.get(providerId)
    if (!client) {
      const generation = this.clientGeneration
      client = this.factory(provider, await this.providers.getApiKey(providerId))
      if (generation === this.clientGeneration) this.clients.set(providerId, client)
    }
    return { client, provider }
  }

  /** The model for a stage. Falls back to another stage's model, then to a suggested model for the first provider. */
  resolveModel(stage: LlmStage): ModelRef {
    const { routing } = this.settings.get()
    const order: LlmStage[] = [stage, 'writing', 'extraction', 'triage']
    for (const s of order) {
      const ref = routing[s]
      if (ref && ref.model && this.providers.get(ref.providerId)) return ref
    }
    const first = this.providers.list()[0]
    const suggested = first ? SUGGESTED_MODELS[first.kind]?.[stage] : undefined
    if (first && suggested) return { providerId: first.id, model: suggested }
    throw new NoModelConfiguredError()
  }

  /** True when the model for this stage costs nothing (a free-tier or local provider, or a ":free" model). */
  isFreeStage(stage: LlmStage): boolean {
    try {
      const ref = this.resolveModel(stage)
      const provider = this.providers.get(ref.providerId)
      return provider ? this.isFree(provider, ref.model) : false
    } catch {
      return false
    }
  }

  private isFree(provider: ProviderInfo, model: string): boolean {
    return callIsFree(provider, model)
  }

  isConfigured(): boolean {
    try {
      this.resolveModel('writing')
      return true
    } catch {
      return false
    }
  }

  async text(opts: LlmCallOptions): Promise<LlmOutcome<string>> {
    return this.call(opts, null, async (client, model, req) => {
      const r = await client.complete(model, req)
      return { ...r, value: r.text }
    })
  }

  async json<T>(opts: LlmCallOptions & { schema: z.ZodType<T>; schemaName: string }): Promise<LlmOutcome<T>> {
    return this.call(opts, opts.schemaName, (client, model, req) => client.completeJson(model, req, opts.schema, opts.schemaName))
  }

  private async call<T>(
    opts: LlmCallOptions,
    schemaName: string | null,
    run: (
      client: LlmClient,
      model: string,
      req: { system: string; context?: string; prompt: string; maxTokens: number; effort?: Effort }
    ) => Promise<{ value: T; usage: LlmUsage; model: string; truncated: boolean }>
  ): Promise<LlmOutcome<T>> {
    const ref = this.resolveModel(opts.stage)
    const { client, provider } = await this.client(ref.providerId)
    const useCache = opts.useCache !== false
    const cacheKey = hashKey([opts.task, provider.kind, ref.model, opts.promptVersion, schemaName, opts.system, opts.context ?? '', opts.prompt])

    if (useCache) {
      const hit = this.db.get<{ value: string }>('SELECT value FROM llm_cache WHERE key = :key', { key: cacheKey })
      if (hit) {
        const stored = parseJson<{ value: T; truncated: boolean } | null>(hit.value, null)
        if (stored) {
          this.record(opts, provider, ref.model, ZERO_USAGE, 0, 0, true, null, this.isFree(provider, ref.model))
          return { value: stored.value, model: ref.model, costUsd: 0, tokens: 0, cached: true, truncated: stored.truncated }
        }
      }
    }

    // Free or paid is decided by the model asked for, so the budget check and the recorded cost
    // always agree. Only money spent counts against the budget, so free providers keep working
    // when it runs out.
    const free = this.isFree(provider, ref.model)
    if (!free) this.assertBudget()
    this.assertDailyLimit(provider)
    this.pending.set(provider.id, (this.pending.get(provider.id) ?? 0) + 1)
    let started = Date.now()
    let sent = false
    try {
      await this.pace(provider, opts.signal)
      // Checked again after the wait: the run may have been cancelled, or another call may have
      // hit the paid budget or the provider's limit meanwhile.
      if (opts.signal?.aborted) throw new LlmCancelledError()
      if (!free) this.assertBudget()
      started = Date.now()
      sent = true
      const send = () =>
        run(client, ref.model, {
          system: opts.system,
          context: opts.context,
          prompt: opts.prompt,
          maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS[opts.stage],
          effort: opts.effort
        })
      let result
      try {
        result = await send()
      } catch (err) {
        // A short wait from the provider is worth sitting out, so an unattended run goes on instead of stopping.
        // A long one, or one set by jobpls's own daily limit, still ends the call.
        if (!(err instanceof RateLimitedError) || err.retryAfterMs === null || err.retryAfterMs > MAX_RETRY_WAIT_MS || opts.signal?.aborted) throw err
        await this.clock.sleep(err.retryAfterMs, opts.signal)
        if (opts.signal?.aborted) throw err
        if (!free) this.assertBudget()
        started = Date.now()
        result = await send()
      }
      const cost = free ? 0 : this.price(result.model, result.usage)
      this.record(opts, provider, result.model, result.usage, cost, Date.now() - started, false, null, free)
      if (useCache && !result.truncated) {
        this.db.run('INSERT OR REPLACE INTO llm_cache (key, task, value, created_at) VALUES (:key, :task, :value, :at)', {
          key: cacheKey,
          task: opts.task,
          value: JSON.stringify({ value: result.value, truncated: result.truncated }),
          at: now()
        })
      }
      return {
        value: result.value,
        model: result.model,
        costUsd: cost,
        tokens: totalTokens(result.usage),
        cached: false,
        truncated: result.truncated
      }
    } catch (err) {
      // Nothing reached the provider, or nothing came back from it (the server isn't running, the
      // network is down). There's nothing to record, and it doesn't count toward a daily limit.
      if (!sent || !providerAnswered(err)) throw err
      // A refused or malformed reply was still billed. Count it so the caps see it.
      const billed = (err as { usage?: LlmUsage }).usage ?? ZERO_USAGE
      const cost = free ? 0 : this.price(ref.model, billed)
      this.record(opts, provider, ref.model, billed, cost, Date.now() - started, false, (err as Error).message, free)
      throw err
    } finally {
      this.pending.set(provider.id, Math.max(0, (this.pending.get(provider.id) ?? 1) - 1))
    }
  }

  /** What a paid call cost. Free calls are $0 and never get here. Tokens are recorded either way. */
  private price(model: string, usage: LlmUsage): number {
    return costOf(usage, priceFor(model, this.settings.get().prices) ?? UNKNOWN_MODEL_PRICE)
  }

  /** Waits until this provider's next call slot. The slot is taken before waiting, so concurrent callers queue up. */
  private async pace(provider: ProviderInfo, signal?: AbortSignal): Promise<void> {
    const rpm = provider.requestsPerMinute
    if (!rpm) return
    const gap = 60_000 / rpm
    const t = this.clock.now()
    const start = Math.max(t, this.nextStart.get(provider.id) ?? 0)
    this.nextStart.set(provider.id, start + gap)
    if (start > t && !signal?.aborted) await this.clock.sleep(start - t, signal)
  }

  /** Throws RateLimitedError when today's calls to a provider have reached the limit set for it. */
  private assertDailyLimit(provider: ProviderInfo): void {
    const limit = provider.requestsPerDay
    if (!limit) return
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM llm_calls WHERE provider_id = :id AND cache_hit = 0 AND at >= :since',
      { id: provider.id, since: startOfToday() }
    )
    // Calls still running are not recorded yet but will count.
    const used = (row?.n ?? 0) + (this.pending.get(provider.id) ?? 0)
    if (used >= limit) {
      throw new RateLimitedError(`${provider.label} has reached its limit of ${limit} requests for today. jobpls uses it again after midnight.`)
    }
  }

  private record(
    opts: LlmCallOptions,
    provider: ProviderInfo,
    model: string,
    usage: LlmUsage,
    cost: number,
    ms: number,
    cacheHit: boolean,
    error: string | null,
    free: boolean
  ): void {
    this.db.run(
      `INSERT INTO llm_calls (id, at, task, stage, provider_kind, provider_id, free, model, job_id, input_tokens, output_tokens,
         cached_input_tokens, cost_usd, cache_hit, duration_ms, ok, error)
       VALUES (:id, :at, :task, :stage, :provider, :providerId, :free, :model, :jobId, :input, :output, :cached, :cost, :hit, :ms, :ok, :error)`,
      {
        id: newId(),
        at: now(),
        task: opts.task,
        stage: opts.stage,
        provider: provider.kind,
        providerId: provider.id,
        free,
        model,
        jobId: opts.jobId ?? null,
        input: usage.inputTokens + usage.cacheWriteTokens,
        output: usage.outputTokens,
        cached: usage.cacheReadTokens,
        cost,
        hit: cacheHit,
        ms,
        ok: error === null,
        error
      }
    )
  }

  private spendSince(iso: string): { usd: number; tokens: number } {
    const row = this.db.get<{ usd: number | null; tokens: number | null }>(
      `SELECT SUM(cost_usd) AS usd, SUM(input_tokens + output_tokens + cached_input_tokens) AS tokens
       FROM llm_calls WHERE at >= :since`,
      { since: iso }
    )
    return { usd: row?.usd ?? 0, tokens: row?.tokens ?? 0 }
  }

  /** Throws BudgetExceededError when today's or this month's spend has reached its cap. 0 means no cap. */
  assertBudget(): void {
    const status = this.budgetStatus()
    if (!status.ok) throw new BudgetExceededError(status.reason!)
  }

  budgetStatus(): { ok: boolean; reason: string | null } {
    const { budget } = this.settings.get()
    const today = this.spendSince(startOfToday()).usd
    if (budget.dailyUsd > 0 && today >= budget.dailyUsd) {
      return { ok: false, reason: `Today's AI budget of $${budget.dailyUsd.toFixed(2)} is used up. Raise it in Settings or wait until tomorrow.` }
    }
    const month = this.spendSince(startOfMonth()).usd
    if (budget.monthlyUsd > 0 && month >= budget.monthlyUsd) {
      return { ok: false, reason: `This month's AI budget of $${budget.monthlyUsd.toFixed(2)} is used up. Raise it in Settings.` }
    }
    return { ok: true, reason: null }
  }

  usageSummary(): UsageSummary {
    const { budget } = this.settings.get()
    const today = this.spendSince(startOfToday())
    const month = this.spendSince(startOfMonth())
    const hits = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM llm_calls WHERE cache_hit = 1 AND at >= :since', {
      since: startOfMonth()
    })
    const free = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM llm_calls WHERE free = 1 AND cache_hit = 0 AND at >= :since', {
      since: startOfToday()
    })
    return {
      todayUsd: today.usd,
      monthUsd: month.usd,
      todayTokens: today.tokens,
      monthTokens: month.tokens,
      dailyBudgetUsd: budget.dailyUsd,
      monthlyBudgetUsd: budget.monthlyUsd,
      cacheHitsMonth: hits?.n ?? 0,
      freeCallsToday: free?.n ?? 0
    }
  }

  async listModels(providerId: string): Promise<string[]> {
    return (await this.client(providerId)).client.listModels()
  }

  /** Lists models, and when that works, sends one tiny request to prove the key and model work. */
  async testProvider(providerId: string): Promise<ProviderTestResult> {
    let models: string[] = []
    try {
      models = await this.listModels(providerId)
    } catch (err) {
      return { ok: false, message: `Could not reach the provider: ${(err as Error).message}`, models: [] }
    }
    const provider = this.providers.get(providerId)!
    const routed = Object.values(this.settings.get().routing).find((r) => r?.providerId === providerId)?.model
    const model = routed ?? this.suggestedTestModel(provider) ?? pickChatModel(models, provider.kind === 'openrouter')?.replace(/^models\//, '')
    if (!model) return { ok: true, message: 'Connected. No models were listed, so pick one by name.', models }
    try {
      const { client } = await this.client(providerId)
      await client.complete(model, { system: 'Reply with the single word OK.', prompt: 'Ping', maxTokens: 1000, effort: 'low' })
      return { ok: true, message: `Connected. ${model} answered.`, models }
    } catch (err) {
      return { ok: false, message: `Listed ${models.length} models, but ${model} failed: ${(err as Error).message}`, models }
    }
  }

  /** The triage model of the matching ready-made setup, or the suggested model for the provider kind. */
  private suggestedTestModel(provider: ProviderInfo): string | undefined {
    const url = (u: string | null) => (u ?? '').replace(/\/+$/, '')
    const preset = PROVIDER_PRESETS.find(
      (p) => p.kind === provider.kind && p.billing === provider.billing && url(p.baseUrl) === url(provider.baseUrl) && p.models
    )
    return preset?.models?.triage ?? SUGGESTED_MODELS[provider.kind]?.triage
  }

  /** Deletes cached responses older than the given number of days. */
  pruneCache(days = 60): void {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    this.db.run('DELETE FROM llm_cache WHERE created_at < :cutoff', { cutoff })
  }
}

function hashKey(parts: Array<string | null>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
