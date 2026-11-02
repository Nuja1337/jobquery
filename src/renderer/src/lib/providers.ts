import { PROVIDER_PRESETS, SUGGESTED_MODELS } from '@shared/defaults'
import type { LlmStage, ProviderInfo } from '@shared/types'

/**
 * The model to suggest for a stage on this provider. The ready-made setup it matches comes first
 * (same kind, billing and address), then the suggestion for the provider kind. Same rule as the
 * main process uses when it tests a provider.
 */
export function suggestedModel(provider: Pick<ProviderInfo, 'kind' | 'billing' | 'baseUrl'>, stage: LlmStage): string | undefined {
  const url = (u: string | null) => (u ?? '').replace(/\/+$/, '')
  const preset = PROVIDER_PRESETS.find((p) => p.kind === provider.kind && p.billing === provider.billing && url(p.baseUrl) === url(provider.baseUrl) && p.models)
  return preset?.models?.[stage] ?? SUGGESTED_MODELS[provider.kind]?.[stage]
}

/** Short label for what a provider costs. OpenRouter lists both free and paid models. */
export function billingLabel(p: Pick<ProviderInfo, 'kind' | 'billing'>): string {
  return p.kind === 'openrouter' ? 'Free and paid models' : p.billing === 'free' ? 'Free' : 'Paid'
}

/** Longer explanation of the same thing, for a tooltip. */
export function billingTitle(p: Pick<ProviderInfo, 'kind' | 'billing'>): string {
  if (p.kind === 'openrouter') return 'Models whose names end in ":free" cost nothing. Every other model is priced and counts toward your budget.'
  if (p.billing === 'free') return "This is a free tier or a model on this computer, so JobPilot doesn't count it toward your budget."
  return 'Each call is priced and counts toward your budget.'
}
