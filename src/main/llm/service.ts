import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { ProviderTestResult } from '@shared/api'
import { PROVIDER_DEFAULT_BASE_URL, SUGGESTED_MODELS } from '@shared/defaults'
import type { LlmStage, LlmTask, ModelRef, ProviderInfo, UsageSummary } from '@shared/types'
import { type Db, newId, now, parseJson } from '../db/database'
import type { ProvidersRepo } from '../db/repos/providers'
import type { SettingsRepo } from '../db/repos/settings'
import { AnthropicClient } from './anthropic'
import { BudgetExceededError, NoModelConfiguredError } from './errors'
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

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsRepo,
    private readonly providers: ProvidersRepo,
    private readonly factory: ClientFactory = defaultClientFactory
  ) {}

  /** Drops cached clients, for example after a key changes. */
  resetClients(): void {
    this.clients.clear()
  }

  private client(providerId: string): { client: LlmClient; provider: ProviderInfo } {
    const provider = this.providers.get(providerId)
    if (!provider) throw new NoModelConfiguredError('The AI provider picked for this step no longer exists. Check Settings.')
    let client = this.clients.get(providerId)
    if (!client) {
      client = this.factory(provider, this.providers.getApiKey(providerId))
      this.clients.set(providerId, client)
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
    const { client, provider } = this.client(ref.providerId)
    const useCache = opts.useCache !== false
    const cacheKey = hashKey([opts.task, provider.kind, ref.model, opts.promptVersion, schemaName, opts.system, opts.context ?? '', opts.prompt])

    if (useCache) {
      const hit = this.db.get<{ value: string }>('SELECT value FROM llm_cache WHERE key = :key', { key: cacheKey })
      if (hit) {
        const stored = parseJson<{ value: T; truncated: boolean } | null>(hit.value, null)
        if (stored) {
          this.record(opts, provider.kind, ref.model, ZERO_USAGE, 0, 0, true, null)
          return { value: stored.value, model: ref.model, costUsd: 0, tokens: 0, cached: true, truncated: stored.truncated }
        }
      }
    }

    this.assertBudget()

    const started = Date.now()
    try {
      const result = await run(client, ref.model, {
        system: opts.system,
        context: opts.context,
        prompt: opts.prompt,
        maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS[opts.stage],
        effort: opts.effort
      })
      const cost = costOf(result.usage, this.price(provider.kind, result.model))
      this.record(opts, provider.kind, result.model, result.usage, cost, Date.now() - started, false, null)
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
      // A refused or malformed reply was still billed. Count it so the caps see it.
      const billed = (err as { usage?: LlmUsage }).usage ?? ZERO_USAGE
      this.record(opts, provider.kind, ref.model, billed, costOf(billed, this.price(provider.kind, ref.model)), Date.now() - started, false, (err as Error).message)
      throw err
    }
  }

  private price(kind: string, model: string) {
    if (kind === 'ollama') return null
    return priceFor(model, this.settings.get().prices) ?? UNKNOWN_MODEL_PRICE
  }

  private record(
    opts: LlmCallOptions,
    providerKind: string,
    model: string,
    usage: LlmUsage,
    cost: number,
    ms: number,
    cacheHit: boolean,
    error: string | null
  ): void {
    this.db.run(
      `INSERT INTO llm_calls (id, at, task, stage, provider_kind, model, job_id, input_tokens, output_tokens,
         cached_input_tokens, cost_usd, cache_hit, duration_ms, ok, error)
       VALUES (:id, :at, :task, :stage, :provider, :model, :jobId, :input, :output, :cached, :cost, :hit, :ms, :ok, :error)`,
      {
        id: newId(),
        at: now(),
        task: opts.task,
        stage: opts.stage,
        provider: providerKind,
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
    return {
      todayUsd: today.usd,
      monthUsd: month.usd,
      todayTokens: today.tokens,
      monthTokens: month.tokens,
      dailyBudgetUsd: budget.dailyUsd,
      monthlyBudgetUsd: budget.monthlyUsd,
      cacheHitsMonth: hits?.n ?? 0
    }
  }

  async listModels(providerId: string): Promise<string[]> {
    return this.client(providerId).client.listModels()
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
    const model = routed ?? SUGGESTED_MODELS[provider.kind]?.triage ?? models[0]
    if (!model) return { ok: true, message: 'Connected. No models were listed, so pick one by name.', models }
    try {
      const { client } = this.client(providerId)
      await client.complete(model, { system: 'Reply with the single word OK.', prompt: 'Ping', maxTokens: 1000, effort: 'low' })
      return { ok: true, message: `Connected. ${model} answered.`, models }
    } catch (err) {
      return { ok: false, message: `Listed ${models.length} models, but ${model} failed: ${(err as Error).message}`, models }
    }
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
