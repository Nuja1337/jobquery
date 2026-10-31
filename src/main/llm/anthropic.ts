import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { LlmFormatError, LlmRefusalError } from './errors'
import { jsonInstructions, parseWithSchema } from './json'
import type { LlmClient, LlmJsonResult, LlmRequest, LlmTextResult, LlmUsage } from './types'

// Models that accept the server-side refusal fallback ("fallbacks": "default").
// When the first model declines, the API retries on a suitable model inside the same call.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

// output_config.effort is accepted by Opus 4.5 and later, Sonnet 4.6 and later, Haiku 5.5, and Fable.
function supportsEffort(model: string): boolean {
  return /^claude-(fable|mythos)-/.test(model) || /^claude-(opus|sonnet|haiku)-5/.test(model) || /^claude-opus-4-[5-9]/.test(model) || /^claude-sonnet-4-[6-9]/.test(model)
}

type BetaMessage = Anthropic.Beta.BetaMessage

export class AnthropicClient implements LlmClient {
  readonly kind = 'anthropic' as const
  private readonly client: Anthropic

  constructor(apiKey: string, baseUrl?: string | null) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl ?? undefined, maxRetries: 3, timeout: 180_000 })
  }

  private baseParams(model: string, req: LlmRequest) {
    // Stable instructions first, then the profile, each marked for caching. Triage runs the
    // same prefix against dozens of jobs in a row, so most input tokens come from the cache.
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: 'text', text: req.system }]
    if (req.context) system.push({ type: 'text', text: req.context, cache_control: { type: 'ephemeral' } })
    else system[0].cache_control = { type: 'ephemeral' }

    const fallback = FALLBACK_MODELS.has(model)
    return {
      model,
      max_tokens: req.maxTokens,
      system,
      messages: [{ role: 'user' as const, content: req.prompt }],
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {})
    }
  }

  async complete(model: string, req: LlmRequest): Promise<LlmTextResult> {
    const res = await this.client.beta.messages.create({
      ...this.baseParams(model, req),
      ...(req.effort && supportsEffort(model) ? { output_config: { effort: req.effort } } : {})
    })
    return toResult(res)
  }

  async completeJson<T>(model: string, req: LlmRequest, schema: z.ZodType<T>, schemaName: string): Promise<LlmJsonResult<T>> {
    // create() rather than parse(): parse() throws a plain error on a reply that isn't valid JSON
    // (a refusal with partial text, or a cut-off), and the billed usage is lost with it.
    let res: BetaMessage
    try {
      res = await this.client.beta.messages.create({
        ...this.baseParams(model, req),
        output_config: {
          format: betaZodOutputFormat(schema),
          ...(req.effort && supportsEffort(model) ? { effort: req.effort } : {})
        }
      })
    } catch (err) {
      // Older models don't support structured outputs. Ask for JSON in the prompt instead.
      if (err instanceof Anthropic.BadRequestError && /output_config|format|schema|structured/i.test(err.message)) {
        return this.completeJsonByPrompt(model, req, schema, schemaName)
      }
      throw err
    }
    const result = toResult(res)
    const parsed = parseWithSchema(result.text, schema)
    if (!parsed.ok) {
      const cut = result.truncated ? ' It was cut off at the length limit.' : ''
      throw new LlmFormatError(`The model's ${schemaName} reply was not valid: ${parsed.error}.${cut}`, result.text, result.usage)
    }
    return { ...result, value: parsed.value }
  }

  private async completeJsonByPrompt<T>(model: string, req: LlmRequest, schema: z.ZodType<T>, schemaName: string): Promise<LlmJsonResult<T>> {
    const prompt = `${req.prompt}\n\n${jsonInstructions(z.toJSONSchema(schema))}`
    const first = await this.complete(model, { ...req, prompt })
    const parsed = parseWithSchema(first.text, schema)
    if (parsed.ok) return { ...first, value: parsed.value }
    throw new LlmFormatError(`The model's ${schemaName} reply was not valid: ${parsed.error}`, first.text, first.usage)
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    for await (const m of this.client.models.list()) ids.push(m.id)
    return ids
  }
}

function toResult(res: BetaMessage): LlmTextResult {
  const billed: LlmUsage = {
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0
  }
  if (res.stop_reason === 'refusal') throw new LlmRefusalError(undefined, billed)
  // With a server-side fallback, a model that declined partway leaves its partial text before a
  // "fallback" block. Only the text after the last one is the answer.
  const lastHop = res.content.findLastIndex((b) => (b.type as string) === 'fallback')
  const text = res.content
    .slice(lastHop + 1)
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return { text, usage: billed, model: res.model, truncated: res.stop_reason === 'max_tokens' }
}
