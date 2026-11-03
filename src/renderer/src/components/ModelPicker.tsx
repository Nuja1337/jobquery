import { useEffect, useState } from 'react'
import type { ModelRef, ProviderInfo } from '@shared/types'
import { api } from '@renderer/lib/api'
import { Checkbox, Input, Select } from './ui'

const cache = new Map<string, string[]>()

/** Loads the live model list for a provider. Results are kept for the session. */
export function useModels(providerId: string | null, refreshKey = 0): { models: string[]; loading: boolean; failed: boolean } {
  const [state, setState] = useState<{ models: string[]; loading: boolean; failed: boolean }>({ models: [], loading: false, failed: false })
  useEffect(() => {
    if (!providerId) {
      setState({ models: [], loading: false, failed: false })
      return
    }
    const key = `${providerId}:${refreshKey}`
    const hit = cache.get(key)
    if (hit) {
      setState({ models: hit, loading: false, failed: false })
      return
    }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    api.listModels(providerId).then(
      (models) => {
        cache.set(key, models)
        if (live) setState({ models, loading: false, failed: false })
      },
      () => live && setState({ models: [], loading: false, failed: true })
    )
    return () => {
      live = false
    }
  }, [providerId, refreshKey])
  return state
}

interface Props {
  providers: ProviderInfo[]
  value: ModelRef | null
  onChange: (ref: ModelRef | null) => void
  /** Model to select when the user picks a provider. Gets the provider just picked. */
  suggested?: (provider: ProviderInfo) => string | undefined
  /** Names the stage in the dropdowns' accessible labels, for example "Writing provider". */
  label?: string
}

/** A provider dropdown and a model dropdown loaded from the provider. */
export function ModelPicker({ providers, value, onChange, suggested, label }: Props): React.JSX.Element {
  const providerId = value?.providerId ?? null
  const { models, loading, failed } = useModels(providerId)
  const current = value?.model ?? ''
  const provider = providers.find((p) => p.id === providerId)
  const isOpenRouter = provider?.kind === 'openrouter'
  // On by default for a free provider, so the list shows only models that cost nothing.
  const [freeOnly, setFreeOnly] = useState(provider?.billing === 'free')
  useEffect(() => {
    setFreeOnly(provider?.billing === 'free')
  }, [providerId, provider?.billing])
  const filtered = isOpenRouter && freeOnly ? models.filter((m) => m.endsWith(':free')) : models
  const options = current && !filtered.includes(current) ? [current, ...filtered] : filtered

  return (
    <div className="grid grid-cols-2 gap-2">
      <Select
        value={providerId ?? ''}
        aria-label={label ? `${label} provider` : 'Provider'}
        onChange={(e) => {
          const id = e.target.value
          const picked = providers.find((p) => p.id === id)
          onChange(id ? { providerId: id, model: (picked && suggested?.(picked)) || '' } : null)
        }}
      >
        <option value="">Not set</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
      {providerId && (models.length > 0 || loading) ? (
        <Select value={current} aria-label={label ? `${label} model` : 'Model'} disabled={loading} onChange={(e) => onChange({ providerId, model: e.target.value })}>
          {loading && <option>Loading models</option>}
          {!current && <option value="">Choose a model</option>}
          {options.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          aria-label={label ? `${label} model` : 'Model'}
          value={current}
          disabled={!providerId}
          placeholder={failed ? 'Could not load models. Type a model name.' : 'Model name'}
          onChange={(e) => providerId && onChange({ providerId, model: e.target.value })}
        />
      )}
      {isOpenRouter && models.length > 0 && (
        <div className="col-span-2">
          <Checkbox
            label={filtered.length === 0 ? 'Free models only (none in this list)' : 'Free models only'}
            checked={freeOnly}
            onChange={setFreeOnly}
          />
        </div>
      )}
    </div>
  )
}
