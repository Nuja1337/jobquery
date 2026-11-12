import { useEffect, useMemo, useRef, useState } from 'react'
import { useBlocker, useNavigate } from 'react-router'
import { AlertTriangle, CheckCircle2, Download, FolderOpen, Gauge, Loader2, Pencil, Plus, RefreshCw, TestTube2, Trash2 } from 'lucide-react'
import { clsx } from 'clsx'
import { BILLING_RESPONSIBILITY, BUILTIN_PRICES, PROVIDER_LABELS } from '@shared/defaults'
import type { DeepPartial } from '@shared/api'
import type { AppInfo } from '@shared/api'
import type { BrowserChannel, CoverLetterLength, LlmStage, ModelPrice, ProviderInfo, RemotePreference, Seniority, Settings, UpdateStatus } from '@shared/types'
import { api, isDemo } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { applyTheme, getStoredTheme, setOnboardingSkipped, type Theme } from '@renderer/lib/theme'
import { relativeTime } from '@renderer/lib/format'
import { autopilotConfirmMessage } from '@renderer/lib/autopilot'
import { suggestedModel } from '@renderer/lib/providers'
import { ProviderBillingBadge } from '@renderer/components/badges'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { DiversityCard } from '@renderer/components/DiversityCard'
import { ModelPicker } from '@renderer/components/ModelPicker'
import { PresetDialog } from '@renderer/components/PresetDialog'
import { thresholdContext } from '@renderer/components/volumeHelpers'
import { RestartToUpdateDialog } from '@renderer/components/RestartToUpdateDialog'
import { EmploymentTypeChips } from '@renderer/components/WorkFactsEditor'
import { KEY_STORAGE_NOTE, KeyStorageWarning, ProviderForm, describeLimits, useKeyStorageWeak } from '@renderer/components/ProviderForm'
import { Badge, Button, Card, CardHeader, Checkbox, Chip, ErrorBlock, Field, IconButton, Input, Loading, Modal, NumberInput, Page, PageHeader, ProgressBar, Segmented, Select, TD, TH, TagInput, Textarea, Toggle } from '@renderer/components/ui'

const SECTIONS = [
  ['providers', 'AI providers'],
  ['models', 'Models'],
  ['budget', 'Budgets'],
  ['prices', 'Prices'],
  ['preferences', 'Job preferences'],
  ['discovery', 'Finding jobs'],
  ['thresholds', 'Thresholds'],
  ['autopilot', 'Autopilot'],
  ['system', 'Running in the background'],
  ['browser', 'Browser'],
  ['writing', 'Writing'],
  ['eeo', 'Self-identification'],
  ['updates', 'Updates'],
  ['data', 'Theme and data']
] as const

const STAGES: Array<{ id: LlmStage; label: string; hint: string }> = [
  { id: 'triage', label: 'Scoring fit', hint: 'Runs on every new job, so choose a cheap, fast model.' },
  { id: 'writing', label: 'Writing', hint: 'Cover letters and open-ended answers. Use your strongest model.' },
  { id: 'extraction', label: 'Reading', hint: 'Resume parsing, form mapping and voice analysis.' }
]

const SENIORITY: Seniority[] = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'executive']
const REMOTE: Array<{ id: RemotePreference; label: string }> = [
  { id: 'remote', label: 'Remote' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'onsite', label: 'On site' }
]

type SectionKey = keyof Settings

export function SettingsPage(): React.JSX.Element {
  const toast = useToast()
  const { settings, updateSettings } = useApp()
  const [draft, setDraft] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const providers = useAsync(() => api.listProviders(), [])
  // The scores of jobs found in the last 7 days, to show what each threshold would have passed.
  const scores = useAsync(() => api.getAnalytics(1), [])
  const [presetOpen, setPresetOpen] = useState(false)
  const leaving = useRef(false)

  useEffect(() => {
    if (settings) setDraft((cur) => cur ?? structuredClone(settings))
  }, [settings])

  const changed = useMemo<SectionKey[]>(() => {
    if (!draft || !settings) return []
    return (Object.keys(draft) as SectionKey[]).filter((k) => k !== 'prices' && k !== 'onboardingDone' && JSON.stringify(draft[k]) !== JSON.stringify(settings[k]))
  }, [draft, settings])

  const blocker = useBlocker(({ currentLocation, nextLocation }) => changed.length > 0 && currentLocation.pathname !== nextLocation.pathname)

  if (!draft || !settings) return <Loading />

  const set = <K extends SectionKey>(key: K, patch: Partial<Settings[K]>): void => setDraft({ ...draft, [key]: { ...(draft[key] as object), ...patch } as Settings[K] })
  /** What a threshold would have passed in the last 7 days. Empty until the counts load. */
  const scoreLine = (threshold: number): string => (scores.data ? ` ${thresholdContext(scores.data.scoreCounts, threshold)}` : '')

  async function save(): Promise<void> {
    if (!draft) return
    setSaving(true)
    const patch: Record<string, unknown> = {}
    changed.forEach((k) => (patch[k] = draft[k]))
    const next = await updateSettings(patch as DeepPartial<Settings>)
    if (next) {
      setDraft(structuredClone(next))
      toast.success('Settings saved.')
    }
    setSaving(false)
  }

  return (
    <Page>
      <PageHeader
        title="Settings"
        intro="Providers, budgets, filters, autopilot and how your applications are written."
        actions={
          <Button icon={<Gauge size={14} />} disabled={changed.length > 0} title={changed.length > 0 ? 'Save or discard your changes first.' : undefined} onClick={() => setPresetOpen(true)}>
            Set up for volume
          </Button>
        }
      />

      {presetOpen && (
        <PresetDialog
          current={settings}
          onClose={() => setPresetOpen(false)}
          onApplied={(next) => setDraft(structuredClone(next))}
        />
      )}

      {changed.length > 0 && (
        <div className="sticky top-0 z-20 -mx-2 mb-4 flex items-center justify-between rounded-lg border border-accent/50 bg-surface px-4 py-2.5 shadow-lg">
          <p className="text-sm text-fg">You have unsaved changes.</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setDraft(structuredClone(settings))}>
              Discard
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
          </div>
        </div>
      )}

      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="Leave without saving?"
          message="Your changes on this page aren't saved. If you leave now, they're lost."
          confirmLabel="Leave without saving"
          danger
          onClose={() => {
            if (!leaving.current) blocker.reset?.()
          }}
          onConfirm={() => {
            leaving.current = true
            blocker.proceed?.()
          }}
        />
      )}

      <div className="grid grid-cols-[11rem_minmax(0,1fr)] gap-6">
        <nav className="sticky top-4 self-start" aria-label="Settings sections">
          <ul className="space-y-0.5">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#settings-${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) }} className="block rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-hover hover:text-fg">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-5">
          <ProvidersCard
            providers={providers.data}
            error={providers.error}
            reload={providers.reload}
            onDeleted={async () => {
              // Main may have cleared routing that used the deleted provider. Take its copy so saving doesn't write the old one back.
              const fresh = await updateSettings({})
              if (fresh) setDraft((cur) => (cur ? { ...cur, routing: structuredClone(fresh.routing) } : cur))
            }}
          />

          <Card id="settings-models">
            <CardHeader title="Models" hint="Each stage can use a different provider and model, so cheap work runs on cheap models." />
            <div className="space-y-4 p-4">
              {!providers.data || providers.data.length === 0 ? (
                <p className="text-sm text-muted">Add an AI provider first.</p>
              ) : (
                STAGES.map((s) => (
                  <Field key={s.id} label={s.label} hint={s.hint}>
                    <ModelPicker
                      label={s.label}
                      providers={providers.data as ProviderInfo[]}
                      value={draft.routing[s.id]}
                      onChange={(ref) => set('routing', { [s.id]: ref })}
                      suggested={(provider) => suggestedModel(provider, s.id)}
                    />
                  </Field>
                ))
              )}
            </div>
          </Card>

          <Card id="settings-budget">
            <CardHeader title="Budgets" hint="JobQuery stops making paid AI calls when its estimate of your spend reaches a budget, and a call already running can go a little over. A budget of 0 means no limit, and free and local providers don't count. The estimate uses the prices below, so your real bill can differ. Set a spend limit with your provider too." />
            <div className="grid grid-cols-2 gap-4 p-4">
              <Field label="Daily budget (US dollars)" hint={draft.budget.dailyUsd === 0 ? 'No daily limit. The monthly budget still applies if you set one.' : 'Enter 0 for no limit.'}>
                <BudgetInput value={draft.budget.dailyUsd} step={0.1} onChange={(v) => set('budget', { dailyUsd: v })} />
              </Field>
              <Field label="Monthly budget (US dollars)" hint={draft.budget.monthlyUsd === 0 ? 'No monthly limit. The daily budget still applies if you set one.' : 'Enter 0 for no limit.'}>
                <BudgetInput value={draft.budget.monthlyUsd} step={1} onChange={(v) => set('budget', { monthlyUsd: v })} />
              </Field>
              <Field label="Jobs scored per run" hint="The most jobs sent to the AI in one run.">
                <NumberInput value={draft.budget.maxTriagePerRun} min={0} onChange={(v) => set('budget', { maxTriagePerRun: v ?? 0 })} />
              </Field>
              <Field label="Applications drafted per run">
                <NumberInput value={draft.budget.maxPreparePerRun} min={0} onChange={(v) => set('budget', { maxPreparePerRun: v ?? 0 })} />
              </Field>
            </div>
          </Card>

          <PricesCard
            prices={settings.prices}
            onSave={async (model, price) => (await updateSettings({ prices: { [model]: price } })) !== null}
            onReset={async (model) => {
              try {
                await api.removePriceOverride(model)
                await updateSettings({})
              } catch (e) {
                toast.error(e)
              }
            }}
          />

          <Card id="settings-preferences">
            <CardHeader title="Job preferences" hint="Free filters. A job that fails one costs no tokens." />
            <div className="space-y-4 p-4">
              <Field label="Target titles" hint="Press Enter after each title.">
                <TagInput value={draft.preferences.targetTitles} onChange={(v) => set('preferences', { targetTitles: v })} placeholder="Senior Frontend Engineer" />
              </Field>
              <Field label="Keywords that raise the score">
                <TagInput value={draft.preferences.includeKeywords} onChange={(v) => set('preferences', { includeKeywords: v })} placeholder="react" />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Drop jobs with these words in the title">
                  <TagInput value={draft.preferences.excludeTitleKeywords} onChange={(v) => set('preferences', { excludeTitleKeywords: v })} placeholder="intern" />
                </Field>
                <Field label="Drop jobs with these words in the description">
                  <TagInput value={draft.preferences.excludeDescriptionKeywords} onChange={(v) => set('preferences', { excludeDescriptionKeywords: v })} placeholder="security clearance" />
                </Field>
              </div>
              <Field label="Locations you can work from" hint="Leave empty for anywhere.">
                <TagInput value={draft.preferences.locations} onChange={(v) => set('preferences', { locations: v })} placeholder="Berlin" />
              </Field>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <span className="text-xs font-medium text-muted">Work style</span>
                {REMOTE.map((r) => (
                  <Checkbox key={r.id} label={r.label} checked={draft.preferences.remote.includes(r.id)} onChange={(on) => set('preferences', { remote: on ? [...draft.preferences.remote, r.id] : draft.preferences.remote.filter((x) => x !== r.id) })} />
                ))}
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted">Employment type</p>
                <EmploymentTypeChips value={draft.preferences.employmentTypes} onChange={(v) => set('preferences', { employmentTypes: v })} />
                <p className="mt-1 text-xs text-faint">Select none to see every type. Your answers to employment questions on forms are under Profile, then Applying.</p>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted">Seniority</p>
                <div className="flex flex-wrap gap-1.5">
                  {SENIORITY.map((s) => (
                    <Chip key={s} className="capitalize" selected={draft.preferences.seniority.includes(s)} onClick={() => set('preferences', { seniority: draft.preferences.seniority.includes(s) ? draft.preferences.seniority.filter((x) => x !== s) : [...draft.preferences.seniority, s] })}>
                      {s}
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-4 gap-4">
                <Field label="Minimum yearly pay" className="col-span-2">
                  <div className="flex gap-2">
                    <NumberInput value={draft.preferences.minSalary} min={0} step={1000} placeholder="No minimum" onChange={(v) => set('preferences', { minSalary: v })} />
                    <Input value={draft.preferences.salaryCurrency} onChange={(e) => set('preferences', { salaryCurrency: e.target.value.toUpperCase().slice(0, 3) })} className="w-20" aria-label="Currency" />
                  </div>
                </Field>
                <Field label="Ignore postings older than (days)">
                  <NumberInput value={draft.preferences.maxPostingAgeDays} min={1} onChange={(v) => set('preferences', { maxPostingAgeDays: v ?? 30 })} />
                </Field>
                <Field label="Company cooldown (days)" hint="Skip a company you applied to recently.">
                  <NumberInput value={draft.preferences.companyCooldownDays} min={0} onChange={(v) => set('preferences', { companyCooldownDays: v ?? 0 })} />
                </Field>
              </div>
              <Field label="Companies to never show">
                <TagInput value={draft.preferences.excludedCompanies} onChange={(v) => set('preferences', { excludedCompanies: v })} placeholder="Company name" />
              </Field>
              <Toggle checked={draft.preferences.needsVisaSponsorship} onChange={(v) => set('preferences', { needsVisaSponsorship: v })} label="I need visa sponsorship" hint="Jobs that say they do not sponsor are dropped." />
            </div>
          </Card>

          <DiscoveryCard draft={draft} set={set} />

          <Card id="settings-thresholds">
            <CardHeader title="Thresholds" hint="Scores run from 0 to 100." />
            <div className="grid grid-cols-2 gap-4 p-4">
              <Field label="Keyword prescore needed to reach the AI" hint="Higher means fewer tokens spent.">
                <NumberInput value={draft.thresholds.prescoreMin} min={0} max={100} onChange={(v) => set('thresholds', { prescoreMin: v ?? 0 })} />
              </Field>
              <Field label="Fit score for the shortlist" hint={<>Below this a job is archived as not a fit.{scoreLine(draft.thresholds.shortlistScore)}</>}>
                <NumberInput value={draft.thresholds.shortlistScore} min={0} max={100} onChange={(v) => set('thresholds', { shortlistScore: v ?? 0 })} />
              </Field>
              <Field label="Fit score to draft an application automatically" hint={scoreLine(draft.thresholds.autoPrepareScore).trim()}>
                <NumberInput value={draft.thresholds.autoPrepareScore} min={0} max={100} onChange={(v) => set('thresholds', { autoPrepareScore: v ?? 0 })} />
              </Field>
              <Field label="Fit score to submit automatically" hint={<>Only used when auto-submit is on.{scoreLine(draft.thresholds.autoSubmitScore)}</>}>
                <NumberInput value={draft.thresholds.autoSubmitScore} min={0} max={100} onChange={(v) => set('thresholds', { autoSubmitScore: v ?? 0 })} />
              </Field>
            </div>
          </Card>

          <AutopilotCard draft={draft} set={set} />
          <BackgroundCard draft={draft} set={set} />

          <Card id="settings-browser">
            <CardHeader title="Browser" hint="JobQuery fills forms in a real browser window." />
            <div className="grid grid-cols-2 gap-4 p-4">
              <Field label="Browser">
                <Select value={draft.browser.channel} onChange={(e) => set('browser', { channel: e.target.value as BrowserChannel })}>
                  <option value="chrome">Google Chrome</option>
                  <option value="msedge">Microsoft Edge</option>
                  <option value="chromium">Chromium</option>
                </Select>
              </Field>
              <Field label="Pause between actions (milliseconds)" hint="Higher is gentler on sites and breaks less.">
                <NumberInput value={draft.browser.slowMoMs} min={0} step={10} onChange={(v) => set('browser', { slowMoMs: v ?? 0 })} />
              </Field>
              <div className="col-span-2">
                <Toggle checked={draft.browser.keepOpen} onChange={(v) => set('browser', { keepOpen: v })} label="Keep the browser open after submitting" hint="So you can check the confirmation page." />
              </div>
            </div>
          </Card>

          <Card id="settings-writing">
            <CardHeader title="Writing" hint="How cover letters and answers are drafted and checked." />
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-3 gap-4">
                <Field label="Cover letter length">
                  <Select value={draft.writing.coverLetterLength} onChange={(e) => set('writing', { coverLetterLength: e.target.value as CoverLetterLength })}>
                    <option value="short">Short</option>
                    <option value="medium">Medium</option>
                    <option value="long">Long</option>
                  </Select>
                </Field>
                <Field label="Minimum human score" hint="Drafts below this are revised.">
                  <NumberInput value={draft.writing.minLintScore} min={0} max={100} onChange={(v) => set('writing', { minLintScore: v ?? 0 })} />
                </Field>
                <Field label="Most revisions" hint="Each one costs tokens.">
                  <NumberInput value={draft.writing.maxRevisions} min={0} max={5} onChange={(v) => set('writing', { maxRevisions: v ?? 0 })} />
                </Field>
              </div>
              <Toggle checked={draft.writing.alwaysCoverLetter} onChange={(v) => set('writing', { alwaysCoverLetter: v })} label="Always write a cover letter" hint="Even when the form does not ask for one." />
              <Field label="Phrases to never use" hint="Added to the built-in list of phrases that sound AI-written.">
                <TagInput value={draft.writing.bannedPhrases} onChange={(v) => set('writing', { bannedPhrases: v })} placeholder="wear many hats" />
              </Field>
              <Field label="Style notes" hint="For example: dry humor is fine, never exclamation marks.">
                <Textarea rows={3} value={draft.writing.styleNotes} onChange={(e) => set('writing', { styleNotes: e.target.value })} />
              </Field>
            </div>
          </Card>

          <DiversityCard eeo={draft.eeo} onChange={(patch) => set('eeo', patch)} />
          <UpdatesCard draft={draft} set={set} />
          <DataCard />
        </div>
      </div>
    </Page>
  )
}

/**
 * A dollar amount that is never empty. Clearing the field and leaving it puts the old value back,
 * because the main process reads 0 as "no limit" and an empty field must not turn the cap off.
 */
function BudgetInput({ value, step, onChange }: { value: number; step: number; onChange: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    // Follow outside changes such as Discard, but don't fight what is being typed.
    setText((cur) => (cur.trim() !== '' && Number(cur) === value ? cur : String(value)))
  }, [value])
  return (
    <Input
      type="number"
      min={0}
      step={step}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 0) onChange(n)
      }}
      onBlur={() => {
        if (text.trim() === '' || !Number.isFinite(Number(text)) || Number(text) < 0) setText(String(value))
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function ProvidersCard({ providers, error, reload, onDeleted }: { providers: ProviderInfo[] | null; error: string | null; reload: () => void; onDeleted: () => Promise<void> }): React.JSX.Element {
  const toast = useToast()
  const [editing, setEditing] = useState<ProviderInfo | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ProviderInfo | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const keyStorageWeak = useKeyStorageWeak()

  async function test(p: ProviderInfo): Promise<void> {
    setTesting(p.id)
    try {
      const r = await api.testProvider(p.id)
      if (r.ok) toast.success(`${p.label}: ${r.message}`)
      else toast.error(new Error(`${p.label}: ${r.message}`))
    } catch (e) {
      toast.error(e)
    } finally {
      setTesting(null)
    }
  }

  return (
    <Card id="settings-providers">
      <CardHeader
        title="AI providers"
        hint={`Bring your own key. ${keyStorageWeak ? '' : `${KEY_STORAGE_NOTE} `}Keys are never shown again. ${BILLING_RESPONSIBILITY}`}
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing('new')}>
            Add provider
          </Button>
        }
      />
      {keyStorageWeak && (
        <div className="border-b border-line p-4">
          <KeyStorageWarning />
        </div>
      )}
      {error ? (
        <div className="p-4">
          <ErrorBlock message={error} onRetry={reload} />
        </div>
      ) : !providers ? (
        <Loading />
      ) : providers.length === 0 ? (
        <p className="p-4 text-sm text-muted">No providers yet. Add one to start scoring jobs and writing applications.</p>
      ) : (
        <ul className="divide-y divide-line">
          {providers.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{p.label}</p>
                <p className="text-xs text-faint">
                  {PROVIDER_LABELS[p.kind]}
                  {p.baseUrl ? `, ${p.baseUrl}` : ''}
                </p>
                {describeLimits(p) && <p className="text-xs text-faint">{describeLimits(p)}</p>}
              </div>
              <ProviderBillingBadge provider={p} />
              {p.hasKey ? (
                <Badge tone="good">
                  <CheckCircle2 size={11} /> Key saved
                </Badge>
              ) : (
                <Badge>No key</Badge>
              )}
              <Button size="sm" icon={<TestTube2 size={13} />} loading={testing === p.id} onClick={() => void test(p)}>
                Test
              </Button>
              <IconButton label={`Edit ${p.label}`} onClick={() => setEditing(p)}>
                <Pencil size={15} />
              </IconButton>
              <IconButton label={`Delete ${p.label}`} onClick={() => setDeleting(p)}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <Modal title={editing === 'new' ? 'Add a provider' : `Edit ${editing.label}`} onClose={() => setEditing(null)}>
          <ProviderForm
            initial={editing === 'new' ? undefined : editing}
            onCancel={() => setEditing(null)}
            onSaved={(_p, tested) => {
              reload()
              if (!tested || tested.ok) setEditing(null)
            }}
          />
        </Modal>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete provider"
          message={`Delete ${deleting.label} and its saved key? Any stage that uses it will need another model.`}
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteProvider(deleting.id)
              reload()
              await onDeleted()
            } catch (e) {
              toast.error(e)
              throw e
            }
          }}
        />
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

function PricesCard({ prices, onSave, onReset }: { prices: Settings['prices']; onSave: (model: string, price: ModelPrice) => Promise<boolean>; onReset: (model: string) => Promise<void> }): React.JSX.Element {
  const [newModel, setNewModel] = useState('')
  const [newIn, setNewIn] = useState('')
  const [newOut, setNewOut] = useState('')
  const [isFree, setIsFree] = useState(false)
  const [adding, setAdding] = useState(false)
  const inVal = newIn.trim() === '' ? null : Number(newIn)
  const outVal = newOut.trim() === '' ? null : Number(newOut)
  const pricesOk = inVal !== null && outVal !== null && Number.isFinite(inVal) && Number.isFinite(outVal) && inVal >= 0 && outVal >= 0
  const allZero = pricesOk && inVal === 0 && outVal === 0
  const canAdd = !!newModel.trim() && pricesOk && (!allZero || isFree) && !adding
  const models = useMemo(() => [...new Set([...Object.keys(BUILTIN_PRICES), ...Object.keys(prices)])].sort(), [prices])

  return (
    <Card id="settings-prices">
      <CardHeader title="Prices" hint="Prices are in US dollars per million tokens, and the spend numbers and budgets use them. These are JobQuery's copy of published prices, and providers change their prices, so check them against your provider's price page. Your numbers override the built-in ones. Models with no price count as $3 in and $15 out until you add one. Models on free providers are always $0." />
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={TH}>Model</th>
            <th className={TH}>Input</th>
            <th className={TH}>Output</th>
            <th className={TH}>Cached input</th>
            <th className={TH} />
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <PriceRow key={`${m}-${JSON.stringify(prices[m] ?? null)}`} model={m} price={prices[m] ?? BUILTIN_PRICES[m]} custom={!!prices[m]} builtin={BUILTIN_PRICES[m]} onSave={onSave} onReset={onReset} />
          ))}
        </tbody>
      </table>
      <form
        className="space-y-2 border-t border-line p-4"
        onSubmit={(e) => {
          e.preventDefault()
          const id = newModel.trim()
          if (!canAdd || inVal === null || outVal === null) return
          setAdding(true)
          void onSave(id, { inputPerMTok: inVal, outputPerMTok: outVal })
            .then((saved) => {
              if (!saved) return
              setNewModel('')
              setNewIn('')
              setNewOut('')
              setIsFree(false)
            })
            .finally(() => setAdding(false))
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="Add a model, for example llama3.1:8b" className="max-w-sm" aria-label="Model to add" />
          <Input type="number" min={0} step={0.01} value={newIn} onChange={(e) => setNewIn(e.target.value)} placeholder="Input price" className="w-28" aria-label="Input price per million tokens" />
          <Input type="number" min={0} step={0.01} value={newOut} onChange={(e) => setNewOut(e.target.value)} placeholder="Output price" className="w-28" aria-label="Output price per million tokens" />
          <Button type="submit" icon={<Plus size={13} />} disabled={!canAdd} loading={adding}>
            Add model
          </Button>
        </div>
        <p className="text-xs text-faint">Enter what the model costs per million tokens. A model priced at 0 never counts toward your budgets.</p>
        {allZero && <Checkbox label="This model is free, so both prices are 0" checked={isFree} onChange={setIsFree} />}
      </form>
    </Card>
  )
}

function PriceRow({ model, price, custom, builtin, onSave, onReset }: { model: string; price: ModelPrice; custom: boolean; builtin?: ModelPrice; onSave: (model: string, price: ModelPrice) => Promise<boolean>; onReset: (model: string) => Promise<void> }): React.JSX.Element {
  const [p, setP] = useState(price)
  const [busy, setBusy] = useState(false)
  const dirty = JSON.stringify(p) !== JSON.stringify(price)
  const num = (key: keyof ModelPrice) => (
    <Input
      type="number"
      min={0}
      step={0.01}
      value={p[key] ?? ''}
      className="h-7 w-24"
      aria-label={`${model} ${key}`}
      onChange={(e) => setP({ ...p, [key]: e.target.value === '' ? undefined : Number(e.target.value) })}
    />
  )
  return (
    <tr>
      <td className={TD}>
        <span className="font-mono text-xs text-fg">{model}</span> {custom && <Badge tone="accent">Custom</Badge>}
      </td>
      <td className={TD}>{num('inputPerMTok')}</td>
      <td className={TD}>{num('outputPerMTok')}</td>
      <td className={TD}>{num('cachedInputPerMTok')}</td>
      <td className={clsx(TD, 'text-right')}>
        <div className="flex justify-end gap-1.5">
          {dirty && (
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onSave(model, { ...p, inputPerMTok: p.inputPerMTok ?? 0, outputPerMTok: p.outputPerMTok ?? 0 })
                } finally {
                  setBusy(false)
                }
              }}
            >
              Save
            </Button>
          )}
          {custom && !dirty && (
            <Button size="sm" variant="ghost" onClick={() => void onReset(model)}>
              {builtin ? 'Use built-in' : 'Remove'}
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

function AutopilotCard({ draft, set }: { draft: Settings; set: <K extends SectionKey>(key: K, patch: Partial<Settings[K]>) => void }): React.JSX.Element {
  const a = draft.autopilot
  const continuous = a.mode === 'continuous'
  const [confirmAuto, setConfirmAuto] = useState(false)
  /** Turning autopilot on, or dry run off, while auto-submit is on lets the app send applications by itself. */
  const [confirmSend, setConfirmSend] = useState<null | 'enable' | 'dryRun'>(null)
  return (
    <Card id="settings-autopilot">
      <CardHeader title="Autopilot" hint={continuous ? 'Works all day while the app is open.' : 'Runs on a schedule while the app is open.'} />
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-4">
          <Toggle checked={a.enabled} onChange={(v) => (v && a.autoSubmit && !a.dryRun ? setConfirmSend('enable') : set('autopilot', { enabled: v }))} label={continuous ? 'Run autopilot' : 'Run on a schedule'} />
          {!continuous && (
            <Field label="Run every (hours)">
              <NumberInput value={a.intervalHours} min={1} max={168} onChange={(v) => set('autopilot', { intervalHours: v ?? 6 })} />
            </Field>
          )}
        </div>
        <Toggle
          checked={continuous}
          onChange={(v) => set('autopilot', { mode: v ? 'continuous' : 'interval' })}
          label="Run continuously"
          hint="Keep finding, scoring, preparing and sending all day, within the caps below."
        />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Applications per company" hint="How many applications one company may get inside the cooldown. The cooldown is also under Filters.">
            <div className="flex items-center gap-2 text-sm text-muted">
              <NumberInput value={draft.preferences.perCompanyLimit} min={1} max={100} className="w-20" onChange={(v) => set('preferences', { perCompanyLimit: Math.max(1, v ?? 1) })} />
              <span>{draft.preferences.perCompanyLimit === 1 ? 'application' : 'applications'} per company every</span>
              <NumberInput value={draft.preferences.companyCooldownDays} min={0} className="w-20" onChange={(v) => set('preferences', { companyCooldownDays: v ?? 0 })} />
              <span>days</span>
            </div>
          </Field>
          {continuous && (
            <Field label="Submit tabs at once" hint="Applications filled in the browser at the same time, 1 to 3. One company is never filled twice at once.">
              <NumberInput value={a.submitConcurrency} min={1} max={3} onChange={(v) => set('autopilot', { submitConcurrency: Math.min(3, Math.max(1, v ?? 1)) })} />
            </Field>
          )}
          {continuous && (
            <Field label="Most applications per hour" hint="Lever is held to 15 an hour, because it shows a captcha when forms are sent fast.">
              <NumberInput value={a.hourlySubmitCap} min={0} max={1000} onChange={(v) => set('autopilot', { hourlySubmitCap: v ?? 0 })} />
            </Field>
          )}
          {continuous && (
            <Field label="Jobs scored per day" hint="The most jobs sent to the AI for scoring in one day.">
              <NumberInput value={draft.budget.maxTriagePerDay} min={0} onChange={(v) => set('budget', { maxTriagePerDay: v ?? 0 })} />
            </Field>
          )}
          {continuous && (
            <Field label="Applications prepared per day" hint="The most applications drafted in one day.">
              <NumberInput value={draft.budget.maxPreparePerDay} min={0} onChange={(v) => set('budget', { maxPreparePerDay: v ?? 0 })} />
            </Field>
          )}
        </div>
        <Toggle checked={a.autoPrepare} onChange={(v) => set('autopilot', { autoPrepare: v })} label="Draft applications automatically" hint={`For jobs that score ${draft.thresholds.autoPrepareScore} or more. Drafts wait in the review queue.`} />

        <div className={clsx('rounded-lg border p-4', a.autoSubmit ? 'border-warn/60 bg-warn-soft' : 'border-line')}>
          <Toggle
            checked={a.autoSubmit}
            onChange={(v) => (v ? setConfirmAuto(true) : set('autopilot', { autoSubmit: false }))}
            label="Submit applications automatically"
            hint="JobQuery clicks Submit for you, without you looking at the draft first."
          />
          <div className="mt-3 flex items-start gap-2 text-sm text-muted">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
            <div>
              <p className="text-fg">Auto-submit sends real applications in your name. Turn it on only after you trust the drafts.</p>
              <p className="mt-1">Guardrails apply when it is on. It only submits jobs that score {draft.thresholds.autoSubmitScore} or more, never more than {a.dailySubmitCap} a day, and never when an answer is flagged for you. Consent boxes, terms and questions about AI use are left for you. Autopilot sends a form that has one only when you allow it with the options below. Try dry run first.</p>
            </div>
          </div>
          <div className={clsx('mt-4 grid grid-cols-2 gap-4', !a.autoSubmit && 'opacity-60')}>
            <Field label="Fit score needed" hint="Change this under Thresholds.">
              <Input value={draft.thresholds.autoSubmitScore} disabled readOnly />
            </Field>
            <Field label="Most applications per day">
              <NumberInput value={a.dailySubmitCap} min={0} max={1000} onChange={(v) => set('autopilot', { dailySubmitCap: v ?? 0 })} />
            </Field>
            <Toggle checked={a.requireNoFlags} onChange={() => undefined} disabled label="Skip applications with flagged answers" hint="Always on." />
            <Toggle checked={a.dryRun} onChange={(v) => (!v && a.autoSubmit ? setConfirmSend('dryRun') : set('autopilot', { dryRun: v }))} label="Dry run" hint="Fill the form, take a screenshot and stop before the final click." />
            <Toggle
              checked={a.tickRequiredConsent}
              onChange={(v) => set('autopilot', { tickRequiredConsent: v })}
              label="Tick required privacy and truthfulness boxes"
              hint="Agrees to required boxes that only let the employer handle your application data or say your answers are true. It does not cover terms, waivers, arbitration, background checks or questions about AI use."
            />
            <Toggle
              checked={a.sendSavedUserAnswers}
              onChange={(v) => set('autopilot', { sendSavedUserAnswers: v })}
              label="Send my saved answers to questions only I answer"
              hint="Lets autopilot send a form where a question about AI use, consent or legal terms was filled from an answer you wrote yourself."
            />
          </div>
        </div>
      </div>
      {confirmSend && (
        <ConfirmDialog
          title={confirmSend === 'enable' ? 'Turn on autopilot?' : 'Turn off dry run?'}
          confirmLabel={confirmSend === 'enable' ? 'Turn on autopilot' : 'Turn off dry run'}
          message={autopilotConfirmMessage({ thresholds: draft.thresholds, autopilot: { ...a, dryRun: false } }, confirmSend === 'enable')}
          onClose={() => setConfirmSend(null)}
          onConfirm={() => set('autopilot', confirmSend === 'enable' ? { enabled: true } : { dryRun: false })}
        />
      )}
      {confirmAuto && (
        <ConfirmDialog
          title="Turn on auto-submit"
          message={`JobQuery will submit applications without asking you first, up to ${a.dailySubmitCap} a day, for jobs that score ${draft.thresholds.autoSubmitScore} or more. You can switch dry run on to test it. Turn it on?`}
          confirmLabel="Turn on auto-submit"
          onClose={() => setConfirmAuto(false)}
          onConfirm={() => set('autopilot', { autoSubmit: true })}
        />
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Finding jobs
// ---------------------------------------------------------------------------

function DiscoveryCard({ draft, set }: { draft: Settings; set: <K extends SectionKey>(key: K, patch: Partial<Settings[K]>) => void }): React.JSX.Element {
  const d = draft.discovery
  return (
    <Card id="settings-discovery">
      <CardHeader title="Finding jobs" hint="JobQuery checks each watched company board on its own schedule. A board with a good job in the last two weeks is checked about every hour, and a board with nothing good for two months about once a day." />
      <div className="space-y-4 p-4">
        <Toggle checked={d.autoWatchBoards} onChange={(v) => set('discovery', { autoWatchBoards: v })} label="Watch any company board that a posting links to." hint="A posting on Remotive, Hacker News or another job site often links to the employer's own board. JobQuery starts watching that board unless you blocked the company or turned its watch off before." />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Most company boards to watch" hint="JobQuery stops adding boards by itself when this many are watched. Boards you add yourself always work.">
            <NumberInput value={d.maxWatchedBoards} min={0} max={100000} step={100} onChange={(v) => set('discovery', { maxWatchedBoards: v ?? 0 })} />
          </Field>
          <Field label="Boards checked per run" hint="The boards that have waited longest go first. The rest wait for the next run.">
            <NumberInput value={d.boardsPerRun} min={1} max={20000} step={100} onChange={(v) => set('discovery', { boardsPerRun: v ?? 1 })} />
          </Field>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Running in the background
// ---------------------------------------------------------------------------

function BackgroundCard({ draft, set }: { draft: Settings; set: <K extends SectionKey>(key: K, patch: Partial<Settings[K]>) => void }): React.JSX.Element {
  const { settings, appInfo } = useApp()
  const sys = draft.system
  /** What the system reports for the start at login entry. Null means the app can't register one. */
  const openAtLogin = appInfo?.openAtLogin
  let loginNote: string | null = null
  if (openAtLogin === null) loginNote = 'This works only in the installed app.'
  else if (openAtLogin === false && settings?.system.startAtLogin) loginNote = 'Windows has JobQuery turned off for startup. Turn it on under Settings, Apps, Startup.'
  return (
    <Card id="settings-system">
      <CardHeader title="Running in the background" hint="For leaving JobQuery on all day, with autopilot doing the work." />
      <div className="space-y-4 p-4">
        <Toggle checked={sys.closeToTray} onChange={(v) => set('system', { closeToTray: v })} label="Run in the tray" hint="Closing the window leaves JobQuery running in the system tray. Quit it from the tray menu." />
        <div>
          <Toggle checked={sys.startAtLogin} onChange={(v) => set('system', { startAtLogin: v })} label="Start at login" hint="Start JobQuery when you sign in to Windows. It opens in the tray." />
          {loginNote && <p className="mt-1 text-xs text-warn">{loginNote}</p>}
        </div>
        <Toggle checked={sys.keepAwake} onChange={(v) => set('system', { keepAwake: v })} label="Keep the PC awake" hint="Keep this PC from sleeping while a run is going or autopilot is on. Closing a laptop lid can still put it to sleep." />
        <Toggle checked={sys.notifications} onChange={(v) => set('system', { notifications: v })} label="Notifications" hint="Show a Windows notification when JobQuery needs you, such as a sign-in, a captcha or a reached budget." />
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/** One sentence saying where updates stand, for the Updates card. */
function updateLine(u: UpdateStatus): string {
  switch (u.state) {
    case 'disabled':
      return u.message ?? "This copy of JobQuery can't update itself."
    case 'idle':
      return "JobQuery hasn't checked for updates yet."
    case 'checking':
      return 'Checking for updates.'
    case 'up_to_date':
      return u.checkedAt ? `JobQuery is up to date. Last checked ${relativeTime(u.checkedAt)}.` : 'JobQuery is up to date.'
    case 'downloading':
      return `Downloading version ${u.version ?? 'the update'}.${u.percent === null ? '' : ` ${Math.round(u.percent)}% done.`}`
    case 'ready':
      return `Version ${u.version ?? 'the update'} is ready. It installs the next time JobQuery closes, or you can restart now.`
    case 'available':
      return `Version ${u.version ?? 'the update'} is available. This computer can't install it for you, so download it and run the installer.`
    case 'error':
      return u.message ?? "JobQuery couldn't check for updates."
  }
}

function UpdatesCard({ draft, set }: { draft: Settings; set: <K extends SectionKey>(key: K, patch: Partial<Settings[K]>) => void }): React.JSX.Element {
  const toast = useToast()
  const { updateStatus: u, checkForUpdates } = useApp()
  const [restarting, setRestarting] = useState(false)
  const canCheck = !!u && u.state !== 'disabled' && u.state !== 'checking' && u.state !== 'downloading'

  return (
    <Card id="settings-updates">
      <CardHeader title="Updates" hint="To look for a new version, JobQuery asks GitHub whether one exists. GitHub sees your IP address and the version you run, as it does for any download. Updates keep your data." />
      <div className="space-y-4 p-4">
        {!u ? (
          <Loading />
        ) : (
          <>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-muted">Version</dt>
              <dd className="text-fg">{u.currentVersion}</dd>
              <dt className="text-muted">Status</dt>
              <dd className="flex items-start gap-2 text-fg" aria-live="polite">
                {u.state === 'checking' || u.state === 'downloading' ? (
                  <Loader2 size={15} className="mt-0.5 shrink-0 text-muted motion-safe:animate-spin" />
                ) : u.state === 'up_to_date' ? (
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-good" />
                ) : u.state === 'error' ? (
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
                ) : null}
                <span>{updateLine(u)}</span>
              </dd>
            </dl>
            {u.state === 'downloading' && u.percent !== null && (
              <div className="max-w-sm">
                <ProgressBar value={u.percent / 100} />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={<RefreshCw size={13} />} loading={u.state === 'checking'} disabled={!canCheck} onClick={() => void checkForUpdates()}>
                Check for updates
              </Button>
              {u.state === 'ready' && (
                <Button variant="primary" onClick={() => setRestarting(true)}>
                  Restart to update
                </Button>
              )}
              {u.downloadUrl && (
                <Button icon={<Download size={13} />} onClick={() => void api.openExternal(u.downloadUrl as string).catch(toast.error)}>
                  {u.state === 'available' && u.version ? `Download version ${u.version}` : 'Open the download page'}
                </Button>
              )}
            </div>
          </>
        )}
        <Toggle checked={draft.updates.autoCheck} onChange={(v) => set('updates', { autoCheck: v })} label="Check for updates automatically" hint="JobQuery checks a few seconds after it opens and then every few hours. Checking by hand works either way." />
      </div>
      {restarting && <RestartToUpdateDialog onClose={() => setRestarting(false)} />}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Theme and data
// ---------------------------------------------------------------------------

function DataCard(): React.JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const info = useAsync<AppInfo>(() => api.getAppInfo(), [])
  const [theme, setTheme] = useState<Theme>(getStoredTheme())
  const [busy, setBusy] = useState(false)
  const [copying, setCopying] = useState(false)

  async function exportData(): Promise<void> {
    setBusy(true)
    try {
      const path = await api.exportData()
      if (path) toast.success(`Exported to ${path}`)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  async function exportDatabase(): Promise<void> {
    setCopying(true)
    try {
      const path = await api.exportDatabase()
      if (path) toast.success(`Database copy saved to ${path}`)
    } catch (e) {
      toast.error(e)
    } finally {
      setCopying(false)
    }
  }

  return (
    <Card id="settings-data">
      <CardHeader title="Theme and data" />
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-fg">Export your data</p>
            <p className="text-xs text-faint">Saves a JSON file with your jobs, applications and settings. API keys are not included.</p>
          </div>
          <Button icon={<Download size={14} />} loading={busy} onClick={() => void exportData()}>
            Export data
          </Button>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-fg">Save a copy of the database</p>
            <p className="text-xs text-faint">Saves a full copy you can keep as a backup, even while JobQuery runs. Stored API keys and job board logins are removed from the copy.</p>
          </div>
          <Button icon={<Download size={14} />} loading={copying} onClick={() => void exportDatabase()}>
            Save copy
          </Button>
        </div>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-fg">Theme</p>
          <Segmented
            value={theme}
            onChange={(t) => {
              setTheme(t)
              applyTheme(t)
            }}
            items={[
              { id: 'dark', label: 'Dark' },
              { id: 'light', label: 'Light' }
            ]}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-fg">Setup guide</p>
            <p className="text-xs text-faint">Walk through the first-time setup again. Nothing you saved is erased.</p>
          </div>
          <Button
            onClick={() => {
              setOnboardingSkipped(false)
              navigate('/onboarding')
            }}
          >
            Open setup guide
          </Button>
        </div>
        <div className="border-t border-line pt-4">
          {info.data ? (
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-muted">Platform</dt>
              <dd className="text-fg">{info.data.platform}</dd>
              <dt className="text-muted">Data folder</dt>
              <dd className="flex items-center gap-2 text-fg">
                <span className="truncate font-mono text-xs">{info.data.dataDir}</span>
                <IconButton label="Open data folder" onClick={() => void api.openPath(info.data?.dataDir as string).catch(toast.error)}>
                  <FolderOpen size={14} />
                </IconButton>
              </dd>
              {isDemo && (
                <>
                  <dt className="text-muted">Mode</dt>
                  <dd className="text-warn">Demo data. Changes are kept in memory only.</dd>
                </>
              )}
            </dl>
          ) : (
            <Loading />
          )}
        </div>
        <div className="border-t border-line pt-4">
          <h3 className="text-sm font-medium text-fg">About</h3>
          <p className="mt-1 text-xs text-faint">JobQuery is provided as is, without warranty. You&apos;re responsible for charges from your AI providers, for everything sent to employers in your name, and for following the terms of the job sites and AI providers you use.</p>
        </div>
      </div>
    </Card>
  )
}
