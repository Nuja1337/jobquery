// The contract between the renderer and the main process.
// The renderer calls these through window.api (see src/preload/index.ts).
// The main process implements every method in src/main/ipc.ts.

import type {
  AnalyticsReport,
  AnswerBankEntry,
  Application,
  ApplicationPatch,
  ApplicationQuery,
  ApplicationSummary,
  AtsDetection,
  AtsKind,
  Company,
  CompanyInput,
  CompanyOrigin,
  DocumentInput,
  DocumentKind,
  DocumentRecord,
  EventRecord,
  EventType,
  Job,
  JobQuery,
  JobSummary,
  LintReport,
  LoopStatus,
  PipelineProgress,
  PreferenceSuggestion,
  PreparedAnswer,
  Profile,
  ProfileRecord,
  ProviderInfo,
  ProviderInput,
  RunOptions,
  RunRecord,
  ReviewExceptions,
  RunStats,
  SavedSearch,
  Settings,
  SubmitMode,
  SubmitResult,
  UpdateStatus,
  UsageSummary,
  WorkerName
} from './types'

/** Which companies the Sources page lists. A blocked company never counts as watched. */
export type CompanyStateFilter = 'all' | 'watched' | 'unwatched' | 'blocked' | 'stopped' | 'failing'

export interface CompanyQuery {
  /** Starts at 1. */
  page?: number
  /** Defaults to 50, at most 200. */
  pageSize?: number
  /** Matches the name or the board token. */
  search?: string
  ats?: AtsKind | 'all'
  origin?: CompanyOrigin | 'all'
  /**
   * stopped: not watched, with a board state that has 5 or more failures in a row.
   * failing: watched, with 1 to 4 failures in a row.
   */
  state?: CompanyStateFilter
}

/** A company with what the last board checks found. The board fields are empty until a board state exists. */
export interface CompanyWithBoard extends Company {
  lastCheckedAt: string | null
  nextCheckAt: string | null
  intervalMinutes: number | null
  failures: number
  lastError: string | null
  liveJobs: number
  relevantJobs: number
}

/** Totals over all companies, whatever the filters say. */
export interface CompanyCounts {
  total: number
  watched: number
  blocked: number
  fromPostings: number
  stopped: number
  failing: number
  /** Open postings on watched boards. */
  liveJobs: number
  /** Postings on watched boards that are shortlisted or further. */
  relevantJobs: number
  /** The soonest next check among watched boards the app can read, or null. */
  nextCheckAt: string | null
}

export interface CompanyPage {
  items: CompanyWithBoard[]
  /** Companies matching the filters, over all pages. */
  total: number
  counts: CompanyCounts
}

export type BulkCompanyAction = 'watch' | 'unwatch' | 'block' | 'unblock' | 'delete'

/** One line of a pasted list, read but not yet checked on the network. */
export type BoardImportLine = { ats: AtsKind; token: string; name: string | null; line: string } | { line: string; error: string }

export interface BoardRef {
  ats: AtsKind
  token: string
}

/** What checking one board found. */
export type BoardProbe = BoardRef & ({ ok: true; name: string | null; jobs: number } | { ok: false; error: string })

export interface BoardAddCounts {
  added: number
  skipped: number
}

export type DeepPartial<T> = T extends Array<infer _U>
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export interface AppInfo {
  version: string
  dataDir: string
  platform: string
  /**
   * False when the operating system offers no real key store (or, on Linux, only the "basic_text"
   * fallback). API keys are then only obscured on disk, and the UI should say so.
   */
  secureKeyStorage: boolean
  /**
   * Whether Windows will start jobpls at sign-in right now. Null when the app can't register
   * itself, as in development or on a system without this feature.
   */
  openAtLogin: boolean | null
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  models: string[]
}

export interface Api {
  // App
  getAppInfo(): Promise<AppInfo>
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  /** Writes a JSON export of all data (minus API keys) and returns its path, or null if cancelled. */
  exportData(): Promise<string | null>
  /**
   * Writes a consistent copy of the database to a file the person picks, with stored API keys and job
   * board credentials removed. Returns its path, or null if cancelled. It never writes to the live database.
   */
  exportDatabase(): Promise<string | null>

  // Settings
  getSettings(): Promise<Settings>
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  /** Drops a price override so the built-in price (or none) applies. */
  removePriceOverride(model: string): Promise<Settings>

  // AI providers
  listProviders(): Promise<ProviderInfo[]>
  saveProvider(input: ProviderInput): Promise<ProviderInfo>
  deleteProvider(id: string): Promise<void>
  testProvider(id: string): Promise<ProviderTestResult>
  listModels(providerId: string): Promise<string[]>

  // Profile and materials
  getProfile(): Promise<ProfileRecord>
  saveProfile(profile: Profile): Promise<ProfileRecord>
  /** Opens a native file picker. Returns the chosen paths. */
  pickFiles(options: { title?: string; extensions?: string[]; multiple?: boolean }): Promise<string[]>
  importDocument(input: DocumentInput): Promise<DocumentRecord>
  listDocuments(kind?: DocumentKind): Promise<DocumentRecord[]>
  getDocumentText(id: string): Promise<string>
  deleteDocument(id: string): Promise<void>
  setPrimaryResume(id: string): Promise<void>
  /** Reads a resume with the extraction model and returns a draft profile. Not saved until saveProfile. */
  extractProfileFromResume(documentId: string): Promise<Profile>
  /** Studies the user's writing samples and stores a voice profile on the profile. */
  buildVoiceProfile(): Promise<ProfileRecord>

  // Answer bank
  listAnswers(): Promise<AnswerBankEntry[]>
  saveAnswer(entry: Omit<AnswerBankEntry, 'id' | 'timesUsed' | 'updatedAt'> & { id?: string }): Promise<AnswerBankEntry>
  deleteAnswer(id: string): Promise<void>

  // Sources
  listSearches(): Promise<SavedSearch[]>
  saveSearch(search: Omit<SavedSearch, 'id' | 'lastRunAt'> & { id?: string }): Promise<SavedSearch>
  deleteSearch(id: string): Promise<void>
  /** One page of companies with their board state. With no query, the first 50 by name. */
  listCompanies(query?: CompanyQuery): Promise<CompanyPage>
  saveCompany(input: CompanyInput & { id?: string }): Promise<Company>
  deleteCompany(id: string): Promise<void>
  /** Applies one action to many companies at once. Returns how many changed. */
  bulkCompanies(input: { ids: string[]; action: BulkCompanyAction }): Promise<{ changed: number }>
  /** Watches every board in the starter pack. Boards you already have keep their settings. */
  addStarterPack(group: 'games' | 'tech' | 'all'): Promise<BoardAddCounts>
  /** Reads a pasted list of careers links, posting links and ats:token lines. Makes no requests. */
  parseBoardImport(text: string): Promise<BoardImportLine[]>
  /** Checks up to 500 boards one after another. Each result is also pushed on 'boards:probe' with the token. */
  probeBoards(entries: BoardRef[], token: string): Promise<BoardProbe[]>
  /** Watches boards that were checked. */
  importBoards(entries: Array<BoardRef & { name: string | null }>): Promise<BoardAddCounts>
  detectAts(url: string): Promise<AtsDetection | null>
  /** Fetches one posting by URL, stores it and runs it through the free filters. */
  addJobByUrl(url: string): Promise<Job>

  // Jobs
  listJobs(query: JobQuery): Promise<{ items: JobSummary[]; total: number }>
  getJob(id: string): Promise<Job | null>
  dismissJob(id: string, reason: string | null, tags: string[]): Promise<void>
  restoreJob(id: string): Promise<void>
  starJob(id: string, starred: boolean): Promise<void>
  /** Scores one job now, even if it was filtered out. */
  scoreJob(id: string): Promise<Job>
  /** Drafts the application: reads the form, writes answers and a cover letter. */
  prepareApplication(jobId: string): Promise<Application>

  // Applications
  listApplications(query: ApplicationQuery): Promise<{ items: ApplicationSummary[]; total: number }>
  getApplication(id: string): Promise<Application | null>
  getApplicationForJob(jobId: string): Promise<Application | null>
  updateApplication(id: string, patch: ApplicationPatch): Promise<Application>
  regenerateAnswer(applicationId: string, fieldKey: string, guidance: string | null): Promise<PreparedAnswer>
  regenerateCoverLetter(applicationId: string, guidance: string | null): Promise<Application>
  lintText(text: string): Promise<LintReport>
  /** assist: fill everything and leave the final click to you. auto: fill and click submit. */
  submitApplication(applicationId: string, mode: Exclude<SubmitMode, 'manual'>): Promise<SubmitResult>
  /** For applications you sent yourself outside the app. */
  markSubmitted(applicationId: string): Promise<Application>
  /** Saves the cover letter as a PDF and returns the path. */
  exportCoverLetterPdf(applicationId: string): Promise<string>

  // Review
  /** Questions many applications ask, applications that could not be sent by reason, and a sample of what was sent. */
  listExceptions(): Promise<ReviewExceptions>
  /**
   * Answers one question for every application that asks it (the `key` of a group from listExceptions).
   * `ready` counts the applications that have nothing else flagged afterwards. `skipped` counts the ones
   * whose form does not accept the answer, that are open in the browser, whose job closed, or that ask a
   * wording the person did not see. `wordings` are the questions the person saw in the group.
   */
  answerGroup(input: { key: string; value: string; saveToBank: boolean; wordings: string[] }): Promise<{ updated: number; ready: number; skipped: number }>
  /** Puts applications that failed for a passing reason back in the queue. The rest are left alone and counted as skipped. */
  retryLater(ids: string[]): Promise<{ updated: number; skipped: number }>
  /** Turns auto-submit off, logs it, and keeps the note on the application. */
  reportWrongSubmission(id: string, note: string): Promise<void>

  // Pipeline
  runPipeline(options: RunOptions): Promise<RunStats>
  cancelPipeline(): Promise<void>
  getPipelineStatus(): Promise<PipelineProgress>
  /** When autopilot runs next, as an ISO time, or null when autopilot is off. */
  getNextRunAt(): Promise<string | null>
  /** The four workers of continuous mode: what each is doing, why one is paused, and today's counts. */
  getLoopStatus(): Promise<LoopStatus>
  /** Stops one worker until resumeWorker. Only meaningful while continuous mode runs. */
  pauseWorker(name: WorkerName): Promise<void>
  /** Lifts a pause on one worker, including a pause the app set itself. */
  resumeWorker(name: WorkerName): Promise<void>
  listRuns(limit: number): Promise<RunRecord[]>
  listEvents(query: { limit: number; types?: EventType[]; jobId?: string }): Promise<EventRecord[]>
  /** Filter changes suggested by the jobs you dismissed. Accepting one calls updateSettings. */
  listSuggestions(): Promise<PreferenceSuggestion[]>
  /** Hides a suggestion so it isn't offered again. */
  dismissSuggestion(id: string): Promise<void>

  // Analytics
  getAnalytics(rangeDays: number): Promise<AnalyticsReport>
  getUsage(): Promise<UsageSummary>

  // Updates
  getUpdateStatus(): Promise<UpdateStatus>
  /**
   * Checks for a new version now, even when automatic checks are off. Resolves when the check
   * finishes. A newer version then downloads in the background, reported through 'update:status'.
   */
  checkForUpdates(): Promise<UpdateStatus>
  /**
   * Saves everything, closes the app, installs the downloaded update and opens the app again.
   * Refuses while a run is going or an application is open in the browser.
   */
  installUpdate(): Promise<void>
}

export type ApiMethod = keyof Api

/** Events pushed from main to renderer. */
export interface PushEvents {
  'pipeline:progress': PipelineProgress
  /** Continuous mode: a worker started, stopped, paused or resumed, or today's counts moved. */
  'loop:status': LoopStatus
  'event:new': EventRecord
  'jobs:changed': { jobIds: string[] }
  'applications:changed': { applicationIds: string[] }
  'update:status': UpdateStatus
  /** Settings changed outside the window, for example from the tray menu. */
  'settings:changed': Settings
  /** One board checked during probeBoards. */
  'boards:probe': { token: string; done: number; total: number; result: BoardProbe }
}

export type PushChannel = keyof PushEvents

export interface Bridge {
  call<M extends ApiMethod>(method: M, ...args: Parameters<Api[M]>): ReturnType<Api[M]>
  on<C extends PushChannel>(channel: C, listener: (payload: PushEvents[C]) => void): () => void
}
