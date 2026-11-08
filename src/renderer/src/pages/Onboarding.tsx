import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, ArrowRight, Check, Gauge, Rocket, Wand2 } from 'lucide-react'
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
import { PresetDialog } from '@renderer/components/PresetDialog'
import { ApplyingEditor, QuestionFormsEditor } from '@renderer/components/ApplicationFactsEditor'
import { STANCE_SLOTS, TEMPLATE_SLOTS } from '@renderer/components/answerSlots'
import { ProfileEditor, cleanProfile } from '@renderer/components/ProfileEditor'
import { AnswerSlots, useSlotDrafts } from '@renderer/components/SavedAnswerSlots'
import { ProviderForm } from '@renderer/components/ProviderForm'
import { VoiceCard } from '@renderer/components/VoiceCard'
import { Companies, Searches } from './Sources'
import { Badge, Button, Card, Checkbox, Chip, ErrorBlock, Field, Loading, Notice, NumberInput, Select, TagInput, Textarea } from '@renderer/components/ui'

const STEPS = ['AI provider', 'Models', 'Resume', 'Your profile', 'Applying', 'Questions forms ask', 'Your stances', 'Answers in your words', 'Your writing', 'Job preferences', 'Sources', 'Finish'] as const

/** Steps with nothing required, so each has a Skip button. */
const OPTIONAL: ReadonlyArray<(typeof STEPS)[number]> = ['Resume', 'Applying', 'Questions forms ask', 'Your stances', 'Answers in your words', 'Your writing', 'Sources']

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
  const [presetOpen, setPresetOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [samples, setSamples] = useState({ writing: 0, letters: 0 })
  const [presetByProvider, setPresetByProvider] = useState<Record<string, ProviderPreset | undefined>>({})

  const slots = useSlotDrafts([...STANCE_SLOTS, ...TEMPLATE_SLOTS])
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
  const current = STEPS[step]

  // "How you hear about jobs" starts as a job board, which is true for most people.
  useEffect(() => {
    if (current === 'Questions forms ask') setProfile((p) => (p.application.heardAbout.trim() ? p : { ...p, application: { ...p.application, heardAbout: 'Job board' } }))
  }, [current])

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
    if (current === 'Models') {
      if (!(await guard(async () => void (await updateSettings({ routing })))))
        return
    } else if (current === 'Your profile' || current === 'Applying' || current === 'Questions forms ask' || current === 'Your writing') {
      if (!(await guard(async () => void (await api.saveProfile(cleanProfile(profile)))))) return
    } else if (current === 'Your stances' || current === 'Answers in your words') {
      if (!(await guard(slots.save))) return
    } else if (current === 'Job preferences' && prefs) {
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
      setStep(STEPS.indexOf('Your profile'))
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

  const canNext = current === 'AI provider' ? list.length > 0 : current === 'Models' ? STAGES.every((s) => routing[s.id]?.model) : current === 'Your profile' ? profile.fullName.trim().length > 0 : true

  return (
    <div className="flex h-full bg-bg">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface p-5">
        <div className="mb-8 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-fg">
            <Rocket size={15} />
          </div>
          <span className="text-sm font-semibold text-fg">jobpls setup</span>
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
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">{current}</h1>

          <div className="mt-5 space-y-4">
            {current === 'AI provider' && (
              <>
                <p className="text-sm text-muted">jobpls uses your own AI key. Choose a free option or a paid one, whichever suits you. You can add both and change this later in Settings.</p>
                <Notice tone="info" title="A ChatGPT or Claude subscription is not an API key">
                  Those subscriptions don't include API use, so jobpls can't use them. If you don't have a card, start with a free option.
                </Notice>
                <Notice tone="info" title="Your provider bills you directly">
                  Free tiers cost nothing while billing is off for the key. Paid providers charge you for each call. jobpls's cost figures are estimates, and jobpls isn't responsible for charges from your provider.
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
                {providers.loading && !providers.data && <Loading />}
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

            {current === 'Models' && (
              <>
                <p className="text-sm text-muted">Each stage can use a different model. The lists come straight from your provider, and the suggestions are a starting point.</p>
                {list.length === 0 ? (
                  <ErrorBlock message="Add a provider in the first step." />
                ) : (
                  <Card className="space-y-4 p-4">
                    {STAGES.map((s) => (
                      <Field key={s.id} label={s.label} hint={s.hint}>
                        <ModelPicker
                          label={s.label}
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

            {current === 'Resume' && (
              <>
                <p className="text-sm text-muted">Upload your resume as a PDF or Word file. jobpls reads it to draft your profile, and you check every field before anything is saved.</p>
                <DocumentSection kind="resume" title="Resume" emptyText="No resume yet. Press Upload to choose a file." onChange={(docs) => setResumeId(docs.find((d) => d.isPrimary)?.id ?? docs[0]?.id ?? null)} />
                <div className="flex items-center gap-3">
                  <Button variant="primary" icon={<Wand2 size={14} />} loading={reading} disabled={!resumeId} onClick={() => void readResume()}>
                    Read my resume
                  </Button>
                  <span className="text-xs text-faint">{resumeId ? 'Uses your Reading model. On a paid provider this usually costs a few cents.' : 'Upload a resume first, or skip this step and fill in your profile by hand.'}</span>
                </div>
              </>
            )}

            {current === 'Your profile' && (
              <>
                <Notice>This is a draft. Fix anything that is wrong, because jobpls copies these details into application forms.</Notice>
                <ProfileEditor value={profile} onChange={setProfile} />
              </>
            )}

            {current === 'Applying' && (
              <>
                <p className="text-sm text-muted">Application forms ask for the same details again and again. Answer them once and jobpls fills them in, so fewer applications wait for you.</p>
                <ApplyingEditor
                  facts={profile.application}
                  onChange={(application) => setProfile({ ...profile, application })}
                  defaultCurrency={settings?.preferences.salaryCurrency}
                  authorizedCountries={profile.workAuthorization.authorizedCountries}
                />
              </>
            )}

            {current === 'Questions forms ask' && (
              <>
                <p className="text-sm text-muted">These come up less often, but they stop an application when jobpls cannot answer them. Leave anything you would rather answer yourself.</p>
                <QuestionFormsEditor facts={profile.application} onChange={(application) => setProfile({ ...profile, application })} skills={profile.skills} languages={profile.languages} />
              </>
            )}

            {current === 'Your stances' && (
              <>
                <p className="text-sm text-muted">Two kinds of question are always yours to answer. Write your answer in your own words and jobpls reuses it word for word. It never writes these for you.</p>
                <AnswerSlots slots={STANCE_SLOTS} drafts={slots.drafts} onChange={slots.setDrafts} />
                <Notice tone="info" title="When autopilot sends these">
                  Autopilot sends a form with these questions only when &quot;Send my saved answers to questions only I answer&quot; is on in Settings. Required privacy and truthfulness boxes follow a second toggle called &quot;Tick required privacy and truthfulness boxes&quot;. Both are off until you turn them on.
                </Notice>
              </>
            )}

            {current === 'Answers in your words' && (
              <>
                <p className="text-sm text-muted">jobpls adapts these to each company and keeps your facts and wording. Fill in as many as you like.</p>
                <AnswerSlots slots={TEMPLATE_SLOTS} drafts={slots.drafts} onChange={slots.setDrafts} />
              </>
            )}

            {current === 'Your writing' && (
              <>
                <p className="text-sm text-muted">This step is optional, and it helps the most with how your letters sound. A few things you wrote yourself teach jobpls your voice.</p>
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

            {current === 'Job preferences' && prefs && <PreferencesStep prefs={prefs} onChange={setPrefs} />}

            {current === 'Sources' && (
              <>
                <p className="text-sm text-muted">Add companies you would like to work for, and job sites to search. You can add more later.</p>
                <Companies />
                <Searches />
              </>
            )}

            {current === 'Finish' && (
              <Card className="space-y-3 p-5">
                <p className="text-sm text-fg">Setup is done. This is what jobpls does from now on.</p>
                <ul className="list-inside list-disc space-y-1.5 text-sm text-muted">
                  <li>Press Run now. jobpls looks at your sources and drops what does not fit, using free filters first.</li>
                  <li>Jobs that pass get an AI fit score. The good ones land on your shortlist.</li>
                  <li>Prepare an application and it appears in the review queue. You check it and click Submit.</li>
                  <li>Autopilot is off until you turn it on in Settings.</li>
                </ul>
                <div className="flex items-start justify-between gap-4 rounded-lg border border-line p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">Applying to many jobs a day?</p>
                    <p className="mt-0.5 text-sm text-muted">One click sets lower score lines, larger daily limits and continuous autopilot. Auto-submit starts in dry run, so forms are filled and never sent until you turn dry run off.</p>
                  </div>
                  <Button icon={<Gauge size={14} />} disabled={!settings} onClick={() => setPresetOpen(true)}>
                    Set up for volume
                  </Button>
                </div>
              </Card>
            )}
          </div>

          {presetOpen && settings && <PresetDialog current={settings} onClose={() => setPresetOpen(false)} />}

          <div className="mt-8 flex items-center justify-between border-t border-line pt-4">
            <Button variant="ghost" icon={<ArrowLeft size={14} />} disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>
              Back
            </Button>
            <div className="flex items-center gap-2">
              {OPTIONAL.includes(current) && (
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
            <Chip key={s} className="capitalize" selected={prefs.seniority.includes(s)} onClick={() => set({ seniority: prefs.seniority.includes(s) ? prefs.seniority.filter((x) => x !== s) : [...prefs.seniority, s] })}>
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
