import { BUILTIN_PRICES } from '@shared/defaults'
import type { ModelPrice } from '@shared/types'
import type { LlmUsage } from './types'

/** Finds a price for a model id. User overrides win, then exact built-in ids, then known prefixes. */
export function priceFor(model: string, overrides: Record<string, ModelPrice>): ModelPrice | null {
  if (overrides[model]) return overrides[model]
  if (BUILTIN_PRICES[model]) return BUILTIN_PRICES[model]
  // OpenRouter and some gateways prefix ids with the vendor ("anthropic/claude-sonnet-5-5").
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  if (overrides[bare]) return overrides[bare]
  if (BUILTIN_PRICES[bare]) return BUILTIN_PRICES[bare]
  // Dated snapshots ("gpt-5-mini-2025-08-07") price like their base model.
  const base = Object.keys(BUILTIN_PRICES)
    .filter((id) => bare.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0]
  return base ? BUILTIN_PRICES[base] : null
}

/**
 * Used for models with no known price, so spending caps still work. Cautious on purpose:
 * it's above what most cheap models cost. Local models (Ollama) are always free.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }

/** Cost of one call in USD. Unknown models and local models cost 0 (tokens are still counted). */
export function costOf(usage: LlmUsage, price: ModelPrice | null): number {
  if (!price) return 0
  const perToken = (perMTok: number) => perMTok / 1_000_000
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok
  return (
    usage.inputTokens * perToken(price.inputPerMTok) +
    // Writing to the prompt cache costs 1.25x the input rate on Anthropic.
    usage.cacheWriteTokens * perToken(price.inputPerMTok) * 1.25 +
    usage.cacheReadTokens * perToken(cachedRate) +
    usage.outputTokens * perToken(price.outputPerMTok)
  )
}

export function totalTokens(usage: LlmUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}
