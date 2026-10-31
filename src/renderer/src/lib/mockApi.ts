// In-memory implementation of the Api for demo mode. Used only when window.bridge is missing,
// which happens when the renderer is opened in a normal browser through the Vite dev server.

import type { Api, AppInfo, DeepPartial, ProviderTestResult, PushChannel, PushEvents, Bridge } from '@shared/api'
import type {
  AnswerBankEntry,
  Application,
  ApplicationSummary,
  AtsDetection,
  Company,
  DocumentRecord,
  EventRecord,
  FitAssessment,
  Job,
  JobSummary,
  LintIssue,
  LintReport,
  PipelineProgress,
  PreparedAnswer,
  ProfileRecord,
  ProviderInfo,
  RunStats,
  SavedSearch,
  Settings,
  UsageSummary
} from '@shared/types'
import {
  MODEL_LISTS,
  buildAnalytics,
  demoProfile,
  emptyLint,
  initialApplications,
  initialBank,
  initialCompanies,
  initialDocuments,
  initialEvents,
  initialJobs,
  initialProviders,
  initialRuns,
  initialSearches,
  initialSettings,
  initialSuggestions,
  iso,
  makeAnswers,
  makeFit
} from './mockData'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let counter = 1000
const uid = (prefix: string): string => `${prefix}_${++counter}`

function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = merge(out[k], v)
  return out as T
}

const BANNED = ['thrilled', 'passionate', 'leverage', 'leveraging', 'delve', 'seamless', 'cutting-edge', 'robust', 'testament', 'journey', 'fast-paced', 'unlock', 'synergy', 'excited to']

export function lintDemo(text: string): LintReport {
  const issues: LintIssue[] = []
  const lower = text.toLowerCase()
  for (const phrase of BANNED) {
    let from = 0
    for (;;) {
      const i = lower.indexOf(phrase, from)
      if (i < 0) break
      issues.push({ rule: 'banned-phrase', severity: 'high', message: `"${phrase}" is a common AI giveaway.`, match: text.slice(i, i + phrase.length), index: i, suggestion: 'Say the plain thing instead.' })
      from = i + phrase.length
    }
  }
  for (const m of text.matchAll(/—/g)) issues.push({ rule: 'em-dash', severity: 'medium', message: 'Em dash used as a pause.', match: '—', index: m.index ?? null, suggestion: 'Use a period or a comma.' })
  for (const m of text.matchAll(/!/g)) issues.push({ rule: 'exclamation', severity: 'medium', message: 'Exclamation mark.', match: '!', index: m.index ?? null, suggestion: null })
  for (const m of text.matchAll(/\bnot just [^.,]+, but [^.]+/gi)) issues.push({ rule: 'not-x-but-y', severity: 'medium', message: 'The "not just X, but Y" pattern.', match: m[0], index: m.index ?? null, suggestion: 'State the one thing you are.' })
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim())
  const lengths = sentences.map((s) => s.trim().split(/\s+/).length)
  const words = lengths.reduce((a, b) => a + b, 0)
  const avg = lengths.length ? words / lengths.length : 0
  const sd = lengths.length ? Math.sqrt(lengths.reduce((a, l) => a + (l - avg) ** 2, 0) / lengths.length) : 0
  if (lengths.length >= 4 && sd < 3) issues.push({ rule: 'sentence-length', severity: 'low', message: 'Sentences are all about the same length.', match: null, index: null, suggestion: 'Mix in a short one.' })
  const penalty = issues.reduce((a, i) => a + (i.severity === 'high' ? 12 : i.severity === 'medium' ? 6 : 3), 0)
  return {
    score: text.trim() ? Math.max(0, 100 - penalty) : 100,
    issues,
    stats: { words, sentences: sentences.length, avgSentenceWords: Math.round(avg * 10) / 10, sentenceLengthStdDev: Math.round(sd * 10) / 10, paragraphs: text.split(/\n\s*\n/).filter((p) => p.trim()).length }
  }
}

function toJobSummary(j: Job): JobSummary {
  const { externalId: _a, applyUrl: _b, description: _c, employmentType: _d, fit: _e, dismissReason: _f, dismissTags: _g, dupOf: _h, updatedAt: _i, ...rest } = j
  return rest
}

function toAppSummary(a: Application): ApplicationSummary {
  const { coverLetter: _a, coverLetterLint: _b, answers: _c, formFields: _d, resumeDocId: _e, confirmation: _f, screenshotPath: _g, error: _h, notes: _i, ...rest } = a
  return rest
}

export function createMockBridge(): Bridge {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
  const startOnboarding = params.has('onboarding')

  let settings: Settings = initialSettings(!startOnboarding)
  let providers: ProviderInfo[] = startOnboarding ? [] : initialProviders()
  let profile: ProfileRecord = startOnboarding
    ? { profile: merge(demoProfile(), { fullName: '', email: '', phone: '', location: '', headline: '', summary: '', experience: [], education: [], skills: [], facts: [], voice: null, links: { linkedin: '', github: '', portfolio: '', website: '', other: [] } }), version: 0, updatedAt: null }
    : { profile: demoProfile(), version: 3, updatedAt: iso(2 * 86_400_000) }
  let documents = startOnboarding ? [] : initialDocuments()
  let bank: AnswerBankEntry[] = startOnboarding ? [] : initialBank()
  let companies: Company[] = startOnboarding ? [] : initialCompanies()
  let searches: SavedSearch[] = startOnboarding ? [] : initialSearches()
  const jobs: Job[] = startOnboarding ? [] : initialJobs()
  const applications: Application[] = startOnboarding ? [] : initialApplications(jobs)
  const events: EventRecord[] = startOnboarding ? [] : initialEvents()
  let suggestions = startOnboarding ? [] : initialSuggestions()
  const runs = startOnboarding ? [] : initialRuns()
  let progress: PipelineProgress = { runId: null, phase: 'idle', message: 'Idle', done: 0, total: 0 }
  let cancelled = false
  let extraSpend = 0

  const listeners = new Map<PushChannel, Set<(p: never) => void>>()
  function emit<C extends PushChannel>(channel: C, payload: PushEvents[C]): void {
    listeners.get(channel)?.forEach((l) => (l as (p: PushEvents[C]) => void)(payload))
  }
  function addEvent(type: EventRecord['type'], jobId: string | null, message: string): void {
    const ev: EventRecord = { id: uid('ev'), at: iso(0), type, jobId, message, data: null }
    events.unshift(ev)
    emit('event:new', ev)
  }
  const jobById = (id: string): Job => {
    const j = jobs.find((x) => x.id === id)
    if (!j) throw new Error('That job no longer exists.')
    return j
  }
  const appById = (id: string): Application => {
    const a = applications.find((x) => x.id === id)
    if (!a) throw new Error('That application no longer exists.')
    return a
  }
  function touchApp(a: Application): void {
    a.flaggedCount = a.answers.filter((x) => x.needsUser).length
    a.updatedAt = iso(0)
    if (a.status === 'ready' && a.flaggedCount > 0) a.status = 'needs_attention'
    if (a.status === 'needs_attention' && a.flaggedCount === 0) a.status = 'ready'
    emit('applications:changed', { applicationIds: [a.id] })
  }
  function hashScore(id: string): number {
    let h = 0
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997
    return 45 + (h % 50)
  }
  function scoreInto(j: Job): void {
    const score = hashScore(j.id + j.title)
    const fit: FitAssessment = makeFit(
      score,
      score >= 60 ? 'Several of your skills line up with the posting. Details are in the matches below.' : 'The posting asks for skills that sit outside your profile.',
      ['React', 'TypeScript'],
      score >= 80 ? [] : ['Domain experience'],
      [],
      ['TypeScript']
    )
    j.fit = fit
    j.fitScore = fit.score
    j.fitBucket = fit.bucket
    j.fitSummary = fit.summary
    j.stage = score >= settings.thresholds.shortlistScore ? 'shortlisted' : 'scored'
    j.updatedAt = iso(0)
  }

  const usage = (): UsageSummary => {
    const a = buildAnalytics(30)
    const today = a.daily[a.daily.length - 1]
    return {
      todayUsd: Math.round((today.costUsd + extraSpend) * 1000) / 1000,
      monthUsd: Math.round((a.daily.reduce((s, d) => s + d.costUsd, 0) + extraSpend) * 1000) / 1000,
      todayTokens: today.tokens,
      monthTokens: a.daily.reduce((s, d) => s + d.tokens, 0),
      dailyBudgetUsd: settings.budget.dailyUsd,
      monthlyBudgetUsd: settings.budget.monthlyUsd,
      cacheHitsMonth: a.tokenSavings.cacheHits
    }
  }

  const api: Api = {
    async getAppInfo(): Promise<AppInfo> {
      return { version: '0.1.0 (demo)', dataDir: 'C:\\Users\\Demo\\AppData\\Roaming\\JobPilot', platform: 'win32' }
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener')
    },
    async openPath(path) {
      console.info('[demo] openPath', path)
    },
    async exportData() {
      return 'C:\\Users\\Demo\\Documents\\jobpilot-export.json'
    },

    async getSettings() {
      return structuredClone(settings)
    },
    async updateSettings(patch: DeepPartial<Settings>) {
      settings = merge(settings, patch)
      return structuredClone(settings)
    },
    async removePriceOverride(model: string) {
      const prices = { ...settings.prices }
      delete prices[model]
      settings = { ...settings, prices }
      return structuredClone(settings)
    },

    async listProviders() {
      return structuredClone(providers)
    },
    async saveProvider(input) {
      const existing = input.id ? providers.find((p) => p.id === input.id) : undefined
      const next: ProviderInfo = {
        id: existing?.id ?? uid('prov'),
        kind: input.kind,
        label: input.label,
        baseUrl: input.baseUrl ?? null,
        hasKey: input.apiKey ? true : (existing?.hasKey ?? false),
        createdAt: existing?.createdAt ?? iso(0)
      }
      providers = existing ? providers.map((p) => (p.id === next.id ? next : p)) : [...providers, next]
      return next
    },
    async deleteProvider(id) {
      providers = providers.filter((p) => p.id !== id)
    },
    async testProvider(id): Promise<ProviderTestResult> {
      await sleep(500)
      const p = providers.find((x) => x.id === id)
      if (!p) throw new Error('That provider no longer exists.')
      if (p.kind !== 'ollama' && p.kind !== 'openai_compatible' && !p.hasKey) return { ok: false, message: 'No API key saved for this provider.', models: [] }
      const models = MODEL_LISTS[p.kind] ?? []
      return { ok: true, message: `Connected. ${models.length} models available.`, models }
    },
    async listModels(providerId) {
      await sleep(200)
      const p = providers.find((x) => x.id === providerId)
      return p ? (MODEL_LISTS[p.kind] ?? []) : []
    },

    async getProfile() {
      return structuredClone(profile)
    },
    async saveProfile(p) {
      profile = { profile: structuredClone(p), version: profile.version + 1, updatedAt: iso(0) }
      return structuredClone(profile)
    },
    async pickFiles(options) {
      const ext = options.extensions?.[0] ?? 'pdf'
      return [`C:\\Users\\Demo\\Documents\\sample-file.${ext}`]
    },
    async importDocument(input) {
      await sleep(400)
      const name = input.name ?? (input.filePath ? (input.filePath.split(/[\\/]/).pop() as string) : (input.url ?? 'Pasted text'))
      const text = input.text ?? `Demo text extracted from ${name}.`
      const doc: DocumentRecord & { text: string } = {
        id: uid('doc'), kind: input.kind, name, filePath: input.filePath ?? null, mime: null, url: input.url ?? null,
        textPreview: text.slice(0, 240), textLength: text.length, isPrimary: input.kind === 'resume' && !documents.some((d) => d.kind === 'resume'), createdAt: iso(0), text
      }
      documents = [...documents, doc]
      const { text: _t, ...record } = doc
      return record
    },
    async listDocuments(kind) {
      return documents.filter((d) => !kind || d.kind === kind).map(({ text: _t, ...rest }) => rest)
    },
    async getDocumentText(id) {
      const d = documents.find((x) => x.id === id)
      if (!d) throw new Error('That document no longer exists.')
      return d.text
    },
    async deleteDocument(id) {
      documents = documents.filter((d) => d.id !== id)
    },
    async setPrimaryResume(id) {
      documents = documents.map((d) => (d.kind === 'resume' ? { ...d, isPrimary: d.id === id } : d))
    },
    async extractProfileFromResume() {
      await sleep(1400)
      return demoProfile()
    },
    async buildVoiceProfile() {
      await sleep(1200)
      profile = { ...profile, profile: { ...profile.profile, voice: demoProfile().voice }, version: profile.version + 1, updatedAt: iso(0) }
      return structuredClone(profile)
    },

    async listAnswers() {
      return structuredClone(bank)
    },
    async saveAnswer(entry) {
      const existing = entry.id ? bank.find((b) => b.id === entry.id) : undefined
      const next: AnswerBankEntry = { id: existing?.id ?? uid('ans'), question: entry.question, answer: entry.answer, kind: entry.kind, timesUsed: existing?.timesUsed ?? 0, updatedAt: iso(0) }
      bank = existing ? bank.map((b) => (b.id === next.id ? next : b)) : [...bank, next]
      return next
    },
    async deleteAnswer(id) {
      bank = bank.filter((b) => b.id !== id)
    },

    async listSearches() {
      return structuredClone(searches)
    },
    async saveSearch(s) {
      const existing = s.id ? searches.find((x) => x.id === s.id) : undefined
      const next: SavedSearch = { ...s, id: existing?.id ?? uid('ss'), lastRunAt: existing?.lastRunAt ?? null }
      searches = existing ? searches.map((x) => (x.id === next.id ? next : x)) : [...searches, next]
      return next
    },
    async deleteSearch(id) {
      searches = searches.filter((s) => s.id !== id)
    },
    async listCompanies() {
      return structuredClone(companies)
    },
    async saveCompany(input) {
      const existing = input.id ? companies.find((c) => c.id === input.id) : undefined
      const next: Company = {
        id: existing?.id ?? uid('co'),
        name: input.name ?? existing?.name ?? 'Unnamed company',
        ats: input.ats ?? existing?.ats ?? 'unknown',
        atsToken: input.atsToken ?? existing?.atsToken ?? null,
        careersUrl: input.careersUrl ?? existing?.careersUrl ?? null,
        watch: input.watch ?? existing?.watch ?? true,
        blocked: input.blocked ?? existing?.blocked ?? false,
        notes: input.notes ?? existing?.notes ?? '',
        createdAt: existing?.createdAt ?? iso(0)
      }
      companies = existing ? companies.map((c) => (c.id === next.id ? next : c)) : [...companies, next]
      return next
    },
    async deleteCompany(id) {
      companies = companies.filter((c) => c.id !== id)
    },
    async detectAts(url): Promise<AtsDetection | null> {
      await sleep(350)
      let u: URL
      try {
        u = new URL(url)
      } catch {
        return null
      }
      const parts = u.pathname.split('/').filter(Boolean)
      const titleCase = (s: string): string => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      if (/greenhouse\.io$/.test(u.hostname) && parts[0]) return { ats: 'greenhouse', token: parts[0], jobId: parts[2] ?? null, companyName: titleCase(parts[0]) }
      if (u.hostname === 'jobs.lever.co' && parts[0]) return { ats: 'lever', token: parts[0], jobId: parts[1] ?? null, companyName: titleCase(parts[0]) }
      if (u.hostname === 'jobs.ashbyhq.com' && parts[0]) return { ats: 'ashby', token: parts[0], jobId: parts[1] ?? null, companyName: titleCase(parts[0]) }
      if (/smartrecruiters\.com$/.test(u.hostname) && parts[0]) return { ats: 'smartrecruiters', token: parts[0], jobId: null, companyName: titleCase(parts[0]) }
      return { ats: 'unknown', token: null, jobId: null, companyName: titleCase(u.hostname.replace(/^(www|careers|jobs)\./, '').split('.')[0]) }
    },
    async addJobByUrl(url) {
      await sleep(700)
      let host = 'example'
      try {
        host = new URL(url).hostname.replace(/^(www|careers|jobs)\./, '').split('.')[0]
      } catch {
        throw new Error('That does not look like a web address.')
      }
      const job = initialJobs()[12]
      job.id = uid('job')
      job.company = host.charAt(0).toUpperCase() + host.slice(1)
      job.title = 'Software Engineer'
      job.url = url
      job.source = 'manual'
      job.stage = 'new'
      job.fit = null
      job.fitScore = null
      job.fitBucket = null
      job.fitSummary = null
      job.discoveredAt = iso(0)
      jobs.unshift(job)
      emit('jobs:changed', { jobIds: [job.id] })
      return structuredClone(job)
    },

    async listJobs(q) {
      let items = jobs.filter((j) => (!q.stages || q.stages.includes(j.stage)) && (!q.buckets || (j.fitBucket && q.buckets.includes(j.fitBucket))) && (!q.sources || q.sources.includes(j.source)))
      if (q.starredOnly) items = items.filter((j) => j.starred)
      if (q.search) {
        const s = q.search.toLowerCase()
        items = items.filter((j) => `${j.title} ${j.company} ${j.location ?? ''}`.toLowerCase().includes(s))
      }
      const sort = q.sort ?? 'score'
      items = [...items].sort((a, b) => {
        if (sort === 'newest') return b.discoveredAt.localeCompare(a.discoveredAt)
        if (sort === 'posted') return (b.postedAt ?? '').localeCompare(a.postedAt ?? '')
        if (sort === 'company') return a.company.localeCompare(b.company)
        return (b.fitScore ?? b.prescore ?? -1) - (a.fitScore ?? a.prescore ?? -1)
      })
      const total = items.length
      const off = q.offset ?? 0
      return { items: items.slice(off, off + (q.limit ?? 200)).map(toJobSummary), total }
    },
    async getJob(id) {
      const j = jobs.find((x) => x.id === id)
      return j ? structuredClone(j) : null
    },
    async dismissJob(id, reason, tags) {
      const j = jobById(id)
      j.stage = 'dismissed'
      j.dismissReason = reason
      j.dismissTags = tags
      addEvent('dismissed', id, `You dismissed ${j.title} at ${j.company}${tags.length ? ` (${tags.join(', ')})` : ''}.`)
      emit('jobs:changed', { jobIds: [id] })
    },
    async restoreJob(id) {
      const j = jobById(id)
      j.stage = j.fit ? (j.fit.score >= settings.thresholds.shortlistScore ? 'shortlisted' : 'scored') : 'new'
      j.dismissReason = null
      j.dismissTags = []
      addEvent('restored', id, `You restored ${j.title} at ${j.company}.`)
      emit('jobs:changed', { jobIds: [id] })
    },
    async starJob(id, starred) {
      jobById(id).starred = starred
      emit('jobs:changed', { jobIds: [id] })
    },
    async scoreJob(id) {
      await sleep(900)
      const j = jobById(id)
      scoreInto(j)
      extraSpend += 0.002
      addEvent('scored', id, `${j.company}, ${j.title} scored ${j.fitScore}.`)
      emit('jobs:changed', { jobIds: [id] })
      return structuredClone(j)
    },
    async prepareApplication(jobId) {
      await sleep(1500)
      const j = jobById(jobId)
      const existing = applications.find((a) => a.jobId === jobId)
      if (existing) return structuredClone(existing)
      const answers = makeAnswers('flagged', j.company)
      const app: Application = {
        id: uid('app'), jobId, company: j.company, title: j.title, fitScore: j.fitScore, fitBucket: j.fitBucket, status: 'needs_attention', outcome: 'none', submitMode: null,
        flaggedCount: 1, submittedAt: null, outcomeAt: null, createdAt: iso(0), updatedAt: iso(0),
        coverLetter: `Hello ${j.company} team,\n\nI read the posting for the ${j.title} role and the work looks close to what I have been doing for the last three years. At Fieldstone Analytics I rebuilt our dashboard in React and TypeScript, which cut load time from six seconds to under two.\n\nI would be glad to talk about how I could help.\n\nBest,\nAlex`,
        coverLetterLint: { score: 93, issues: [], stats: { words: 62, sentences: 4, avgSentenceWords: 15.5, sentenceLengthStdDev: 5, paragraphs: 3 } },
        answers, formFields: answers.map((a) => ({ key: a.fieldKey, label: a.label, type: a.type, required: a.required, options: a.options, placeholder: null, maxLength: null, fileHint: null })),
        resumeDocId: 'doc_resume1', confirmation: null, screenshotPath: null, error: null, notes: ''
      }
      applications.unshift(app)
      j.stage = 'ready'
      j.applicationId = app.id
      extraSpend += 0.04
      addEvent('prepared', jobId, `Prepared an application for ${j.title} at ${j.company}. One answer needs you.`)
      emit('jobs:changed', { jobIds: [jobId] })
      emit('applications:changed', { applicationIds: [app.id] })
      return structuredClone(app)
    },

    async listApplications(q) {
      let items = applications.filter((a) => (!q.statuses || q.statuses.includes(a.status)) && (!q.outcomes || q.outcomes.includes(a.outcome)))
      if (q.search) {
        const s = q.search.toLowerCase()
        items = items.filter((a) => `${a.company} ${a.title}`.toLowerCase().includes(s))
      }
      items = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const off = q.offset ?? 0
      return { items: items.slice(off, off + (q.limit ?? 200)).map(toAppSummary), total: items.length }
    },
    async getApplication(id) {
      const a = applications.find((x) => x.id === id)
      return a ? structuredClone(a) : null
    },
    async getApplicationForJob(jobId) {
      const a = applications.find((x) => x.jobId === jobId)
      return a ? structuredClone(a) : null
    },
    async updateApplication(id, patch) {
      const a = appById(id)
      if (patch.coverLetter !== undefined) {
        a.coverLetter = patch.coverLetter
        a.coverLetterLint = lintDemo(patch.coverLetter)
      }
      if (patch.answers) a.answers = patch.answers
      if (patch.notes !== undefined) a.notes = patch.notes
      if (patch.outcome) {
        a.outcome = patch.outcome
        a.outcomeAt = patch.outcome === 'none' ? null : iso(0)
        addEvent('outcome', a.jobId, `${a.company} moved to ${patch.outcome}.`)
      }
      if (patch.status) a.status = patch.status
      if (patch.resumeDocId !== undefined) a.resumeDocId = patch.resumeDocId
      touchApp(a)
      return structuredClone(a)
    },
    async regenerateAnswer(applicationId, fieldKey, guidance): Promise<PreparedAnswer> {
      await sleep(900)
      const a = appById(applicationId)
      const ans = a.answers.find((x) => x.fieldKey === fieldKey)
      if (!ans) throw new Error('That answer no longer exists.')
      const text =
        ans.type === 'textarea'
          ? `${a.company} ships the kind of product I would use myself.${guidance ? ` (${guidance})` : ''} My last three years were spent on dashboards and a shared component library, and this role is the same problem at a larger scale.`
          : ans.options[0] ?? 'Demo value'
      Object.assign(ans, { value: text, source: 'ai', confidence: 0.82, needsUser: false, note: null })
      touchApp(a)
      return structuredClone(ans)
    },
    async regenerateCoverLetter(applicationId, guidance) {
      await sleep(1200)
      const a = appById(applicationId)
      a.coverLetter = `Hello ${a.company} team,\n\nI am applying for the ${a.title} role. Last year I rebuilt our analytics dashboard in React and TypeScript and cut load time from six seconds to under two. I also built the component library four teams now share.${guidance ? `\n\n(Guidance applied: ${guidance})` : ''}\n\nI would like to talk about how that experience fits your team.\n\nBest,\nAlex`
      a.coverLetterLint = lintDemo(a.coverLetter)
      touchApp(a)
      return structuredClone(a)
    },
    async lintText(text) {
      await sleep(80)
      return text.trim() ? lintDemo(text) : emptyLint()
    },
    async submitApplication(id, mode) {
      const a = appById(id)
      if (a.answers.some((x) => x.needsUser && x.required)) throw new Error('Some required answers still need your input.')
      a.status = 'submitting'
      touchApp(a)
      await sleep(1600)
      if (mode === 'assist') {
        a.status = 'ready'
        touchApp(a)
        return { ok: true, status: 'ready', message: 'The form is filled in the browser window. Check it and click Submit there.', screenshotPath: null }
      }
      a.status = 'submitted'
      a.submitMode = mode
      a.submittedAt = iso(0)
      a.confirmation = 'Thanks for applying. We will be in touch.'
      a.screenshotPath = `C:\\Users\\Demo\\AppData\\Roaming\\JobPilot\\screenshots\\${a.id}.png`
      const j = jobs.find((x) => x.id === a.jobId)
      if (j) j.stage = 'applied'
      addEvent('submitted', a.jobId, `Submitted the application to ${a.company}.`)
      touchApp(a)
      emit('jobs:changed', { jobIds: [a.jobId] })
      return { ok: true, status: 'submitted', message: `Submitted to ${a.company}.`, screenshotPath: a.screenshotPath }
    },
    async markSubmitted(id) {
      const a = appById(id)
      a.status = 'submitted'
      a.submitMode = 'manual'
      a.submittedAt = iso(0)
      const j = jobs.find((x) => x.id === a.jobId)
      if (j) j.stage = 'applied'
      addEvent('submitted', a.jobId, `You marked ${a.company} as submitted.`)
      touchApp(a)
      emit('jobs:changed', { jobIds: [a.jobId] })
      return structuredClone(a)
    },
    async exportCoverLetterPdf(id) {
      await sleep(400)
      return `C:\\Users\\Demo\\Documents\\cover-letter-${appById(id).company.toLowerCase().replace(/\W+/g, '-')}.pdf`
    },

    async runPipeline(options): Promise<RunStats> {
      if (progress.phase !== 'idle') throw new Error('A run is already in progress.')
      cancelled = false
      const runId = uid('run')
      const startedAt = iso(0)
      addEvent('run_started', null, options.trigger === 'schedule' ? 'Run started by the schedule.' : 'Run started by you.')
      const phases: Array<[PipelineProgress['phase'], string, number]> = [
        ['discovering', 'Checking sources', 6],
        ['filtering', 'Applying free filters', 24],
        ['scoring', 'Scoring new jobs', 4],
        ['preparing', 'Drafting applications', 1]
      ]
      for (const [phase, message, total] of phases) {
        for (let done = 0; done <= total; done++) {
          if (cancelled) break
          progress = { runId, phase, message, done, total }
          emit('pipeline:progress', progress)
          await sleep(phase === 'filtering' ? 40 : 250)
        }
        if (cancelled) break
      }
      const fresh = initialJobs()[12]
      fresh.id = uid('job')
      fresh.company = 'Lantern Works'
      fresh.title = 'Senior Frontend Engineer'
      fresh.discoveredAt = iso(0)
      jobs.unshift(fresh)
      extraSpend += 0.018
      const stats: RunStats = { discovered: 31, newJobs: 1, duplicates: 4, filteredOut: 12, prescoredOut: 14, scored: 0, shortlisted: 0, prepared: 0, submitted: 0, errors: 0, costUsd: 0.018, tokens: 9800, stoppedForBudget: false }
      runs.unshift({ id: runId, trigger: options.trigger ?? 'manual', startedAt, finishedAt: iso(0), stats, error: null })
      addEvent('run_finished', null, cancelled ? 'Run cancelled.' : 'Run finished: 31 found, 1 new.')
      progress = { runId: null, phase: 'idle', message: 'Idle', done: 0, total: 0 }
      emit('pipeline:progress', progress)
      emit('jobs:changed', { jobIds: [fresh.id] })
      return stats
    },
    async cancelPipeline() {
      cancelled = true
    },
    async getPipelineStatus() {
      return progress
    },
    async listRuns(limit) {
      return runs.slice(0, limit)
    },
    async listEvents(q) {
      let list = events
      if (q.types) list = list.filter((e) => q.types?.includes(e.type))
      if (q.jobId) list = list.filter((e) => e.jobId === q.jobId)
      return list.slice(0, q.limit)
    },
    async listSuggestions() {
      return structuredClone(suggestions)
    },
    async dismissSuggestion(id) {
      suggestions = suggestions.filter((s) => s.id !== id)
    },

    async getAnalytics(rangeDays) {
      await sleep(250)
      return buildAnalytics(rangeDays)
    },
    async getUsage() {
      return usage()
    }
  }

  return {
    call: (async (method: string, ...args: unknown[]) => {
      await sleep(60 + Math.random() * 90)
      const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]
      if (!fn) throw new Error(`Demo mode does not implement ${method}.`)
      return fn(...args)
    }) as Bridge['call'],
    on: ((channel: PushChannel, listener: (p: never) => void) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => {
        set.delete(listener)
      }
    }) as Bridge['on']
  }
}
