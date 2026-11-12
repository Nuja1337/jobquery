import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import type { Api, BoardAddCounts, BoardProbe, DeepPartial, PushChannel, PushEvents } from '@shared/api'
import { answerNeedsUser } from '@shared/answers'
import { COMPANY_SPECIFIC_TOPICS } from '@shared/questionTopics'
import type { Application, ApplicationOutcome, AtsKind, CompanyOrigin, DocumentKind, Job, LoopStatus, PipelineProgress, Settings, SubmitResult, UpdateStatus, WorkerName } from '@shared/types'
import { answerFields, companiesToCheck, type AnswerDeps } from './apply/answers'
import { BrowserManager } from './apply/browser'
import { renderCoverLetterPdf } from './apply/coverLetterPdf'
import { isCoverLetterField } from './apply/fieldMap'
import { isJobBoardUrl } from './apply/jobBoards'
import { applyUrlFor, draftApplication, readFormForJob, type FormRead, type ResolvedApply } from './apply/prepare'
import { heldLetterNote, letterHeld, letterInUse, statusAfterEdit, syncOptionalLetterUploads, type LetterCheck } from './apply/readiness'
import { runSubmission } from './apply/submitRun'
import { getAnalytics } from './analytics'
import { type AppContext, createContext } from './context'
import { newId } from './db/database'
import { BudgetExceededError, OutOfCreditsError, RateLimitedError, isJobFault } from './llm/errors'
import type { AppPaths } from './paths'
import { dismissJob, restoreJob, scoreJobNow } from './pipeline/actions'
import { autoWatchBoard, noteStartedWatching } from './pipeline/ingest'
import { normalizeCompany } from './pipeline/dedupe'
import { dismissSuggestion, suggestPreferences } from './pipeline/learn'
import { WORKERS, WorkLoop } from './pipeline/loop'
import { ingestJob, Pipeline, restageForShortlist } from './pipeline/orchestrator'
import { acceptsValue, buildExceptions, canRetryLater, groupKeyFor, groupNeedsYou, wordingKey } from './review/exceptions'
import { normalizeQuestion } from './util/text'
import { emptyStats } from './db/repos/runs'
import { buildVoice, extractProfileFromText } from './profile/extract'
import { copyIntoAppData, extractTextFromFile, fetchUrlText } from './profile/ingest'
import { Scheduler } from './scheduler'
import type { KeyVault } from './secrets'
import { boardUrl } from '@shared/sources'
import { canReadBoard, detectAts, fetchJobByUrl } from './sources'
import { parseBoardList, probeBoard } from './sources/importBoards'
import { prettifyToken } from './sources/detect'
import { starterPack } from './sources/starterPack'
import { Updater, type UpdaterOptions } from './updater'
import { exportDatabaseCopy } from './db/exportDb'
import { cleanLine, createFileLog, type FileLog } from './util/fileLog'
import { pruneOldFiles } from './util/prune'
import { runRetention } from './db/retention'
import { failureReason, HELD_LETTER_NOTE, lettersCheckPasses, lintText } from './writing/lint'
import { coverLetterLintOptions, jobWritingContext, writeCoverLetter } from './writing/generate'

export type Shutdown = () => Promise<void>

/** Failed automatic attempts, with no Submit click, before autopilot leaves an application for the user. */
export const MAX_SUBMIT_FAILURES = 3
/** Boards checked in one probeBoards call. */
export const MAX_PROBE_ENTRIES = 500
const SCREENSHOT_KEEP_DAYS = 60

/** The services of the app that is running, so a crash handler outside this file can write to the activity log. */
let active: AppContext | null = null
let activeLog: FileLog | null = null

/**
 * Writes an error nobody caught to the activity log, when the app is up. The caller decides what
 * else to do with it. Never throws, since it runs inside a crash handler.
 */
export function recordProcessError(what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(what, err)
  // The first stack lines help with a crash. The log redacts keys and cuts long text.
  const where = err instanceof Error && err.stack ? err.stack.split(/\r?\n/).slice(1, 4).join(' ') : ''
  activeLog?.write('error', `${what} ${detail} ${where}`)
  try {
    // The mark lets the notifier tell a crash from an ordinary error.
    active?.events.add('error', `${what} ${detail}`.slice(0, 500), null, { process: true })
  } catch {
    // The database may already be closed.
  }
}

export interface IpcDeps {
  ipcMain: IpcMain
  paths: AppPaths
  vault: KeyVault
  emit: <C extends PushChannel>(channel: C, payload: PushEvents[C]) => void
  appVersion: string
  /** Only frames showing the app's own page may call the API. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /** Left out in tests and anywhere the app can't update itself. */
  updates?: Pick<UpdaterOptions, 'backend' | 'isPackaged' | 'platform' | 'quit'>
  /** Whether the operating system starts the app at sign-in, or null when it can't. Shown in Settings. */
  openAtLogin?: () => boolean | null
}

/** What the tray, the sleep blocker and the notifications need from the services. */
export interface BackgroundControls {
  settings(): Settings
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  isRunning(): boolean
  progress(): PipelineProgress
  nextRunAt(): string | null
  /** The work loop's workers and today's counts, or null when continuous mode is off. */
  loopStatus(): LoopStatus | null
  /** Starts a run with the autopilot options, unless one is going. */
  runNow(): Promise<void>
  /** Call when the computer wakes from sleep. */
  resume(): void
  /** The employer of a job, for notifications. */
  companyFor(jobId: string): string | null
  /** Runs after settings change or the schedule moves. */
  onChange(listener: () => void): void
}

const SAMPLE_KINDS: DocumentKind[] = ['cover_letter_sample', 'writing_sample']

const OUTCOME_LABEL: Record<ApplicationOutcome, string> = {
  none: 'no reply yet',
  rejected: 'Rejected',
  ghosted: 'Ghosted',
  screen: 'Screening call',
  interview: 'Interview',
  offer: 'Offer',
  accepted: 'Accepted',
  declined: 'Declined'
}

function workerName(value: unknown): WorkerName {
  if (typeof value === 'string' && (WORKERS as string[]).includes(value)) return value as WorkerName
  throw new Error('That is not one of the workers.')
}

/** Builds every service and returns the Api implementation. Separate from Electron so it can be tested. */
export async function createServices(deps: Omit<IpcDeps, 'ipcMain' | 'isTrustedSender'>): Promise<{ api: Api; ctx: AppContext; shutdown: Shutdown; controls: BackgroundControls }> {
  // The file log gets every activity event: ids, counts and messages the activity log already shows.
  // Event data, prompts, documents and keys are never passed to it.
  const log = createFileLog(path.join(deps.paths.dataDir, 'logs'))
  activeLog = log
  const emit: IpcDeps['emit'] = (channel, payload) => {
    if (channel === 'event:new') {
      const event = payload as PushEvents['event:new']
      log.write(event.type === 'error' || event.type === 'submit_failed' ? 'error' : 'info', `${event.type} job=${event.jobId ?? '-'} ${cleanLine(event.message)}`)
    }
    deps.emit(channel, payload)
  }
  const ctx = await createContext({ dbFile: deps.paths.dbFile, paths: deps.paths, vault: deps.vault, emit })
  log.write('info', `jobpls ${deps.appVersion} started, database version ${ctx.db.schemaVersion}`)
  const browser = new BrowserManager(deps.paths.browserProfileDir)
  const pipeline = new Pipeline(ctx)
  const loop = new WorkLoop(ctx, pipeline)
  const scheduler = new Scheduler(ctx, pipeline, loop)
  active = ctx
  ctx.llm.pruneCache()
  pruneOldFiles(deps.paths.screenshotsDir, SCREENSHOT_KEEP_DAYS)
  // Old dropped jobs, events and cache entries are cleared at startup and once a day, never during a run.
  const retain = (): void => {
    // The loop is always on in continuous mode. Cleanup is one short step between its own, so it goes ahead.
    if (pipeline.isRunning() && !loop.isRunning()) return
    try {
      runRetention(ctx.db)
    } catch (err) {
      ctx.events.add('error', `Could not clean up old data. ${(err as Error).message}`)
    }
  }
  retain()
  const retentionTimer = setInterval(retain, 24 * 3_600_000)
  retentionTimer.unref?.()

  // Applications caught mid-step when the app last closed. A browser session doesn't survive a restart.
  for (const stale of ctx.applications.list({ statuses: ['submitting', 'draft'], limit: 1000 }).items) {
    const full = ctx.applications.get(stale.id)
    if (!full) continue
    if (full.status === 'draft' && full.answers.length === 0 && !full.coverLetter) {
      ctx.applications.delete(full.id)
      ctx.jobs.moveStage(full.jobId, 'shortlisted', ['preparing'])
    } else if (full.status === 'submitting' && full.submitClickedAt === null && full.submitMode === 'auto' && ctx.applications.lastAttemptBy(full.id) === 'autopilot') {
      // Autopilot was filling it and had not clicked Submit, so nothing was sent and no person had the tab. It goes back in the queue.
      ctx.applications.update(full.id, { status: 'ready', submitMode: null, error: null })
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
    findSavedAnswer: (q, options) => {
      const hit = ctx.answers.findBest(q, options)
      return hit ? { id: hit.id, answer: hit.answer, kind: hit.kind, topic: hit.topic ?? null } : null
    },
    markAnswerUsed: (id) => ctx.answers.markUsed(id),
    // An application sent or clicked to this company before. The one being prepared was never sent, so it does not count.
    previouslyApplied: (company) => ctx.applications.lastSentAt(normalizeCompany(company)) !== null,
    // Every company with an application that was not withdrawn, except names the profile itself uses (past employers,
    // schools, skills, projects). A saved answer that names one of the rest is flagged.
    otherCompanies: () =>
      companiesToCheck(
        ctx.db.all<{ company: string }>("SELECT DISTINCT j.company AS company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.status != 'withdrawn'").map((r) => r.company),
        ctx.profile.get().profile
      ),
    resumePath: ctx.documents.primaryResume()?.filePath ?? null
  })

  const coverLetterDir = path.join(deps.paths.exportsDir, 'cover-letters')
  const renderLetter = (text: string, company: string, applicationId: string) =>
    renderCoverLetterPdf(browser, ctx.settings.get().browser, { text, profile: ctx.profile.get().profile, company, outDir: coverLetterDir, applicationId })

  const changed = (app: Application) => {
    deps.emit('applications:changed', { applicationIds: [app.id] })
    deps.emit('jobs:changed', { jobIds: [app.jobId] })
  }

  /** Items of `incoming` whose key isn't in `stored` yet, appended to `stored`. */
  function addNew<T>(stored: T[], incoming: T[], key: (item: T) => string): T[] {
    const have = new Set(stored.map(key))
    return [...stored, ...incoming.filter((item) => !have.has(key(item)))]
  }

  /** Answers can't change once sent, or while the form is open in the browser. */
  function assertEditable(app: Application): void {
    if (app.status === 'submitted') throw new Error('This application was already submitted.')
    if (app.status === 'withdrawn') throw new Error('This application was withdrawn. Restore the job first.')
    if (inFlight.has(app.id) || app.status === 'submitting') throw new Error('This application is open in the browser. Finish it there first.')
  }

  /**
   * Points unsent applications at the current primary resume, so Review shows the file that gets uploaded,
   * and records which resume document each one will use.
   */
  function refreshResumeAnswers(): void {
    const primary = ctx.documents.primaryResume()
    const resume = primary?.filePath ?? null
    const open = []
    for (let offset = 0; ; offset += 500) {
      const page = ctx.applications.list({ statuses: ['draft', 'ready', 'needs_attention', 'failed'], limit: 500, offset }).items
      open.push(...page)
      if (page.length < 500) break
    }
    for (const summary of open) {
      const app = ctx.applications.get(summary.id)
      if (!app) continue
      const resumeKeys = new Set(app.formFields.filter((f) => f.type === 'file' && f.fileHint === 'resume').map((f) => f.key))
      let touched = false
      const answers = app.answers.map((a) => {
        if (!resumeKeys.has(a.fieldKey) || a.value === (resume ?? '')) return a
        touched = true
        return { ...a, value: resume ?? '', confidence: resume ? 1 : 0, needsUser: !resume && a.required, note: resume ? null : 'Upload a resume in Profile first.' }
      })
      const resumeDocId = primary?.id ?? null
      // Through saveEdit, so a resume that appears or goes missing moves the status like any other edit.
      if (touched) changed(saveEdit(app, { answers, resumeDocId }))
      else if (app.resumeDocId !== resumeDocId) ctx.applications.update(app.id, { resumeDocId })
    }
  }

  /**
   * Another live job for the same posting on the application system that already has an application or is
   * ready or applied. Preparing this one too would write the same answers twice and risk a second submission.
   */
  function handledTwin(jobId: string, resolved: ResolvedApply): Job | null {
    if (!resolved.atsToken || !resolved.atsJobId) return null
    const done = (other: Job): boolean => other.stage === 'ready' || other.stage === 'applied' || ctx.applications.getByJob(other.id) !== null
    return ctx.jobs.findByAtsJob(resolved.ats, resolved.atsToken, resolved.atsJobId, jobId).find((other) => !other.dupOf && !['closed', 'duplicate', 'dismissed'].includes(other.stage) && done(other)) ?? null
  }

  /** Prepares in progress, by job. A second call for the same job waits for the first and gets its result. */
  const preparing = new Map<string, Promise<Application>>()

  /** Drafts the application for a job: form, answers and cover letter. */
  function prepare(jobId: string): Promise<Application> {
    const running = preparing.get(jobId)
    if (running) return running
    const started = prepareNow(jobId).finally(() => preparing.delete(jobId))
    preparing.set(jobId, started)
    return started
  }

  async function prepareNow(jobId: string): Promise<Application> {
    const j = job(jobId)
    const existing = ctx.applications.getByJob(jobId)
    if (existing?.status === 'submitted') throw new Error('This application was already submitted.')
    if (j.stage === 'dismissed' || existing?.status === 'withdrawn') throw new Error('This job was dismissed. Restore it before preparing an application.')
    if (existing && inFlight.has(existing.id)) throw new Error('This application is open in the browser. Finish it there first.')
    const app = existing ?? ctx.applications.create(jobId)
    const previousStage = j.stage
    ctx.applications.update(app.id, { status: 'draft', error: null })
    /** A posting found on a job board now points at the employer's own application. */
    const adoptResolved = (resolved: ResolvedApply): void => {
      ctx.jobs.setApplyTarget(jobId, resolved)
      // The employer's own board is worth watching when the user hasn't decided about it.
      if (resolved.atsToken && autoWatchBoard(ctx, { ats: resolved.ats, token: resolved.atsToken, company: j.company })) {
        noteStartedWatching(ctx, 1)
      }
    }
    try {
      let target = j
      /** The form read that resolved the posting, reused for the draft so the page is opened once. */
      let preRead: FormRead | null = null
      if (isJobBoardUrl(applyUrlFor(j))) {
        // Follow the posting to the employer's form before anything is written. The same posting may already be handled
        // under another job, and the answers cost money to write twice.
        const read = await readFormForJob(browser, ctx.settings.get(), j)
        if (read.resolved) {
          const twin = existing ? null : handledTwin(jobId, read.resolved)
          if (twin) {
            ctx.applications.delete(app.id)
            ctx.jobs.markDuplicate(jobId, twin.id)
            ctx.events.add('filtered', `${j.title} at ${j.company} is the same posting as one already handled, so it was not prepared again.`, jobId)
            deps.emit('jobs:changed', { jobIds: [jobId, twin.id] })
            const theirs = ctx.applications.getByJob(twin.id)
            if (theirs) return theirs
            throw new Error('This posting is a copy of one that is already handled, so it was not prepared again.')
          }
          adoptResolved(read.resolved)
          target = job(jobId)
          preRead = read
        }
      }
      const draft = await draftApplication({ ...answerDeps(), browser }, target, preRead ? { formRead: preRead } : {})
      if (draft.resolved) adoptResolved(draft.resolved)
      // Counted the way the application list counts, so the status and the flagged count agree.
      const flagged = draft.answers.filter(answerNeedsUser).length + (draft.coverLetterNeedsInput ? 1 : 0)
      const notes: string[] = []
      if (draft.formSource === 'none') notes.push("The form couldn't be read ahead of time. It will be read and filled when you open it.")
      if (draft.coverLetterNeedsInput) notes.push(`Cover letter needs your input: ${draft.coverLetterNeedsInput}`)
      // A letter the style check still holds back after its revisions keeps the application out of ready.
      const letterCheck: LetterCheck = { lint: draft.coverLetterLint, minLintScore: ctx.settings.get().writing.minLintScore }
      const letterIsHeld = Boolean(draft.coverLetter?.trim()) && letterHeld(letterCheck) && letterInUse(draft.fields, draft.answers)
      if (letterIsHeld) notes.push(heldLetterNote(letterCheck))
      // An application opened in the browser may have been sent by hand, so it never goes back to ready.
      const wasOpened = Boolean(existing?.submitMode)
      if (wasOpened) notes.push('This application was opened in the browser before. Check that it was not already sent.')
      // The user may have dismissed the job or marked it submitted while the draft was written.
      // Keep the draft, but only mark it ready if nothing else changed its status meanwhile.
      const stillDrafting = ctx.applications.get(app.id)?.status === 'draft'
      const updated = ctx.applications.update(app.id, {
        // A form that couldn't be read ahead of time has no reviewed answers, so autopilot must not open it.
        status: stillDrafting ? (flagged || wasOpened || letterIsHeld || draft.formSource === 'none' ? 'needs_attention' : 'ready') : undefined,
        coverLetter: draft.coverLetter ?? undefined,
        coverLetterLint: draft.coverLetterLint,
        answers: draft.answers,
        formFields: draft.fields,
        resumeDocId: ctx.documents.primaryResume()?.id ?? null,
        error: notes.length ? notes.join(' ') : null
      })
      ctx.events.add(
        'prepared',
        `Prepared an application for ${j.title} at ${j.company}.${flagged ? ` ${flagged === 1 ? 'One answer needs' : `${flagged} answers need`} you.` : ''}`,
        jobId,
        { costUsd: draft.costUsd, formSource: draft.formSource }
      )
      ctx.jobs.resetPrepareFailures(jobId)
      changed(updated)
      return updated
    } catch (err) {
      const status = ctx.applications.get(app.id)?.status
      if (!existing && (status === 'draft' || status === 'withdrawn')) {
        // Nothing was written, so drop the empty application. A job dismissed meanwhile stays dismissed.
        ctx.applications.delete(app.id)
        ctx.jobs.moveStage(jobId, previousStage === 'preparing' ? 'shortlisted' : previousStage, ['preparing'])
      } else if (existing && status === 'draft') {
        ctx.applications.update(app.id, { status: existing.status === 'draft' ? 'needs_attention' : existing.status, error: (err as Error).message })
      }
      // Only a model that refused or answered unreadably counts against the job. A limit, a missing AI setup
      // and a provider that is down or unreachable are not its fault, so a later run tries it again.
      if (isJobFault(err)) {
        // Runs stop retrying a job after two of these. The Prepare button still works.
        ctx.jobs.recordPrepareFailure(jobId)
        ctx.events.add('error', `Couldn't prepare ${j.title} at ${j.company}. ${(err as Error).message}`, jobId)
      }
      deps.emit('jobs:changed', { jobIds: [jobId] })
      throw err
    }
  }

  /**
   * Saves an edit and moves the status between ready and needs_attention when the edit settled or reopened a flag.
   * An edited letter is checked again, and a letter that fails the check keeps the application in needs_attention
   * with a note that names the top issue. Only an edit that passes the check frees it.
   */
  function saveEdit(app: Application, patch: Parameters<typeof ctx.applications.update>[1]): Application {
    const settings = ctx.settings.get()
    const letterText = patch.coverLetter !== undefined ? patch.coverLetter : app.coverLetter
    let lint = patch.coverLetterLint
    if (lint === undefined && patch.coverLetter !== undefined) {
      // An edited letter is checked like a written one: the terms its posting and the profile use in a plain sense are
      // allowed, and it is held against the posting and the profile. Only an edit that is grounded and passes frees it.
      const posting = ctx.jobs.get(app.jobId)
      const writing = posting ? jobWritingContext(posting, ctx.profile.get().profile) : null
      const options = writing ? coverLetterLintOptions({ settings }, null, writing.allowedTerms, { source: writing.grounding, kind: 'letter' }) : coverLetterLintOptions({ settings })
      lint = patch.coverLetter.trim() ? lintText(patch.coverLetter, options) : null
    }
    const check: LetterCheck = { lint: lint !== undefined ? lint : app.coverLetterLint, minLintScore: settings.writing.minLintScore }
    // A held letter is left off an optional upload, and put back once an edit makes it pass.
    const answers = syncOptionalLetterUploads(app.formFields, patch.answers ?? app.answers, letterText, letterHeld(check))
    const next = patch.status === undefined ? statusAfterEdit(app, answers, letterText, check) : null
    const held = Boolean(letterText?.trim()) && letterHeld(check) && letterInUse(app.formFields, answers)
    const out: Parameters<typeof ctx.applications.update>[1] = { ...patch, ...(lint !== undefined ? { coverLetterLint: lint } : {}) }
    if (patch.answers !== undefined || answers !== app.answers) out.answers = answers
    if (next) out.status = next
    if (next === 'ready') {
      out.error = null
    } else if (held && (next === 'needs_attention' || (next === null && app.status === 'needs_attention' && app.submitMode === null && app.submitClickedAt === null && (!app.error || app.error.startsWith(HELD_LETTER_NOTE))))) {
      out.error = heldLetterNote(check)
    } else if (!held && app.error?.startsWith(HELD_LETTER_NOTE)) {
      out.error = null
    }
    return ctx.applications.update(app.id, out)
  }

  /** Fills (and in auto mode submits) an application in the visible browser. */
  async function submit(applicationId: string, mode: 'assist' | 'auto', by: 'user' | 'autopilot'): Promise<SubmitResult> {
    const app = application(applicationId)
    if (app.status === 'submitted') return { ok: true, status: 'submitted', message: 'Already submitted.', screenshotPath: app.screenshotPath }
    if (app.status === 'withdrawn') return { ok: false, status: 'withdrawn', message: 'This application was withdrawn.', screenshotPath: null }
    if (mode === 'auto' && app.submitClickedAt) {
      // A click with no confirmation may still have gone through. A second click could send it twice.
      const when = new Date(app.submitClickedAt).toLocaleString()
      return {
        ok: false,
        status: app.status,
        message: `The app already clicked Submit on this application (${when}) and saw no confirmation, so it won't click again. Check your email or the company's site. If it went through, mark it as submitted. If not, open it and send it yourself.`,
        screenshotPath: null
      }
    }
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
    ctx.applications.update(app.id, { status: 'submitting', submitMode: mode, lastAttemptBy: by, error: null, resumeDocId: ctx.documents.primaryResume()?.id ?? null })
    changed(app)

    let result
    try {
      result = await runSubmission(
        {
          browser,
          settings,
          answerDeps: answerDeps(),
          renderCoverLetter: (text) => renderLetter(text, j.company, app.id),
          screenshotsDir: deps.paths.screenshotsDir,
          // A letter written during the live fill is kept with the application, so Review and the PDF show the same text.
          saveCoverLetter: (text) => ctx.applications.update(app.id, { coverLetter: text }),
          recordSubmitClick: (at) => {
            if (at === null) {
              ctx.applications.update(app.id, { submitClickedAt: null })
              return true
            }
            // Last check before the click. The fill can take a minute, and the user may have
            // dismissed the job, edited the application or paused autopilot meanwhile. The settings are read again here
            // because the run holds a copy from when it started.
            if (by === 'autopilot') {
              const { autopilot } = ctx.settings.get()
              if (!autopilot.enabled || !autopilot.autoSubmit || autopilot.dryRun) return false
            }
            const now = ctx.applications.get(app.id)
            const stage = now ? ctx.jobs.get(now.jobId)?.stage : null
            if (!now || now.status !== 'submitting' || stage === 'dismissed' || stage === 'closed') return false
            ctx.applications.update(app.id, { submitClickedAt: at })
            // Write it to disk now, so a crash right after the click can't lose it.
            ctx.db.flush()
            return true
          }
        },
        j,
        // A draft saved before a letter was held can still attach it to an optional upload. Leave it off.
        { ...app, answers: syncOptionalLetterUploads(app.formFields, app.answers, app.coverLetter, letterHeld({ lint: app.coverLetterLint, minLintScore: settings.writing.minLintScore })) },
        mode,
        by
      )
    } catch (err) {
      const message = `Couldn't open or fill the form. ${(err as Error).message.split('\n')[0]}`
      const latest = ctx.applications.get(app.id)
      if (by === 'autopilot' && latest && !latest.submitClickedAt) {
        // No click happened, so nothing was sent. One failure here, such as a browser that would not start or
        // a site that would not load, must not take the application out of the queue for good.
        inFlight.delete(app.id)
        if (err instanceof BudgetExceededError || err instanceof RateLimitedError) {
          const note =
            err instanceof OutOfCreditsError
              ? 'Paused because the AI provider is out of credits.'
              : err instanceof BudgetExceededError
                ? 'Paused because the AI budget is used up.'
                : "Paused because the AI provider's limit was reached."
          changed(ctx.applications.update(app.id, { status: 'ready', submitMode: null, error: `${note} It is tried again on a later run.` }))
          throw err
        }
        const failures = latest.submitFailures + 1
        const gaveUp = failures >= MAX_SUBMIT_FAILURES
        const failed = ctx.applications.update(app.id, {
          status: gaveUp ? 'needs_attention' : 'ready',
          // Nobody had the tab, so the application can go back to ready once whatever stopped it is fixed.
          submitMode: null,
          submitFailures: failures,
          error: gaveUp ? `${message} It failed ${failures} times, so autopilot left it for you.` : message
        })
        changed(failed)
        // The run logs the failure and counts failures in a row.
        throw err
      }
      const updated = ctx.applications.update(app.id, { status: 'needs_attention', error: message })
      ctx.events.add('submit_failed', `${j.title} at ${j.company}: ${message}`, j.id)
      changed(updated)
      inFlight.delete(app.id)
      return { ok: false, status: 'needs_attention', message, screenshotPath: null }
    }

    // Answers edited in Review while the browser was open stay. Only answers for fields first seen
    // on the live form are added.
    const stored = ctx.applications.get(app.id) ?? app
    // An unattended attempt that clicked nothing and closed its tab leaves nothing open, so a later edit may make it ready again.
    const closedUnclicked = by === 'autopilot' && !result.completion && result.status !== 'submitted' && !stored.submitClickedAt
    const updated = ctx.applications.update(app.id, {
      status: result.status,
      answers: addNew(stored.answers, result.answers, (a) => a.fieldKey),
      formFields: addNew(stored.formFields, result.formFields, (f) => f.key),
      screenshotPath: result.screenshotPath ?? undefined,
      confirmation: result.confirmation ?? undefined,
      // Autopilot's dry run leaves the application in the queue, marked so the same form isn't filled again.
      ...(result.dryRun ? { submitMode: null, dryRunAt: new Date().toISOString() } : {}),
      ...(closedUnclicked ? { submitMode: null } : {}),
      ...(result.status === 'submitted' ? { submitFailures: 0 } : {}),
      error: result.ok && !result.dryRun ? null : result.message
    })
    // The watcher keeps adding to the same list as later pages appear.
    const savedAnswerCount = result.answers.length
    if (result.status === 'submitted') {
      ctx.events.add('submitted', `Submitted the application to ${j.company} for ${j.title}${by === 'autopilot' ? ' automatically' : ''}.`, j.id)
    } else if (result.status === 'needs_attention') {
      ctx.events.add('submit_failed', `${j.title} at ${j.company}: ${result.message}`, j.id)
    }
    changed(updated)

    // Keep watching the browser in the background and record the submission when it happens.
    if (!result.completion) inFlight.delete(app.id)
    result.completion?.finally(() => inFlight.delete(app.id)).catch(() => {})
    result.completion?.then(({ confirmed, screenshotPath, answers, formFields }) => {
      const current = ctx.applications.get(app.id)
      if (!current || current.status === 'submitted') return
      // Keep the answers written for pages that appeared after the first one.
      if (answers.length > savedAnswerCount) {
        ctx.applications.update(app.id, { answers: addNew(current.answers, answers, (a) => a.fieldKey), formFields: addNew(current.formFields, formFields, (f) => f.key) })
      }
      if (confirmed) {
        const done = ctx.applications.update(app.id, { status: 'submitted', screenshotPath: screenshotPath ?? undefined, confirmation: 'Confirmation page seen', submitFailures: 0, error: null })
        ctx.events.add('submitted', `Submitted the application to ${j.company} for ${j.title}.`, j.id)
        changed(done)
      } else if (current.submitClickedAt && (current.status === 'submitting' || current.status === 'needs_attention')) {
        // The app clicked Submit and never saw a confirmation, so the person has to check.
        const back = ctx.applications.update(app.id, {
          status: 'needs_attention',
          error: "No confirmation page was seen. If you submitted it, click \"I submitted it myself\". Otherwise open it again."
        })
        changed(back)
      } else if (current.status === 'submitting') {
        // The person was filling it in themselves and the watcher ended without a confirmation. The app
        // recorded no click, so it does not say it clicked. The status still moves on, so the application
        // is not stuck as open in the browser.
        changed(
          ctx.applications.update(app.id, {
            status: 'needs_attention',
            error: 'The browser window closed before a confirmation page appeared. If you submitted it, click "I submitted it myself". Otherwise open it again.'
          })
        )
      }
      // A needs_attention application without a click keeps the reason it already has.
    }, () => {})

    return { ok: result.ok, status: result.status, message: result.message, screenshotPath: result.screenshotPath }
  }

  pipeline.setHooks({
    prepare: async (jobId) => {
      await prepare(jobId)
    },
    submit: (applicationId) => submit(applicationId, 'auto', 'autopilot')
  })
  const changeListeners = new Set<() => void>()
  const notifyChange = (): void => {
    for (const listener of changeListeners) listener()
  }
  scheduler.onChange(notifyChange)
  scheduler.start()

  const updater = deps.updates
    ? new Updater({
        ...deps.updates,
        currentVersion: deps.appVersion,
        emit: (status) => deps.emit('update:status', status),
        isAutoCheckOn: () => ctx.settings.get().updates.autoCheck,
        beforeInstall: () => shutdown()
      })
    : null
  updater?.start()
  const noUpdater = (): UpdateStatus => ({
    state: 'disabled',
    currentVersion: deps.appVersion,
    version: null,
    percent: null,
    checkedAt: null,
    message: 'Updates work only in the installed app.',
    downloadUrl: null
  })

  const insideDataDir = (p: string) => {
    const rel = path.relative(deps.paths.dataDir, path.resolve(p))
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  /** Adds boards as watched companies. A board that is already known keeps its settings. */
  const addBoards = (boards: Array<{ ats: AtsKind; token: string; name: string | null }>, origin: CompanyOrigin): BoardAddCounts => {
    return ctx.db.transaction(() => {
      let added = 0
      let skipped = 0
      for (const b of boards) {
        if (!b.token || !canReadBoard(b.ats) || ctx.companies.findByAts(b.ats, b.token)) {
          skipped += 1
          continue
        }
        const company = ctx.companies.save({
          name: b.name?.trim() || prettifyToken(b.token) || b.token,
          ats: b.ats,
          atsToken: b.token,
          careersUrl: boardUrl(b.ats, b.token) ?? undefined,
          watch: true,
          origin
        })
        ctx.boards.ensureState(company.id, origin)
        added += 1
      }
      return { added, skipped }
    })
  }

  const api: Api = {
    // App
    async getAppInfo() {
      return { version: deps.appVersion, dataDir: deps.paths.dataDir, platform: process.platform, secureKeyStorage: deps.vault.secure, openAtLogin: deps.openAtLogin?.() ?? null }
    },
    async openExternal(url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened.')
      await shell.openExternal(url)
    },
    async openPath(p) {
      // Only files the app created, such as screenshots and cover letter PDFs.
      if (!insideDataDir(p)) throw new Error('That file is outside the jobpls data folder.')
      const err = await shell.openPath(p)
      if (err) throw new Error(err)
    },
    async exportDatabase() {
      const win = BrowserWindow.getFocusedWindow()
      const defaultPath = path.join(deps.paths.exportsDir, `jobpls-backup-${new Date().toISOString().slice(0, 10)}.sqlite`)
      const opts = { defaultPath, filters: [{ name: 'SQLite database', extensions: ['sqlite'] }] }
      const res = win ? await dialog.showSaveDialog(win, opts) : { canceled: false, filePath: defaultPath }
      if (res.canceled || !res.filePath) return null
      try {
        const written = exportDatabaseCopy(ctx.db, deps.paths.dbFile, res.filePath)
        log.write('info', 'Database copy written.')
        return written
      } catch (err) {
        log.write('error', `Database copy failed. ${(err as Error).message}`)
        throw err
      }
    },
    async exportData() {
      const win = BrowserWindow.getFocusedWindow()
      const defaultPath = path.join(deps.paths.exportsDir, `jobpls-export-${new Date().toISOString().slice(0, 10)}.json`)
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
      const previous = ctx.settings.get()
      const whole = (value: unknown, min: number, max: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined)
      // Limits for continuous mode. A value that is not a number is left as it was.
      if (patch.autopilot) {
        const { mode } = patch.autopilot
        patch = {
          ...patch,
          autopilot: {
            ...patch.autopilot,
            mode: mode === 'interval' || mode === 'continuous' ? mode : undefined,
            submitConcurrency: whole(patch.autopilot.submitConcurrency, 1, 3),
            hourlySubmitCap: whole(patch.autopilot.hourlySubmitCap, 0, 10_000)
          }
        }
      }
      if (patch.budget) {
        patch = {
          ...patch,
          budget: { ...patch.budget, maxTriagePerDay: whole(patch.budget.maxTriagePerDay, 0, 1_000_000), maxPreparePerDay: whole(patch.budget.maxPreparePerDay, 0, 1_000_000) }
        }
      }
      if (patch.preferences) {
        patch = { ...patch, preferences: { ...patch.preferences, perCompanyLimit: whole(patch.preferences.perCompanyLimit, 1, 100) } }
      }
      if (patch.discovery) {
        patch = {
          ...patch,
          discovery: {
            ...patch.discovery,
            maxWatchedBoards: whole(patch.discovery.maxWatchedBoards, 0, 100_000),
            boardsPerRun: whole(patch.discovery.boardsPerRun, 1, 20_000)
          }
        }
      }
      const next = ctx.settings.update(patch)
      // Pausing autopilot stops a batch run after its current step. A send already under way is refused at the click.
      if (previous.autopilot.enabled && !next.autopilot.enabled) pipeline.cancel()
      // Jobs already scored move across the new shortlist line and get the matching fit label.
      if (next.thresholds.shortlistScore !== previous.thresholds.shortlistScore) restageForShortlist(ctx)
      // A different scoring model deserves another try at jobs the old one failed on.
      if (JSON.stringify(next.routing.triage) !== JSON.stringify(previous.routing.triage)) ctx.jobs.resetAllTriageFailures()
      // The same for drafts: new models may handle the jobs the old ones refused.
      if (JSON.stringify(next.routing) !== JSON.stringify(previous.routing)) {
        ctx.jobs.resetAllPrepareFailures()
        // A model that was missing may be what the loop paused for.
        if (loop.isRunning()) loop.wake()
      }
      // Starts or stops the work loop when the mode changed, and wakes it so a new model, budget or cap applies at once.
      scheduler.reschedule()
      // The listeners apply the login item first, so a window that reloads the app info sees the new state.
      notifyChange()
      deps.emit('settings:changed', next)
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
      const saved = await ctx.providers.save(input)
      ctx.llm.resetClients()
      // A fixed key or address may be what those jobs were waiting for.
      ctx.jobs.resetAllTriageFailures()
      ctx.jobs.resetAllPrepareFailures()
      // A loop paused for a missing model or key starts again.
      if (loop.isRunning()) loop.wake()
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
      // A resume is attached to applications as it is, so only formats an application form takes are allowed.
      if (input.kind === 'resume') {
        const ext = input.filePath ? path.extname(input.filePath).toLowerCase() : ''
        if (!['.pdf', '.docx'].includes(ext)) {
          throw new Error(`A resume has to be a PDF or Word (.docx) file, because it is attached to applications. ${input.filePath ? `This file ends in ${ext || 'nothing'}.` : 'Choose a file.'}`)
        }
      }
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
      if (doc.kind === 'resume') refreshResumeAnswers()
      if (doc.kind === 'portfolio' && doc.url) {
        // The first portfolio link fills an empty profile field, so forms that ask for a portfolio get an answer.
        const profile = ctx.profile.get().profile
        if (!profile.links.portfolio.trim()) ctx.profile.save({ ...profile, links: { ...profile.links, portfolio: doc.url } })
      }
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
      if (doc?.kind === 'resume') refreshResumeAnswers()
      // A sent application recorded this resume. The record leaves the list, but the file stays so the application can still be traced to it.
      const referenced = doc?.kind === 'resume' && ctx.applications.countUsingResume(id) > 0
      if (doc?.filePath && insideDataDir(doc.filePath) && !referenced) fs.rmSync(doc.filePath, { force: true })
    },
    async setPrimaryResume(id) {
      ctx.documents.setPrimary(id)
      refreshResumeAnswers()
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
    async listCompanies(query) {
      return ctx.companies.listPage(query)
    },
    async saveCompany(input) {
      let patch = input
      if (input.careersUrl && (!input.ats || input.ats === 'unknown')) {
        const found = detectAts(input.careersUrl)
        if (found) patch = { ...input, ats: found.ats, atsToken: input.atsToken ?? found.token ?? undefined, name: input.name ?? found.companyName ?? undefined }
      }
      const before = input.id ? ctx.companies.get(input.id) : null
      const saved = ctx.companies.save(patch)
      // A company that just became watched gets its first board check on the next run.
      if (saved.watch && !before?.watch && saved.atsToken && saved.ats !== 'unknown') ctx.boards.ensureState(saved.id, saved.origin)
      return saved
    },
    async deleteCompany(id) {
      ctx.companies.delete(id)
    },
    async bulkCompanies({ ids, action }) {
      return ctx.db.transaction(() => {
        const { changed, started, rewatched } = ctx.companies.bulk(Array.isArray(ids) ? ids : [], action)
        // A board that is watched again starts clean and is checked soon.
        for (const c of started) ctx.boards.ensureState(c.id, c.origin)
        for (const c of rewatched) ctx.boards.resetFailures(c.id)
        return { changed }
      })
    },
    async addStarterPack(group) {
      return addBoards(starterPack(group === 'all' ? undefined : group), 'starter')
    },
    async parseBoardImport(text) {
      return parseBoardList(String(text ?? ''))
    },
    async probeBoards(entries, token) {
      if (!Array.isArray(entries)) return []
      if (entries.length > MAX_PROBE_ENTRIES) throw new Error(`Check at most ${MAX_PROBE_ENTRIES} boards at a time.`)
      const results: BoardProbe[] = []
      for (const entry of entries) {
        const probe = await probeBoard(entry.ats, entry.token)
        const result: BoardProbe = { ats: entry.ats, token: entry.token, ...probe }
        results.push(result)
        deps.emit('boards:probe', { token, done: results.length, total: entries.length, result })
      }
      return results
    },
    async importBoards(entries) {
      return addBoards(Array.isArray(entries) ? entries : [], 'import')
    },
    async detectAts(url) {
      return detectAts(url)
    },
    async addJobByUrl(url) {
      const added = ingestJob(ctx, await fetchJobByUrl(url))
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
      // Saving the application is a person looking at its answers, so answers filled on the live form count as reviewed.
      // Marking it ready counts the same way.
      const reviewed = patch.answers ?? (patch.status === 'ready' ? before.answers : undefined)
      if (reviewed) patch = { ...patch, answers: reviewed.map(({ liveOnly: _liveOnly, ...a }) => a) }
      const edited = patch.answers !== undefined || patch.coverLetter !== undefined
      const updated = edited ? saveEdit(before, patch) : ctx.applications.update(id, patch)
      if (patch.outcome && patch.outcome !== before.outcome) {
        ctx.events.add('outcome', `${updated.company} moved to ${OUTCOME_LABEL[patch.outcome]}.`, updated.jobId, { outcome: patch.outcome })
      }
      changed(updated)
      return updated
    },
    async regenerateAnswer(applicationId, fieldKey, guidance) {
      const app = application(applicationId)
      assertEditable(app)
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
      // Read it again: the user may have edited other answers while the AI was writing this one.
      const latest = application(applicationId)
      assertEditable(latest)
      const answers = latest.answers.some((a) => a.fieldKey === fieldKey) ? latest.answers.map((a) => (a.fieldKey === fieldKey ? fresh : a)) : [...latest.answers, fresh]
      changed(saveEdit(latest, { answers }))
      return fresh
    },
    async regenerateCoverLetter(applicationId, guidance) {
      const app = application(applicationId)
      assertEditable(app)
      const j = job(app.jobId)
      const deps2 = answerDeps()
      // A letter pasted into a text box with a character limit is written to fit the smallest one.
      const limits = app.formFields.filter((f) => (f.type === 'textarea' || f.type === 'text') && isCoverLetterField(f) && f.maxLength != null).map((f) => f.maxLength as number)
      const maxChars = limits.length ? Math.min(...limits) : null
      const written = await writeCoverLetter(ctx.llm, { profile: deps2.profile, samples: deps2.samples, settings: deps2.settings }, j, { guidance, regenerate: true, maxChars })
      if (written.needsInput) throw new Error(`The cover letter needs your input: ${written.needsInput}`)
      // Read it again so edits made while the letter was being written are kept.
      const latest = application(applicationId)
      assertEditable(latest)
      // A cover letter pasted into a form field follows the new letter too.
      const minLintScore = deps2.settings.writing.minLintScore
      // A letter that is less grounded is held like one the style check rejects.
      const passes = lettersCheckPasses(written.lint, minLintScore)
      const answers = latest.answers.map((a) => {
        if (!isCoverLetterField({ key: a.fieldKey, label: a.label, type: a.type, required: a.required, options: [], placeholder: null, maxLength: null, fileHint: null }) || (a.type !== 'textarea' && a.type !== 'text')) return a
        // A letter that is too long for this box is not saved into it. The box is flagged, as when the application was drafted.
        const max = latest.formFields.find((f) => f.key === a.fieldKey)?.maxLength ?? null
        if (max !== null && written.text.length > max) {
          const size = `The cover letter is ${written.text.length} characters and this box takes ${max}.`
          return { ...a, value: '', needsUser: a.required, confidence: 0, lint: null, note: a.required ? `${size} Write a shorter one.` : `${size} This box is optional, so jobpls left it blank.` }
        }
        return { ...a, value: written.text, needsUser: false, confidence: passes ? 0.9 : 0.6, lint: written.lint, note: passes ? (a.note?.startsWith(HELD_LETTER_NOTE) ? null : a.note) : `${HELD_LETTER_NOTE} ${failureReason(written.lint, minLintScore)}` }
      })
      // Through saveEdit, so a new letter moves the status. A letter that fails the check holds the application back.
      const updated = saveEdit(latest, { coverLetter: written.text, coverLetterLint: written.lint, answers })
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
      return renderLetter(app.coverLetter, app.company, app.id)
    },

    // Review
    async listExceptions() {
      return buildExceptions(ctx.applications)
    },
    async answerGroup({ key, value, saveToBank, wordings }) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Write an answer first.')
      if (!Array.isArray(wordings)) throw new Error('Reload the Review page and try again.')
      // The answer goes only to questions the person saw. A wording that joined the group since is left for them.
      const seen = new Set(wordings.map((w) => wordingKey(String(w))))
      const group = groupNeedsYou(ctx.applications.reviewRows(['ready', 'needs_attention'])).find((g) => g.key === key)
      if (!group) return { updated: 0, ready: 0, skipped: 0 }
      const touched: Application[] = []
      let skipped = 0
      let ready = 0
      ctx.db.transaction(() => {
        for (const id of new Set(group.applications.map((a) => a.id))) {
          const app = ctx.applications.get(id)
          const appJob = app ? ctx.jobs.get(app.jobId) : null
          // A closed posting is not reopened by answering a question.
          if (!app || inFlight.has(id) || (app.status !== 'ready' && app.status !== 'needs_attention') || appJob?.stage === 'closed') {
            skipped += 1
            continue
          }
          let changedAny = false
          const answers = app.answers.map((a) => {
            // Only answers that still need the person, and only where the form accepts the value.
            // The job is passed so a salary question with no currency in its label keys by the job's currency, as the group did.
            const groupJob = { jobId: app.jobId, salaryCurrency: appJob?.salaryCurrency ?? null, location: appJob?.location ?? null }
            if (!answerNeedsUser(a) || groupKeyFor(a.label, a, groupJob).key !== key || !seen.has(wordingKey(a.label)) || !acceptsValue(a, value)) return a
            changedAny = true
            const { liveOnly: _liveOnly, ...rest } = a
            return { ...rest, value, source: 'user' as const, confidence: 1, needsUser: false, note: null }
          })
          if (!changedAny) {
            skipped += 1
            continue
          }
          const next = saveEdit(app, { answers })
          if (next.status === 'ready') ready += 1
          touched.push(next)
        }
        if (saveToBank && touched.length > 0) {
          // The same question saved before is updated instead of added twice.
          const norm = normalizeQuestion(group.label)
          const known = ctx.answers.list().find((e) => normalizeQuestion(e.question) === norm)
          const longAnswer = group.type === 'textarea' || (group.topic !== null && COMPANY_SPECIFIC_TOPICS.includes(group.topic))
          ctx.answers.save({ id: known?.id, question: group.label, answer: value, kind: longAnswer ? 'template' : 'fact', topic: group.topic, scope: group.scope })
        }
      })
      if (touched.length > 0) {
        deps.emit('applications:changed', { applicationIds: touched.map((a) => a.id) })
        deps.emit('jobs:changed', { jobIds: touched.map((a) => a.jobId) })
      }
      return { updated: touched.length, ready, skipped }
    },
    async retryLater(ids) {
      const touched: Application[] = []
      ctx.db.transaction(() => {
        for (const id of new Set(Array.isArray(ids) ? ids : [])) {
          const app = ctx.applications.get(id)
          // An answer that still needs the person keeps the application out of the queue.
          if (!app || inFlight.has(id) || app.answers.some(answerNeedsUser)) continue
          // A held cover letter is released only by an edit that passes the style check.
          if (Boolean(app.coverLetter?.trim()) && letterHeld({ lint: app.coverLetterLint, minLintScore: ctx.settings.get().writing.minLintScore }) && letterInUse(app.formFields, app.answers)) continue
          // A closed posting stays closed, and a form a person had open may have been sent by hand.
          if (ctx.jobs.get(app.jobId)?.stage === 'closed' || !canRetryLater({ ...app, lastAttemptBy: ctx.applications.lastAttemptBy(id) })) continue
          touched.push(ctx.applications.update(id, { status: 'ready', submitMode: null, submitFailures: 0, error: null }))
        }
      })
      if (touched.length > 0) {
        deps.emit('applications:changed', { applicationIds: touched.map((a) => a.id) })
        deps.emit('jobs:changed', { jobIds: touched.map((a) => a.jobId) })
      }
      return { updated: touched.length, skipped: (Array.isArray(ids) ? new Set(ids).size : 0) - touched.length }
    },
    async reportWrongSubmission(id, note) {
      const app = application(id)
      const text = String(note ?? '').trim().slice(0, 300)
      if (!text) throw new Error('Write one line about what was wrong.')
      // Pause first, so nothing else goes out while the report is written.
      await api.updateSettings({ autopilot: { autoSubmit: false } })
      changed(ctx.applications.update(id, { error: text }))
      ctx.events.add('submit_failed', `Auto-submit paused. You reported a wrong submission to ${app.company} for ${app.title}. ${text}`, app.jobId)
    },

    // Pipeline
    async runPipeline(options) {
      if (loop.isRunning()) {
        // Continuous mode has no batch to start. Look for work now, and report today's counts.
        loop.wake(undefined, { retry: true })
        const { today } = loop.status()
        return { ...emptyStats(), ...today }
      }
      return pipeline.run(options)
    },
    async cancelPipeline() {
      pipeline.cancel()
      await loop.stop()
    },
    async getNextRunAt() {
      return scheduler.nextRunAt()
    },
    async getPipelineStatus() {
      return pipeline.status()
    },
    async getLoopStatus() {
      return loop.status()
    },
    async pauseWorker(name) {
      loop.pauseWorker(workerName(name))
    },
    async resumeWorker(name) {
      loop.resumeWorker(workerName(name))
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
    },

    // Updates
    async getUpdateStatus() {
      return updater?.getStatus() ?? noUpdater()
    },
    async checkForUpdates() {
      return updater ? updater.check() : noUpdater()
    },
    async installUpdate() {
      if (!updater) throw new Error('Updates work only in the installed app.')
      if (pipeline.status().phase !== 'idle' && !loop.isRunning()) throw new Error('A run is in progress. Restart to update after it finishes, or close jobpls to install the update then.')
      const busy = inFlight.size > 0 || ctx.applications.list({ statuses: ['draft', 'submitting'], limit: 1 }).total > 0
      if (busy) throw new Error('jobpls is preparing or sending an application. Restart to update after it finishes.')
      await updater.install()
    }
  }

  // Runs once. Closing the app and installing an update can both ask for it.
  let closing: Promise<void> | null = null
  const shutdown: Shutdown = () => (closing ??= closeDown())
  const closeDown = async (): Promise<void> => {
    if (active === ctx) active = null
    updater?.stop()
    const loopStopped = scheduler.stop()
    pipeline.cancel()
    // The workers end after their current step, which the stop signal cuts short. Don't wait long for them.
    await Promise.race([loopStopped.catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
    // Save first, so nothing is lost if closing the browser hangs.
    ctx.db.flush()
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
    ctx.close()
  }

  const controls: BackgroundControls = {
    settings: () => ctx.settings.get(),
    updateSettings: (patch) => api.updateSettings(patch),
    isRunning: () => pipeline.isRunning(),
    progress: () => pipeline.status(),
    nextRunAt: () => scheduler.nextRunAt(),
    loopStatus: () => (loop.isRunning() ? loop.status() : null),
    async runNow() {
      if (loop.isRunning()) {
        loop.wake(undefined, { retry: true })
        return
      }
      if (pipeline.isRunning()) return
      const { autopilot } = ctx.settings.get()
      try {
        // Sending applications stays tied to autopilot being on, so a paused autopilot never sends from the tray.
        await pipeline.run({ discover: true, triage: true, prepare: autopilot.autoPrepare, submit: autopilot.enabled && autopilot.autoSubmit, trigger: 'manual' })
      } catch {
        // The run already wrote its failure to the activity log.
      }
      scheduler.reschedule()
    },
    resume: () => scheduler.resume(),
    companyFor: (jobId) => ctx.jobs.get(jobId)?.company ?? null,
    onChange: (listener) => void changeListeners.add(listener)
  }

  return { api, ctx, shutdown, controls }
}

export async function registerIpc(deps: IpcDeps): Promise<{ shutdown: Shutdown; controls: BackgroundControls }> {
  const { api, shutdown, controls } = await createServices(deps)
  deps.ipcMain.handle('api', async (event, method: string, args: unknown[]) => {
    if (!deps.isTrustedSender(event)) {
      return { ok: false, error: 'Calls are only accepted from the jobpls window.', name: 'Forbidden' }
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
  return { shutdown, controls }
}
