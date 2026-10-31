import OpenAI from 'openai'
import { z } from 'zod'
import type { ProviderKind } from '@shared/types'
import { LlmFormatError, LlmRefusalError } from './errors'
import { jsonInstructions, parseWithSchema } from './json'
import type { LlmClient, LlmJsonResult, LlmRequest, LlmTextResult } from './types'

type CompatKind = Exclude<ProviderKind, 'anthropic'>
type JsonMode = 'schema' | 'object' | 'prompt'

/**
 * One client for every API that speaks the OpenAI chat completions format:
 * OpenAI itself, Gemini (through Google's OpenAI-compatible endpoint), OpenRouter,
 * Ollama, LM Studio, Groq, Together, DeepSeek, Mistral and the rest.
 */
export class OpenAiCompatClient implements LlmClient {
  private readonly client: OpenAI
  // Remember which JSON mode each model accepted so we don't pay for failed attempts twice.
  private readonly jsonModeByModel = new Map<string, JsonMode>()

  constructor(
    readonly kind: CompatKind,
    apiKey: string | null,
    baseUrl: string | null
  ) {
    this.client = new OpenAI({
      apiKey: apiKey || 'not-needed',
      baseURL: baseUrl ?? undefined,
      maxRetries: 3,
      timeout: 180_000
    })
  }

  private params(model: string, req: LlmRequest) {
    const system = [req.system, req.context].filter(Boolean).join('\n\n')
    const isReasoning = this.kind === 'openai' && /^(gpt-5|o\d)/.test(model)
    return {
      model,
      messages: [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: req.prompt }
      ],
      // OpenAI's own API wants max_completion_tokens. Most compatible servers still read max_tokens.
      ...(this.kind === 'openai' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
      ...(isReasoning && req.effort ? { reasoning_effort: req.effort } : {})
    }
  }

  async complete(model: string, req: LlmRequest): Promise<LlmTextResult> {
    const res = await this.client.chat.completions.create(this.params(model, req))
    return toResult(res, model)
  }

  async completeJson<T>(model: string, req: LlmRequest, schema: z.ZodType<T>, schemaName: string): Promise<LlmJsonResult<T>> {
    const jsonSchema = z.toJSONSchema(schema)
    const modes: JsonMode[] = this.jsonModeByModel.has(model) ? [this.jsonModeByModel.get(model)!] : ['schema', 'object', 'prompt']

    let lastError: unknown = null
    for (const mode of modes) {
      try {
        const base = this.params(model, req)
        const prompt = mode === 'schema' ? req.prompt : `${req.prompt}\n\n${jsonInstructions(jsonSchema)}`
        const res = await this.client.chat.completions.create({
          ...base,
          messages: [base.messages[0], { role: 'user' as const, content: prompt }],
          ...(mode === 'schema'
            ? { response_format: { type: 'json_schema' as const, json_schema: { name: safeName(schemaName), schema: jsonSchema as Record<string, unknown>, strict: false } } }
            : mode === 'object'
              ? { response_format: { type: 'json_object' as const } }
              : {})
        })
        const result = toResult(res, model)
        this.jsonModeByModel.set(model, mode)
        const parsed = parseWithSchema(result.text, schema)
        if (parsed.ok) return { ...result, value: parsed.value }
        throw new LlmFormatError(`The model's ${schemaName} reply was not valid: ${parsed.error}`, result.text)
      } catch (err) {
        lastError = err
        // A 400 usually means this server doesn't support the response_format we sent. Try the next mode.
        if (err instanceof OpenAI.BadRequestError && mode !== 'prompt') continue
        throw err
      }
    }
    throw lastError
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    for await (const m of this.client.models.list()) ids.push(m.id)
    return ids.sort()
  }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'result'
}

function toResult(res: OpenAI.Chat.Completions.ChatCompletion, requestedModel: string): LlmTextResult {
  const choice = res.choices[0]
  if (!choice) throw new Error('The provider returned no answer.')
  if (choice.message.refusal) throw new LlmRefusalError(choice.message.refusal)
  const usage = res.usage
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    text: choice.message.content ?? '',
    usage: {
      inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
      outputTokens: usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0
    },
    model: res.model || requestedModel,
    truncated: choice.finish_reason === 'length'
  }
}
