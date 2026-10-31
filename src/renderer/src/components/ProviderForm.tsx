import { useState } from 'react'
import { clsx } from 'clsx'
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react'
import { PROVIDER_DEFAULT_BASE_URL, PROVIDER_LABELS, PROVIDER_NEEDS_KEY, PROVIDER_PRESETS, isLocalUrl, type ProviderPreset } from '@shared/defaults'
import type { ProviderBilling, ProviderInfo, ProviderKind } from '@shared/types'
import type { ProviderTestResult } from '@shared/api'
import { api } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { plural } from '@renderer/lib/format'
import { useToast } from '@renderer/lib/toast'
import { Button, Field, Input, Notice, NumberInput, Select } from './ui'

export const KEY_STORAGE_NOTE = "Your key is encrypted with your operating system's key store when one is available, and stays on your computer."
export const KEY_STORAGE_WARNING = 'This computer has no key store JobPilot can use, so your key is saved on disk without real encryption. Anyone with access to your user account could read it.'

/** True once the app knows this computer has no real key store. */
export function useKeyStorageWeak(): boolean {
  const { appInfo } = useApp()
  return !!appInfo && !appInfo.secureKeyStorage
}

/** Shown where keys are entered, only when keys would be saved without real encryption. */
export function KeyStorageWarning(): React.JSX.Element | null {
  const weak = useKeyStorageWeak()
  return weak ? (
    <Notice tone="warn" title="Your key will not be encrypted">
      {KEY_STORAGE_WARNING}
    </Notice>
  ) : null
}

const KINDS = Object.keys(PROVIDER_LABELS) as ProviderKind[]
const FREE_PRESETS = PROVIDER_PRESETS.filter((p) => p.billing === 'free')
const PAID_PRESETS = PROVIDER_PRESETS.filter((p) => p.billing === 'paid')
const CUSTOM_PRESET_ID = 'custom'

const BILLING_OPTIONS: Array<{ id: ProviderBilling; label: string; text: string }> = [
  { id: 'free', label: 'Free', text: "Use this for a free tier or a model on this computer. JobPilot won't count it toward your budget." },
  { id: 'paid', label: 'Paid', text: 'Each call is priced and counts toward your budget.' }
]

/** One line for a provider's request limits, for example "10 requests a minute, 250 requests a day". */
export function describeLimits(p: { requestsPerMinute: number | null; requestsPerDay: number | null }): string {
  const parts: string[] = []
  if (p.requestsPerMinute) parts.push(`${plural(p.requestsPerMinute, 'request')} a minute`)
  if (p.requestsPerDay) parts.push(`${plural(p.requestsPerDay, 'request')} a day`)
  return parts.length > 0 ? parts.join(', ') : 'No request limits set'
}

function validLimit(v: number | null): boolean {
  return v === null || (Number.isInteger(v) && v >= 1)
}

interface Props {
  initial?: ProviderInfo
  /** The last argument is the id of the preset the user picked, or null when editing. */
  onSaved: (provider: ProviderInfo, test: ProviderTestResult | null, presetId: string | null) => void
  onCancel?: () => void
}

/** Add or edit one AI provider. The key field is write-only. */
export function ProviderForm({ initial, onSaved, onCancel }: Props): React.JSX.Element {
  const toast = useToast()
  const [presetId, setPresetId] = useState<string | null>(null)
  const [kind, setKind] = useState<ProviderKind>(initial?.kind ?? 'anthropic')
  const [label, setLabel] = useState(initial?.label ?? PROVIDER_LABELS[initial?.kind ?? 'anthropic'])
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [billing, setBilling] = useState<ProviderBilling>(initial?.billing ?? 'paid')
  const [billingTouched, setBillingTouched] = useState(!!initial)
  const [perMinute, setPerMinute] = useState<number | null>(initial?.requestsPerMinute ?? null)
  const [perDay, setPerDay] = useState<number | null>(initial?.requestsPerDay ?? null)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [result, setResult] = useState<ProviderTestResult | null>(null)

  const adding = !initial
  const preset = presetId ? (PROVIDER_PRESETS.find((p) => p.id === presetId) ?? null) : null
  const isCustom = presetId === CUSTOM_PRESET_ID
  // A new provider shows the rest of the form only after a setup is picked.
  const ready = !adding || preset !== null

  const needsKey = preset ? preset.needsKey : PROVIDER_NEEDS_KEY[kind]
  const hasStoredKey = initial?.hasKey ?? false
  const showKey = preset ? preset.needsKey || isCustom : kind !== 'ollama' || hasStoredKey
  const needsUrl = kind === 'ollama' || kind === 'openai_compatible'
  const showUrl = needsUrl || kind === 'openrouter' || kind === 'gemini'
  const showKindSelect = !adding || isCustom
  const keyStorageWeak = useKeyStorageWeak()
  const missingKey = showKey && needsKey && !apiKey && !hasStoredKey
  const missingUrl = kind === 'openai_compatible' && !baseUrl.trim()
  const badLimits = !validLimit(perMinute) || !validLimit(perDay)
  const blocked = busy !== null || !ready || missingKey || missingUrl || badLimits

  function choosePreset(p: ProviderPreset): void {
    setPresetId(p.id)
    setKind(p.kind)
    setLabel(p.label)
    setBaseUrl(p.baseUrl ?? PROVIDER_DEFAULT_BASE_URL[p.kind] ?? '')
    setBilling(p.billing)
    setBillingTouched(false)
    setPerMinute(p.requestsPerMinute)
    setPerDay(p.requestsPerDay)
    setResult(null)
  }

  function changeKind(next: ProviderKind): void {
    const wasDefaultLabel = label === PROVIDER_LABELS[kind] || !label
    setKind(next)
    if (wasDefaultLabel) setLabel(PROVIDER_LABELS[next])
    setBaseUrl(PROVIDER_DEFAULT_BASE_URL[next] ?? '')
    if (!billingTouched) setBilling(next === 'ollama' ? 'free' : 'paid')
    setResult(null)
  }

  function changeBaseUrl(url: string): void {
    // Billing isn't switched for a local address. It can be a proxy that forwards to a paid API,
    // so the user decides, with a hint below.
    setBaseUrl(url)
  }

  async function submit(test: boolean): Promise<void> {
    setBusy(test ? 'test' : 'save')
    try {
      const saved = await api.saveProvider({
        id: initial?.id,
        kind,
        label: label.trim() || PROVIDER_LABELS[kind],
        baseUrl: baseUrl.trim() || null,
        billing,
        requestsPerMinute: perMinute,
        requestsPerDay: perDay,
        ...(apiKey ? { apiKey } : {})
      })
      setApiKey('')
      let tested: ProviderTestResult | null = null
      if (test) {
        tested = await api.testProvider(saved.id)
        setResult(tested)
      }
      onSaved(saved, tested, presetId)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!blocked) void submit(true)
      }}
      autoComplete="off"
    >
      {adding && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-muted">Pick a free or a paid setup</legend>
          <div className="grid grid-cols-2 gap-3">
            <PresetGroup title="Free" caption="These cost nothing. Free tiers have limits, and local models need a capable computer." presets={FREE_PRESETS} selected={presetId} onPick={choosePreset} />
            <PresetGroup title="Paid" caption="You pay the provider for each call. These usually write best." presets={PAID_PRESETS} selected={presetId} onPick={choosePreset} />
          </div>
        </fieldset>
      )}

      {preset && (
        <div className="space-y-2">
          {preset.trainsOnData ? (
            <Notice tone="warn" title="Check how your data is used">
              {preset.note}
            </Notice>
          ) : (
            <p className="text-sm text-muted">{preset.note}</p>
          )}
          {preset.keyUrl && (
            <button
              type="button"
              onClick={() => void api.openExternal(preset.keyUrl as string).catch(toast.error)}
              className="inline-flex items-center gap-1 text-sm text-accent-strong hover:underline"
            >
              {preset.needsKey ? 'Get a key' : `Download ${preset.label.split(' (')[0]}`} <ExternalLink size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {ready && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {showKindSelect && (
              <Field label="Provider">
                <Select value={kind} onChange={(e) => changeKind(e.target.value as ProviderKind)} disabled={!!initial}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {PROVIDER_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Name" className={showKindSelect ? undefined : 'col-span-2'}>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </div>
          {showUrl && (
            <Field label="Base URL" hint={needsUrl ? 'Where the API lives, for example http://localhost:11434/v1.' : 'Leave as is unless you use a proxy.'}>
              <Input value={baseUrl} onChange={(e) => changeBaseUrl(e.target.value)} placeholder={PROVIDER_DEFAULT_BASE_URL[kind] ?? 'https://api.example.com/v1'} />
            </Field>
          )}
          {showKey && (
            <Field
              label={needsKey ? 'API key' : 'API key (optional)'}
              hint={`${hasStoredKey ? 'A key is saved. Type a new one only to replace it. ' : ''}${keyStorageWeak ? '' : `${KEY_STORAGE_NOTE} `}It is never shown again.`}
            >
              <div className="flex items-center gap-2">
                <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasStoredKey ? 'Saved' : 'Paste your key'} autoComplete="new-password" spellCheck={false} />
                {hasStoredKey && !apiKey && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-good">
                    <CheckCircle2 size={13} /> Saved
                  </span>
                )}
              </div>
            </Field>
          )}
          {showKey && <KeyStorageWarning />}

          {kind === 'openrouter' ? (
            <p className="rounded-md border border-line px-3 py-2 text-sm text-muted">
              On OpenRouter, models whose names end in &quot;:free&quot; cost nothing and every other model is priced, so JobPilot decides for each model.
            </p>
          ) : (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs font-medium text-muted">What this provider costs you</legend>
            {BILLING_OPTIONS.map((o) => (
              <label
                key={o.id}
                className={clsx(
                  'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                  billing === o.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover/60'
                )}
              >
                <input
                  type="radio"
                  name="billing"
                  value={o.id}
                  checked={billing === o.id}
                  onChange={() => {
                    setBilling(o.id)
                    setBillingTouched(true)
                  }}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span className="text-sm">
                  <span className="block font-medium text-fg">{o.label}</span>
                  <span className="block text-muted">{o.text}</span>
                </span>
              </label>
            ))}
            {billing === 'paid' && isLocalUrl(baseUrl) && (
              <p className="text-xs text-muted">This address is on your computer. If the model runs here and costs nothing, mark it free.</p>
            )}
          </fieldset>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Requests per minute (optional)">
              <NumberInput value={perMinute} min={1} step={1} placeholder="No limit" onChange={setPerMinute} />
            </Field>
            <Field label="Requests per day (optional)">
              <NumberInput value={perDay} min={1} step={1} placeholder="No limit" onChange={setPerDay} />
            </Field>
          </div>
          <p className={clsx('-mt-1 text-xs', badLimits ? 'text-bad' : 'text-faint')}>
            {badLimits ? 'Limits are whole numbers of 1 or more. Leave a box empty for no limit.' : 'Free tiers have limits. JobPilot paces itself to stay under the ones you enter.'}
          </p>
        </>
      )}

      {result && (
        <p className={result.ok ? 'flex items-center gap-1.5 text-sm text-good' : 'flex items-center gap-1.5 text-sm text-bad'} role="status">
          {result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {result.message}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="primary" loading={busy === 'test'} disabled={blocked}>
          Save and test
        </Button>
        <Button type="button" loading={busy === 'save'} disabled={blocked} onClick={() => void submit(false)}>
          Save without testing
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

function PresetGroup({ title, caption, presets, selected, onPick }: { title: string; caption: string; presets: ProviderPreset[]; selected: string | null; onPick: (p: ProviderPreset) => void }): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={`${title} setups`} className="space-y-1.5">
      <div>
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="text-xs text-faint">{caption}</p>
      </div>
      {presets.map((p) => (
        <label
          key={p.id}
          className={clsx(
            'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
            selected === p.id ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted hover:bg-hover/60 hover:text-fg'
          )}
        >
          <input type="radio" name="preset" value={p.id} checked={selected === p.id} onChange={() => onPick(p)} className="accent-[var(--accent)]" />
          <span className="min-w-0 flex-1">{p.label}</span>
        </label>
      ))}
    </div>
  )
}
