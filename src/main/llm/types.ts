import type { z } from 'zod'
import type { ProviderKind } from '@shared/types'

export type Effort = 'low' | 'medium' | 'high'

export interface LlmRequest {
  /** Stable instructions. Cached by providers that support prompt caching. */
  system: string
  /** Semi-stable context such as the candidate profile. Placed after system and cached too. */
  context?: string
  /** The part that changes on every call. */
  prompt: string
  maxTokens: number
  effort?: Effort
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface LlmTextResult {
  text: string
  usage: LlmUsage
  /** The model that answered. Can differ from the requested one when a provider falls back. */
  model: string
  truncated: boolean
}

export interface LlmJsonResult<T> extends LlmTextResult {
  value: T
}

export interface LlmClient {
  readonly kind: ProviderKind
  complete(model: string, req: LlmRequest): Promise<LlmTextResult>
  completeJson<T>(model: string, req: LlmRequest, schema: z.ZodType<T>, schemaName: string): Promise<LlmJsonResult<T>>
  listModels(): Promise<string[]>
}

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
  }
}
