import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import type { Api, PushChannel, PushEvents } from '@shared/api'
import type { Application, ApplicationOutcome, DocumentKind, Job, SubmitResult } from '@shared/types'
import { answerFields, type AnswerDeps } from './apply/answers'
import { BrowserManager } from './apply/browser'
import { renderCoverLetterPdf } from './apply/coverLetterPdf'
import { isCoverLetterField } from './apply/fieldMap'
import { draftApplication } from './apply/prepare'
import { runSubmission } from './apply/submitRun'
import { getAnalytics } from './analytics'
import { type AppContext, createContext } from './context'
import { newId } from './db/database'
import { BudgetExceededError } from './llm/errors'
import type { AppPaths } from './paths'
import { dismissJob, restoreJob, scoreJobNow } from './pipeline/actions'
import { dismissSuggestion, suggestPreferences } from './pipeline/learn'
import { ingestJob, Pipeline } from './pipeline/orchestrator'
import { buildVoice, extractProfileFromText } from './profile/extract'
import { copyIntoAppData, extractTextFromFile, fetchUrlText } from './profile/ingest'
import { Scheduler } from './scheduler'
import type { KeyVault } from './secrets'
import { detectAts, fetchJobByUrl } from './sources'
import { lintText } from './writing/lint'
import { writeCoverLetter } from './writing/generate'

export type Shutdown = () => Promise<void>

export interface IpcDeps {
  ipcMain: IpcMain
  paths: AppPaths
  vault: KeyVault
  emit: <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void
  appVersion: string
  /** Only frames showing the app's own page may call the API. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

const SAMPLE_KINDS: DocumentKind[] = ['cover_letter_sample', 'writing_sample']

const OUTCOME_LABEL: Record<ApplicationOutcome, string> = {
  none: 'no reply yet',
  rejected: 'Rejected',
  ghosted: 'No reply',
  screen: 'Screening call',
  interview: 'Interview',
  offer: 'Offer',
  accepted: 'Accepted',
  declined: 'Declined'
}

/** Builds every service and returns the Api implementation. Separate from Electron so it can be tested. */
export async function createServices(deps: Omit<IpcDeps, 'ipcMain' | 'isTrustedSender'>): Promise<{ api: Api; ctx: AppContext; shutdown: Shutdown }> {
  const ctx = await createContext({ dbFile: deps.paths.dbFile, paths: deps.paths, vault: deps.vault, emit: deps.emit })
  const browser = new BrowserManager(deps.paths.browserProfileDir)
  const pipeline = new Pipeline(ctx)
  const scheduler = new Scheduler(ctx, pipeline)
  ctx.llm.pruneCache()

  // Applications caught mid-step when the app last closed. A browser session doesn't survive a restart.
  for (const stale of ctx.applications.list({ statuses: ['submitting', 'draft'], limit: 1000 }).items) {
    const full = ctx.applications.get(stale.id)
    if (!full) continue
    if (full.status === 'draft' && full.answers.length === 0 && !full.coverLetter) {
      ctx.applications.delete(full.id)
      ctx.jobs.setStage(full.jobId, 'shortlisted')
    } else {
      ctx.applications.update(full.id, {
        status: 'needs_attention',
        error: full.status === 'submitting'
          ? 'The app closed while this was open in the browser. If you submitted it, click "I submitted it myself". Otherwise open it again.'
          : 'Preparing was interrupted. Check the answers or prepare it again.'
      })
    }
  }

  /** Applications open in the browser right now. A second submit would open a second tab. */
  const inFlight = new Set<string>()

  const job = (id: string): Job => {
    const j = ctx.jobs.get(id)
    if (!j) throw new Error('That job no longer exists.')
    return j
  }
  const application = (id: string): Application => {
    const a = ctx.applications.get(id)
    if (!a) throw new Error('That application no longer exists.')
    return a
  }

  const samples = () =>
    ctx.documents
      .list()
      .filter((d) => SAMPLE_KINDS.includes(d.kind))
      .map((d) => ({ id: d.id, name: d.name, text: ctx.documents.getText(d.id) }))

  const answerDeps = (): AnswerDeps => ({
    llm: ctx.llm,
    settings: ctx.settings.get(),
    profile: ctx.profile.get().profile,
    samples: samples(),
    findSavedAnswer: (q) => {
      const hit = ctx.answers.findBest(q)
      return hit ? { id: hit.id, answer: hit.answer, kind: hit.kind } : null
    },
    markAnswerUsed: (id) => ctx.answers.markUsed(id),
    resumePath: ctx.documents.primaryResume()?.filePath ?? null
  })

  const coverLetterDir = path.join(deps.paths.exportsDir, 'cover-letters')
  const renderLetter = (text: string, company: string) =>
    renderCoverLetterPdf(browser, ctx.settings.get().browser, { text, profile: ctx.profile.get().profile, company, outDir: coverLetterDir })

  const changed = (app: Application) => {
    deps.emit('applications:changed', { applicationIds: [app.id] })
    deps.emit('jobs:changed', { jobIds: [app.jobId] })
  }

  /** Drafts the application for a job: form, answers and cover letter. */
  async function prepare(jobId: string): Promise<Application> {
    const j = job(jobId)
    const existing = ctx.applications.getByJob(jobId)
    if (existing?.status === 'submitted') throw new Error('This application was already submitted.')
    const app = existing ?? ctx.applications.create(jobId)
    const previousStage = j.stage
    ctx.applications.update(app.id, { status: 'draft', error: null })
    try {
      const draft = await draftApplication({ ...answerDeps(), browser }, j)
      const flagged = draft.answers.filter((a) => a.needsUser && a.required).length + (draft.coverLetterNeedsInput ? 1 : 0)
      const notes: string[] = []
      if (draft.formSource === 'none') notes.push("The form couldn't be read ahead of time. It will be read and filled when you open it.")
      if (draft.coverLetterNeedsInput) notes.push(`Cover letter needs your input: ${draft.coverLetterNeedsInput}`)
      const updated = ctx.applications.update(app.id, {
        status: flagged ? 'needs_attention' : 'ready',
        coverLetter: draft.coverLetter ?? undefined,
        coverLetterLint: draft.coverLetterLint,
        answers: draft.answers,
        formFields: draft.fields,
        error: notes.length ? notes.join(' ') : null
      })
      ctx.events.add(
        'prepared',
        `Prepared an application for ${j.title} at ${j.company}.${flagged ? ` ${flagged === 1 ? 'One answer needs' : `${flagged} answers need`} you.` : ''}`,
        jobId,
        { costUsd: draft.costUsd, formSource: draft.formSource }
      )
      changed(updated)
      return updated
    } catch (err) {
      if (!existing) {
        ctx.applications.delete(app.id)
        ctx.jobs.setStage(jobId, previousStage === 'preparing' ? 'shortlisted' : previousStage)
      } else {
        ctx.applications.update(app.id, { status: existing.status === 'draft' ? 'needs_attention' : existing.status, error: (err as Error).message })
      }
      if (!(err instanceof BudgetExceededError)) ctx.events.add('error', `Couldn't prepare ${j.title} at ${j.company}. ${(err as Error).message}`, jobId)
      deps.emit('jobs:changed', { jobIds: [jobId] })
      throw err
    }
  }

  /** Fills (and in auto mode submits) an application in the visible browser. */
  async function submit(applicationId: string, mode: 'assist' | 'auto', by: 'user' | 'autopilot'): Promise<SubmitResult> {
    const app = application(applicationId)
    if (app.status === 'submitted') return { ok: true, status: 'submitted', message: 'Already submitted.', screenshotPath: app.screenshotPath }
    if (app.status === 'withdrawn') return { ok: false, status: 'withdrawn', message: 'This application was withdrawn.', screenshotPath: null }
    if (inFlight.has(app.id)) {
      return { ok: false, status: app.status, message: 'This application is already open in the browser. Finish it there.', screenshotPath: null }
    }
    inFlight.add(app.id)
    try {
      return await submitNow(app, mode, by)
    } catch (err) {
      inFlight.delete(app.id)
      throw err
    }
  }

  async function submitNow(app: Application, mode: 'assist' | 'auto', by: 'user' | 'autopilot'): Promise<SubmitResult> {
    const j = job(app.jobId)
    const settings = ctx.settings.get()
    ctx.applications.update(app.id, { status: 'submitting', submitMode: mode, error: null })
    changed(app)

    let result
    try {
      result = await runSubmission(
        { browser, settings, answerDeps: answerDeps(), renderCoverLetter: (text) => renderLetter(text, j.company), screenshotsDir: deps.paths.screenshotsDir },
        j,
        app,
        mode
      )
    } catch (err) {
      const message = `Couldn't open or fill the form. ${(err as Error).message.split('\n')[0]}`
      const updated = ctx.applications.update(app.id, { status: 'needs_attention', error: message })
      ctx.events.add('submit_failed', `${j.title} at ${j.company}: ${message}`, j.id)
      changed(updated)
      inFlight.delete(app.id)
      return { ok: false, status: 'needs_attention', message, screenshotPath: null }
    }

    const updated = ctx.applications.update(app.id, {
      status: result.status,
      answers: result.answers,
      formFields: result.formFields,
      screenshotPath: result.screenshotPath ?? undefined,
      confirmation: result.confirmation ?? undefined,
      error: result.ok ? null : result.message
    })
    if (result.status === 'submitted') {
      ctx.events.add('submitted', `Submitted the application to ${j.company} for ${j.title}${by === 'autopilot' ? ' automatically' : ''}.`, j.id)
    } else if (result.status === 'needs_attention') {
      ctx.events.add('submit_failed', `${j.title} at ${j.company}: ${result.message}`, j.id)
    }
    changed(updated)

    // Keep watching the browser in the background and record the submission when it happens.
    if (!result.completion) inFlight.delete(app.id)
    result.completion?.finally(() => inFlight.delete(app.id)).catch(() => {})
    result.completion?.then(({ confirmed, screenshotPath }) => {
      const current = ctx.applications.get(app.id)
      if (!current || current.status === 'submitted') return
      if (confirmed) {
        const done = ctx.applications.update(app.id, { status: 'submitted', screenshotPath: screenshotPath ?? undefined, confirmation: 'Confirmation page seen', error: null })
        ctx.events.add('submitted', `Submitted the application to ${j.company} for ${j.title}.`, j.id)
        changed(done)
      } else if (current.status === 'submitting' || current.status === 'needs_attention') {
        const back = ctx.applications.update(app.id, {
          status: 'needs_attention',
          error: "No confirmation page was seen. If you submitted it, click \"I submitted it myself\". Otherwise open it again."
        })
        changed(back)
      }
    }, () => {})

    return { ok: result.ok, status: result.status, message: result.message, screenshotPath: result.screenshotPath }
  }

  pipeline.setHooks({
    prepare: async (jobId) => {
      await prepare(jobId)
    },
    submit: (applicationId) => submit(applicationId, 'auto', 'autopilot')
  })
  scheduler.start()

  const insideDataDir = (p: string) => {
    const rel = path.relative(deps.paths.dataDir, path.resolve(p))
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  const api: Api = {
    // App
    async getAppInfo() {
      return { version: deps.appVersion, dataDir: deps.paths.dataDir, platform: process.platform }
    },
    async openExternal(url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened.')
      await shell.openExternal(url)
    },
    async openPath(p) {
      // Only files the app created, such as screenshots and cover letter PDFs.
      if (!insideDataDir(p)) throw new Error('That file is outside the JobPilot data folder.')
      const err = await shell.openPath(p)
      if (err) throw new Error(err)
    },
    async exportData() {
      const win = BrowserWindow.getFocusedWindow()
      const defaultPath = path.join(deps.paths.exportsDir, `jobpilot-export-${new Date().toISOString().slice(0, 10)}.json`)
      const res = win ? await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'JSON', extensions: ['json'] }] }) : { canceled: false, filePath: defaultPath }
      if (res.canceled || !res.filePath) return null
      const tables = ['settings', 'profile', 'documents', 'answer_bank', 'companies', 'searches', 'jobs', 'applications', 'events', 'runs', 'llm_calls']
      const data: Record<string, unknown> = { exportedAt: new Date().toISOString(), version: deps.appVersion, note: 'AI provider keys and job source keys are not included.' }
      for (const t of tables) data[t] = ctx.db.all(`SELECT * FROM ${t}`)
      // Saved searches can hold job board credentials (Adzuna's app_id and app_key).
      data.searches = ctx.searches.list().map((s) => ({
        ...s,
        params: Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, /key|secret|token|password|app_id/i.test(k) ? '[removed]' : v]))
      }))
      data.providers = ctx.providers.list()
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2))
      return res.filePath
    },

    // Settings
    async getSettings() {
      return ctx.settings.get()
    },
    async updateSettings(patch) {
      const next = ctx.settings.update(patch)
      scheduler.reschedule()
      return next
    },
    async removePriceOverride(model) {
      return ctx.settings.removePrice(model)
    },

    // AI providers
    async listProviders() {
      return ctx.providers.list()
    },
    async saveProvider(input) {
      const saved = ctx.providers.save(input)
      ctx.llm.resetClients()
      return saved
    },
    async deleteProvider(id) {
      ctx.providers.delete(id)
      ctx.llm.resetClients()
      const { routing } = ctx.settings.get()
      const cleared = Object.fromEntries(Object.entries(routing).map(([stage, ref]) => [stage, ref?.providerId === id ? null : ref]))
      ctx.settings.update({ routing: cleared })
    },
    async testProvider(id) {
      return ctx.llm.testProvider(id)
    },
    async listModels(providerId) {
      return ctx.llm.listModels(providerId)
    },

    // Profile and materials
    async getProfile() {
      return ctx.profile.get()
    },
    async saveProfile(profile) {
      return ctx.profile.save(profile)
    },
    async pickFiles(options) {
      const win = BrowserWindow.getFocusedWindow()
      const props: Array<'openFile' | 'multiSelections'> = ['openFile']
      if (options.multiple) props.push('multiSelections')
      const opts = {
        title: options.title,
        properties: props,
        filters: options.extensions?.length ? [{ name: 'Documents', extensions: options.extensions }] : []
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? [] : res.filePaths
    },
    async importDocument(input) {
      let doc
      if (input.filePath) {
        const { text, mime } = await extractTextFromFile(input.filePath)
        const copy = copyIntoAppData(input.filePath, deps.paths.documentsDir, newId().slice(0, 8))
        doc = ctx.documents.insert({ kind: input.kind, name: input.name ?? path.basename(input.filePath), filePath: copy, mime, text })
      } else if (input.url) {
        let text = ''
        let title = input.name ?? input.url
        try {
          const page = await fetchUrlText(input.url)
          text = page.text
          title = input.name ?? page.title
        } catch {
          // Keep the link even if the page can't be read. It's still useful in the profile.
        }
        doc = ctx.documents.insert({ kind: input.kind, name: title, url: input.url, text })
      } else if (input.text?.trim()) {
        doc = ctx.documents.insert({ kind: input.kind, name: input.name ?? 'Pasted text', text: input.text.trim(), mime: 'text/plain' })
      } else {
        throw new Error('Pick a file, paste a link or paste some text.')
      }
      if (doc.kind === 'resume' && !ctx.documents.primaryResume()) ctx.documents.setPrimary(doc.id)
      return ctx.documents.get(doc.id) ?? doc
    },
    async listDocuments(kind) {
      return ctx.documents.list(kind)
    },
    async getDocumentText(id) {
      return ctx.documents.getText(id)
    },
    async deleteDocument(id) {
      const doc = ctx.documents.get(id)
      ctx.documents.delete(id)
      if (doc?.filePath && insideDataDir(doc.filePath)) fs.rmSync(doc.filePath, { force: true })
    },
    async setPrimaryResume(id) {
      ctx.documents.setPrimary(id)
    },
    async extractProfileFromResume(documentId) {
      const text = ctx.documents.getText(documentId)
      if (!text.trim()) throw new Error('No text could be read from that document.')
      return extractProfileFromText(ctx.llm, text, ctx.profile.get().profile)
    },
    async buildVoiceProfile() {
      const voice = await buildVoice(ctx.llm, samples())
      return ctx.profile.save({ ...ctx.profile.get().profile, voice })
    },

    // Answer bank
    async listAnswers() {
      return ctx.answers.list()
    },
    async saveAnswer(entry) {
      return ctx.answers.save(entry)
    },
    async deleteAnswer(id) {
      ctx.answers.delete(id)
    },

    // Sources
    async listSearches() {
      return ctx.searches.list()
    },
    async saveSearch(search) {
      return ctx.searches.save(search)
    },
    async deleteSearch(id) {
      ctx.searches.delete(id)
    },
    async listCompanies() {
      return ctx.companies.list()
    },
    async saveCompany(input) {
      let patch = input
      if (input.careersUrl && (!input.ats || input.ats === 'unknown')) {
        const found = detectAts(input.careersUrl)
        if (found) patch = { ...input, ats: found.ats, atsToken: input.atsToken ?? found.token ?? undefined, name: input.name ?? found.companyName ?? undefined }
      }
      return ctx.companies.save(patch)
    },
    async deleteCompany(id) {
      ctx.companies.delete(id)
    },
    async detectAts(url) {
      return detectAts(url)
    },
    async addJobByUrl(url) {
      const added = ingestJob(ctx, await fetchJobByUrl(url))
      ctx.events.add('discovered', `Added ${added.title} at ${added.company} from a link.`, added.id)
      deps.emit('jobs:changed', { jobIds: [added.id] })
      return added
    },

    // Jobs
    async listJobs(query) {
      return ctx.jobs.list(query)
    },
    async getJob(id) {
      return ctx.jobs.get(id)
    },
    async dismissJob(id, reason, tags) {
      dismissJob(ctx, id, reason, tags)
    },
    async restoreJob(id) {
      restoreJob(ctx, id)
    },
    async starJob(id, starred) {
      ctx.jobs.star(id, starred)
      deps.emit('jobs:changed', { jobIds: [id] })
    },
    async scoreJob(id) {
      return scoreJobNow(ctx, id)
    },
    async prepareApplication(jobId) {
      return prepare(jobId)
    },

    // Applications
    async listApplications(query) {
      return ctx.applications.list(query)
    },
    async getApplication(id) {
      return ctx.applications.get(id)
    },
    async getApplicationForJob(jobId) {
      return ctx.applications.getByJob(jobId)
    },
    async updateApplication(id, patch) {
      const before = application(id)
      const updated = ctx.applications.update(id, patch)
      if (patch.outcome && patch.outcome !== before.outcome) {
        ctx.events.add('outcome', `${updated.company} moved to ${OUTCOME_LABEL[patch.outcome]}.`, updated.jobId, { outcome: patch.outcome })
      }
      changed(updated)
      return updated
    },
    async regenerateAnswer(applicationId, fieldKey, guidance) {
      const app = application(applicationId)
      const j = job(app.jobId)
      const current = app.answers.find((a) => a.fieldKey === fieldKey)
      const field = app.formFields.find((f) => f.key === fieldKey) ??
        (current ? { key: current.fieldKey, label: current.label, type: current.type, required: current.required, options: current.options, placeholder: null, maxLength: null, fileHint: null } : null)
      if (!field) throw new Error('That question is no longer on this application.')
      const res = await answerFields(answerDeps(), j, [field], app.coverLetter, {
        regenerateKeys: new Set([fieldKey]),
        guidance: guidance ? new Map([[fieldKey, guidance]]) : undefined
      })
      const fresh = res.answers[0]
      const answers = app.answers.some((a) => a.fieldKey === fieldKey) ? app.answers.map((a) => (a.fieldKey === fieldKey ? fresh : a)) : [...app.answers, fresh]
      const flagged = answers.some((a) => a.needsUser && a.required)
      changed(ctx.applications.update(app.id, { answers, status: app.status === 'ready' || app.status === 'needs_attention' ? (flagged ? 'needs_attention' : 'ready') : app.status }))
      return fresh
    },
    async regenerateCoverLetter(applicationId, guidance) {
      const app = application(applicationId)
      const j = job(app.jobId)
      const deps2 = answerDeps()
      const written = await writeCoverLetter(ctx.llm, { profile: deps2.profile, samples: deps2.samples, settings: deps2.settings }, j, { guidance, regenerate: true })
      if (written.needsInput) throw new Error(`The cover letter needs your input: ${written.needsInput}`)
      // A cover letter pasted into a form field follows the new letter too.
      const answers = app.answers.map((a) => (isCoverLetterField({ key: a.fieldKey, label: a.label, type: a.type, required: a.required, options: [], placeholder: null, maxLength: null, fileHint: null }) && (a.type === 'textarea' || a.type === 'text') ? { ...a, value: written.text, needsUser: false } : a))
      const updated = ctx.applications.update(app.id, { coverLetter: written.text, coverLetterLint: written.lint, answers })
      changed(updated)
      return updated
    },
    async lintText(text) {
      return lintText(text, { extraBanned: ctx.settings.get().writing.bannedPhrases })
    },
    async submitApplication(applicationId, mode) {
      return submit(applicationId, mode, 'user')
    },
    async markSubmitted(applicationId) {
      const app = application(applicationId)
      const updated = ctx.applications.update(app.id, { status: 'submitted', submitMode: 'manual', error: null })
      ctx.events.add('submitted', `You marked the application to ${updated.company} for ${updated.title} as submitted.`, updated.jobId)
      changed(updated)
      return updated
    },
    async exportCoverLetterPdf(applicationId) {
      const app = application(applicationId)
      if (!app.coverLetter?.trim()) throw new Error('This application has no cover letter yet.')
      return renderLetter(app.coverLetter, app.company)
    },

    // Pipeline
    async runPipeline(options) {
      return pipeline.run(options)
    },
    async cancelPipeline() {
      pipeline.cancel()
    },
    async getPipelineStatus() {
      return pipeline.status()
    },
    async listRuns(limit) {
      return ctx.runs.list(limit)
    },
    async listEvents(query) {
      return ctx.events.list(query)
    },
    async listSuggestions() {
      return suggestPreferences(ctx)
    },
    async dismissSuggestion(id) {
      dismissSuggestion(ctx, id)
    },

    // Analytics
    async getAnalytics(rangeDays) {
      return getAnalytics(ctx, rangeDays)
    },
    async getUsage() {
      return ctx.llm.usageSummary()
    }
  }

  const shutdown: Shutdown = async () => {
    scheduler.stop()
    pipeline.cancel()
    // Save first, so nothing is lost if closing the browser hangs.
    ctx.db.flush()
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
    ctx.close()
  }

  return { api, ctx, shutdown }
}

export async function registerIpc(deps: IpcDeps): Promise<Shutdown> {
  const { api, shutdown } = await createServices(deps)
  deps.ipcMain.handle('api', async (event, method: string, args: unknown[]) => {
    if (!deps.isTrustedSender(event)) {
      return { ok: false, error: 'Calls are only accepted from the JobPilot window.', name: 'Forbidden' }
    }
    if (!Object.prototype.hasOwnProperty.call(api, method)) {
      return { ok: false, error: `Unknown method ${method}.`, name: 'UnknownMethod' }
    }
    try {
      const fn = api[method as keyof Api] as (...a: unknown[]) => Promise<unknown>
      const value = await fn(...(Array.isArray(args) ? args : []))
      return { ok: true, value: value ?? null }
    } catch (err) {
      const e = err as Error
      return { ok: false, error: e.message || String(err), name: e.name || 'Error' }
    }
  })
  return shutdown
}
