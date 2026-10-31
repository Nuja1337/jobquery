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
  Company,
  CompanyInput,
  DocumentInput,
  DocumentKind,
  DocumentRecord,
  EventRecord,
  EventType,
  Job,
  JobQuery,
  JobSummary,
  LintReport,
  PipelineProgress,
  PreferenceSuggestion,
  PreparedAnswer,
  Profile,
  ProfileRecord,
  ProviderInfo,
  ProviderInput,
  RunOptions,
  RunRecord,
  RunStats,
  SavedSearch,
  Settings,
  SubmitMode,
  SubmitResult,
  UsageSummary
} from './types'

export type DeepPartial<T> = T extends Array<infer _U>
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export interface AppInfo {
  version: string
  dataDir: string
  platform: string
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
  listCompanies(): Promise<Company[]>
  saveCompany(input: CompanyInput & { id?: string }): Promise<Company>
  deleteCompany(id: string): Promise<void>
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

  // Pipeline
  runPipeline(options: RunOptions): Promise<RunStats>
  cancelPipeline(): Promise<void>
  getPipelineStatus(): Promise<PipelineProgress>
  listRuns(limit: number): Promise<RunRecord[]>
  listEvents(query: { limit: number; types?: EventType[]; jobId?: string }): Promise<EventRecord[]>
  /** Filter changes suggested by the jobs you dismissed. Accepting one calls updateSettings. */
  listSuggestions(): Promise<PreferenceSuggestion[]>
  /** Hides a suggestion so it isn't offered again. */
  dismissSuggestion(id: string): Promise<void>

  // Analytics
  getAnalytics(rangeDays: number): Promise<AnalyticsReport>
  getUsage(): Promise<UsageSummary>
}

export type ApiMethod = keyof Api

/** Events pushed from main to renderer. */
export interface PushEvents {
  'pipeline:progress': PipelineProgress
  'event:new': EventRecord
  'jobs:changed': { jobIds: string[] }
  'applications:changed': { applicationIds: string[] }
}

export type PushChannel = keyof PushEvents

export interface Bridge {
  call<M extends ApiMethod>(method: M, ...args: Parameters<Api[M]>): ReturnType<Api[M]>
  on<C extends PushChannel>(channel: C, listener: (payload: PushEvents[C]) => void): () => void
}
