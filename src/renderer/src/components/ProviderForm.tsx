import { useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { PROVIDER_DEFAULT_BASE_URL, PROVIDER_LABELS, PROVIDER_NEEDS_KEY } from '@shared/defaults'
import type { ProviderInfo, ProviderKind } from '@shared/types'
import type { ProviderTestResult } from '@shared/api'
import { api } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { useToast } from '@renderer/lib/toast'
import { Button, Field, Input, Notice, Select } from './ui'

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

interface Props {
  initial?: ProviderInfo
  onSaved: (provider: ProviderInfo, test: ProviderTestResult | null) => void
  onCancel?: () => void
}

/** Add or edit one AI provider. The key field is write-only. */
export function ProviderForm({ initial, onSaved, onCancel }: Props): React.JSX.Element {
  const toast = useToast()
  const [kind, setKind] = useState<ProviderKind>(initial?.kind ?? 'anthropic')
  const [label, setLabel] = useState(initial?.label ?? PROVIDER_LABELS[initial?.kind ?? 'anthropic'])
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [result, setResult] = useState<ProviderTestResult | null>(null)

  const needsKey = PROVIDER_NEEDS_KEY[kind]
  const needsUrl = kind === 'ollama' || kind === 'openai_compatible'
  const showUrl = needsUrl || kind === 'openrouter' || kind === 'gemini'
  const hasStoredKey = initial?.hasKey ?? false
  const keyStorageWeak = useKeyStorageWeak()
  const missingKey = needsKey && !apiKey && !hasStoredKey
  const missingUrl = kind === 'openai_compatible' && !baseUrl.trim()

  function changeKind(next: ProviderKind): void {
    const wasDefaultLabel = label === PROVIDER_LABELS[kind] || !label
    setKind(next)
    if (wasDefaultLabel) setLabel(PROVIDER_LABELS[next])
    setBaseUrl(PROVIDER_DEFAULT_BASE_URL[next] ?? '')
    setResult(null)
  }

  async function submit(test: boolean): Promise<void> {
    setBusy(test ? 'test' : 'save')
    try {
      const saved = await api.saveProvider({
        id: initial?.id,
        kind,
        label: label.trim() || PROVIDER_LABELS[kind],
        baseUrl: baseUrl.trim() || null,
        ...(apiKey ? { apiKey } : {})
      })
      setApiKey('')
      let tested: ProviderTestResult | null = null
      if (test) {
        tested = await api.testProvider(saved.id)
        setResult(tested)
      }
      onSaved(saved, tested)
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
        void submit(true)
      }}
      autoComplete="off"
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider">
          <Select value={kind} onChange={(e) => changeKind(e.target.value as ProviderKind)} disabled={!!initial}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {PROVIDER_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
      {showUrl && (
        <Field label="Base URL" hint={needsUrl ? 'Where the API lives, for example http://localhost:11434/v1.' : 'Leave as is unless you use a proxy.'}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={PROVIDER_DEFAULT_BASE_URL[kind] ?? 'https://api.example.com/v1'} />
        </Field>
      )}
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
      <KeyStorageWarning />
      {result && (
        <p className={result.ok ? 'flex items-center gap-1.5 text-sm text-good' : 'flex items-center gap-1.5 text-sm text-bad'} role="status">
          {result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {result.message}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="primary" loading={busy === 'test'} disabled={busy !== null || missingKey || missingUrl}>
          Save and test
        </Button>
        <Button type="button" loading={busy === 'save'} disabled={busy !== null || missingKey || missingUrl} onClick={() => void submit(false)}>
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
