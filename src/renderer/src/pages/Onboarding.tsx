import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, ArrowRight, Check, Rocket, Wand2 } from 'lucide-react'
import { clsx } from 'clsx'
import { EMPTY_PROFILE, PROVIDER_LABELS, PROVIDER_PRESETS, type ProviderPreset } from '@shared/defaults'
import type { JobPreferences, LlmStage, ModelRef, Profile, ProviderInfo, RemotePreference, Seniority } from '@shared/types'
import { api, isDemo } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { suggestedModel } from '@renderer/lib/providers'
import { setOnboardingSkipped } from '@renderer/lib/theme'
import { ProviderBillingBadge } from '@renderer/components/badges'
import { DocumentSection } from '@renderer/components/DocumentSection'
import { ModelPicker } from '@renderer/components/ModelPicker'
import { ProfileEditor, cleanProfile } from '@renderer/components/ProfileEditor'
import { ProviderForm } from '@renderer/components/ProviderForm'
import { VoiceCard } from '@renderer/components/VoiceCard'
import { Companies, Searches } from './Sources'
import { Badge, Button, Card, Checkbox, Chip, ErrorBlock, Field, Loading, Notice, NumberInput, Select, TagInput, Textarea } from '@renderer/components/ui'

const STEPS = ['AI provider', 'Models', 'Resume', 'Your profile', 'Your writing', 'Job preferences', 'Sources', 'Finish'] as const

const STAGES: Array<{ id: LlmStage; label: string; hint: string }> = [
  { id: 'triage', label: 'Scoring fit', hint: 'Runs on every job that passes the free filters. A cheap, fast model is enough.' },
  { id: 'writing', label: 'Writing', hint: 'Cover letters and open-ended answers. Use your strongest model.' },
  { id: 'extraction', label: 'Reading', hint: 'Resume parsing, form mapping and voice analysis.' }
]

const SENIORITY: Seniority[] = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'executive']
const REMOTE: Array<{ id: RemotePreference; label: string }> = [
  { id: 'remote', label: 'Remote' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'onsite', label: 'On site' }
]

export function Onboarding(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const { settings, updateSettings } = useApp()
  const [step, setStep] = useState(0)
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE)
  const [routing, setRouting] = useState<Record<LlmStage, ModelRef | null>>({ triage: null, writing: null, extraction: null })
  const [prefs, setPrefs] = useState<JobPreferences | null>(null)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [samples, setSamples] = useState({ writing: 0, letters: 0 })
  const [presetByProvider, setPresetByProvider] = useState<Record<string, ProviderPreset | undefined>>({})

  const providers = useAsync(() => api.listProviders(), [])
  const stored = useAsync(() => api.getProfile(), [])

  useEffect(() => {
    if (settings) {
      setRouting((cur) => (cur.triage || cur.writing || cur.extraction ? cur : settings.routing))
      setPrefs((cur) => cur ?? settings.preferences)
    }
  }, [settings])

  useEffect(() => {
    if (stored.data && stored.data.version > 0) setProfile(stored.data.profile)
  }, [stored.data])

  // Prefill each stage with the preset's models for the first provider, or the kind's suggestions.
  useEffect(() => {
    const first = providers.data?.[0]
    if (!first) return
    const presetModels = presetByProvider[first.id]?.models
    setRouting((cur) => {
      const next = { ...cur }
      for (const s of STAGES) {
        if (!next[s.id]) next[s.id] = { providerId: first.id, model: presetModels?.[s.id] ?? suggestedModel(first, s.id) ?? '' }
      }
      return next
    })
  }, [providers.data, presetByProvider])

  const list: ProviderInfo[] = providers.data ?? []
  const last = step === STEPS.length - 1

  async function guard(fn: () => Promise<void>): Promise<boolean> {
    setBusy(true)
    try {
      await fn()
      return true
    } catch (e) {
      toast.error(e)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function next(): Promise<void> {
    if (step === 1) {
      if (!(await guard(async () => void (await updateSettings({ routing })))))
        return
    } else if (step === 3 || step === 4) {
      if (!(await guard(async () => void (await api.saveProfile(cleanProfile(profile)))))) return
    } else if (step === 5 && prefs) {
      if (!(await guard(async () => void (await updateSettings({ preferences: prefs }))))) return
    }
    setStep(step + 1)
  }

  async function finish(): Promise<void> {
    if (await guard(async () => void (await updateSettings({ onboardingDone: true })))) {
      setOnboardingSkipped(false)
      toast.success('Setup is done. Press Run now to look for jobs.')
      navigate('/')
    }
  }

  async function readResume(): Promise<void> {
    if (!resumeId) return
    setReading(true)
    try {
      const draft = await api.extractProfileFromResume(resumeId)
      setProfile(draft)
      toast.success('Read your resume. Check the draft before you save it.')
      setStep(3)
    } catch (e) {
      toast.error(e)
    } finally {
      setReading(false)
    }
  }

  function skip(): void {
    setOnboardingSkipped(true)
    navigate('/')
  }

  const canNext = step === 0 ? list.length > 0 : step === 1 ? STAGES.every((s) => routing[s.id]?.model) : step === 3 ? profile.fullName.trim().length > 0 : true

  return (
    <div className="flex h-full bg-bg">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface p-5">
        <div className="mb-8 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-fg">
            <Rocket size={15} />
          </div>
          <span className="text-sm font-semibold text-fg">JobPilot setup</span>
        </div>
        <ol className="flex-1 space-y-1">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                onClick={() => i <= step && setStep(i)}
                disabled={i > step}
                aria-current={i === step ? 'step' : undefined}
                className={clsx('flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-sm', i === step ? 'bg-hover text-fg' : i < step ? 'text-muted hover:bg-hover/60' : 'text-faint')}
              >
                <span className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium', i < step ? 'bg-good text-accent-fg' : i === step ? 'bg-accent text-accent-fg' : 'bg-line text-faint')}>{i < step ? <Check size={11} /> : i + 1}</span>
                {label}
              </button>
            </li>
          ))}
        </ol>
        <Button variant="ghost" onClick={skip}>
          Skip for now
        </Button>
        <p className="mt-2 text-xs text-faint">You can come back from the sidebar at any time.</p>
        {isDemo && (
          <Badge tone="warn" className="mt-3 self-start">
            Demo data
          </Badge>
        )}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">
            Step {step + 1} of {STEPS.length}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">{STEPS[step]}</h1>

          <div className="mt-5 space-y-4">
            {step === 0 && (
              <>
                <p className="text-sm text-muted">JobPilot uses your own AI key. Choose a free option or a paid one, whichever suits you. You can add both and change this later in Settings.</p>
                <Notice tone="info" title="A ChatGPT or Claude subscription is not an API key">
                  Those subscriptions don't include API use, so JobPilot can't use them. If you don't have a card, start with a free option.
                </Notice>
                {list.length > 0 && (
                  <Card>
                    <ul className="divide-y divide-line">
                      {list.map((p) => (
                        <li key={p.id} className="flex items-center justify-between px-4 py-2.5">
                          <div>
                            <p className="text-sm text-fg">{p.label}</p>
                            <p className="text-xs text-faint">{PROVIDER_LABELS[p.kind]}</p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <ProviderBillingBadge provider={p} />
                            <Badge tone="good">{p.hasKey ? 'Key saved' : 'Ready'}</Badge>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                <Card className="p-4">
                  <h2 className="mb-3 text-sm font-medium text-fg">{list.length > 0 ? 'Add another provider' : 'Add a provider'}</h2>
                  <ProviderForm
                    key={list.length}
                    onSaved={(saved, _tested, presetId) => {
                      const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)
                      if (preset) setPresetByProvider((cur) => ({ ...cur, [saved.id]: preset }))
                      providers.reload()
                    }}
                  />
                </Card>
              </>
            )}

            {step === 1 && (
              <>
                <p className="text-sm text-muted">Each stage can use a different model. The lists come straight from your provider, and the suggestions are a starting point.</p>
                {list.length === 0 ? (
                  <ErrorBlock message="Add a provider in the first step." />
                ) : (
                  <Card className="space-y-4 p-4">
                    {STAGES.map((s) => (
                      <Field key={s.id} label={s.label} hint={s.hint}>
                        <ModelPicker
                          providers={list}
                          value={routing[s.id]}
                          onChange={(ref) => setRouting({ ...routing, [s.id]: ref })}
                          suggested={(provider) => suggestedModel(provider, s.id)}
                        />
                      </Field>
                    ))}
                  </Card>
                )}
              </>
            )}

            {step === 2 && (
              <>
                <p className="text-sm text-muted">Upload your resume as a PDF or Word file. JobPilot reads it to draft your profile, and you check every field before anything is saved.</p>
                <DocumentSection kind="resume" title="Resume" emptyText="No resume yet. Press Upload to choose a file." onChange={(docs) => setResumeId(docs.find((d) => d.isPrimary)?.id ?? docs[0]?.id ?? null)} />
                <div className="flex items-center gap-3">
                  <Button variant="primary" icon={<Wand2 size={14} />} loading={reading} disabled={!resumeId} onClick={() => void readResume()}>
                    Read my resume
                  </Button>
                  <span className="text-xs text-faint">{resumeId ? 'Uses your extraction model. This costs a few cents at most.' : 'Upload a resume first, or skip this step and fill in your profile by hand.'}</span>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <Notice>This is a draft. Fix anything that is wrong, because JobPilot copies these details into application forms.</Notice>
                <ProfileEditor value={profile} onChange={setProfile} />
              </>
            )}

            {step === 4 && (
              <>
                <p className="text-sm text-muted">This step is optional, and it helps the most with how your letters sound. A few things you wrote yourself teach JobPilot your voice.</p>
                <DocumentSection kind="writing_sample" title="Writing samples" allowPaste emptyText="Emails, posts or notes in your own words." onChange={(d) => setSamples((s) => ({ ...s, writing: d.length }))} />
                <DocumentSection kind="cover_letter_sample" title="Sample cover letter" emptyText="A past cover letter you were happy with." onChange={(d) => setSamples((s) => ({ ...s, letters: d.length }))} />
                <DocumentSection kind="portfolio" title="Portfolio links" allowLink emptyText="Links to your portfolio, GitHub or published work." />
                <Card className="p-4">
                  <Field label="Notes for the AI" hint="Things to stress, things never to mention, anything it should know.">
                    <Textarea rows={4} value={profile.notesForAi} onChange={(e) => setProfile({ ...profile, notesForAi: e.target.value })} />
                  </Field>
                </Card>
                <VoiceCard voice={profile.voice} sampleCount={samples.writing + samples.letters} onBuilt={(voice) => setProfile({ ...profile, voice })} />
              </>
            )}

            {step === 5 && prefs && <PreferencesStep prefs={prefs} onChange={setPrefs} />}

            {step === 6 && (
              <>
                <p className="text-sm text-muted">Add companies you would like to work for, and job sites to search. You can add more later.</p>
                <Companies />
                <Searches />
              </>
            )}

            {step === 7 && (
              <Card className="space-y-3 p-5">
                <p className="text-sm text-fg">Setup is done. This is what JobPilot does from now on.</p>
                <ul className="list-inside list-disc space-y-1.5 text-sm text-muted">
                  <li>Press Run now. JobPilot looks at your sources and drops what does not fit, using free filters first.</li>
                  <li>Jobs that pass get an AI fit score. The good ones land on your shortlist.</li>
                  <li>Prepare an application and it appears in the review queue. You check it and click Submit.</li>
                  <li>Autopilot is off until you turn it on in Settings.</li>
                </ul>
              </Card>
            )}
          </div>

          <div className="mt-8 flex items-center justify-between border-t border-line pt-4">
            <Button variant="ghost" icon={<ArrowLeft size={14} />} disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>
              Back
            </Button>
            <div className="flex items-center gap-2">
              {(step === 2 || step === 4 || step === 6) && (
                <Button variant="ghost" onClick={() => setStep(step + 1)}>
                  Skip this step
                </Button>
              )}
              {last ? (
                <Button variant="primary" loading={busy} onClick={() => void finish()} icon={<Check size={14} />}>
                  Finish setup
                </Button>
              ) : (
                <Button variant="primary" loading={busy} disabled={!canNext} onClick={() => void next()} icon={<ArrowRight size={14} />}>
                  Continue
                </Button>
              )}
            </div>
          </div>
          {providers.loading && step === 0 && !providers.data && <Loading />}
        </div>
      </main>
    </div>
  )
}

function PreferencesStep({ prefs, onChange }: { prefs: JobPreferences; onChange: (p: JobPreferences) => void }): React.JSX.Element {
  const set = (patch: Partial<JobPreferences>): void => onChange({ ...prefs, ...patch })
  return (
    <Card className="space-y-4 p-4">
      <Field label="Job titles you want" hint="Press Enter after each title.">
        <TagInput value={prefs.targetTitles} onChange={(v) => set({ targetTitles: v })} placeholder="Senior Frontend Engineer" />
      </Field>
      <Field label="Places you can work from" hint="Leave empty for anywhere.">
        <TagInput value={prefs.locations} onChange={(v) => set({ locations: v })} placeholder="Berlin" />
      </Field>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="text-xs font-medium text-muted">Work style</span>
        {REMOTE.map((r) => (
          <Checkbox key={r.id} label={r.label} checked={prefs.remote.includes(r.id)} onChange={(on) => set({ remote: on ? [...prefs.remote, r.id] : prefs.remote.filter((x) => x !== r.id) })} />
        ))}
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Seniority</p>
        <div className="flex flex-wrap gap-1.5">
          {SENIORITY.map((s) => (
            <Chip key={s} selected={prefs.seniority.includes(s)} onClick={() => set({ seniority: prefs.seniority.includes(s) ? prefs.seniority.filter((x) => x !== s) : [...prefs.seniority, s] })}>
              {s}
            </Chip>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Minimum yearly pay" hint="Jobs that list a maximum below this are dropped before any AI call.">
          <NumberInput value={prefs.minSalary} min={0} step={1000} placeholder="No minimum" onChange={(v) => set({ minSalary: v })} />
        </Field>
        <Field label="Currency">
          <Select value={prefs.salaryCurrency} onChange={(e) => set({ salaryCurrency: e.target.value })}>
            {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Words that rule a job out" hint="A job with one of these in the title is dropped for free.">
        <TagInput value={prefs.excludeTitleKeywords} onChange={(v) => set({ excludeTitleKeywords: v })} placeholder="intern" />
      </Field>
      <Field label="Companies to never show">
        <TagInput value={prefs.excludedCompanies} onChange={(v) => set({ excludedCompanies: v })} placeholder="Company name" />
      </Field>
    </Card>
  )
}
