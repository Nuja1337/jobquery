// Domain types shared by the main process (Node) and the renderer (React).
// Everything here must be plain JSON so it can cross the IPC bridge.

// ---------------------------------------------------------------------------
// AI providers and model routing
// ---------------------------------------------------------------------------

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'ollama'
  | 'openai_compatible'

/** A provider the user configured. The API key never leaves the main process. */
export interface ProviderInfo {
  id: string
  kind: ProviderKind
  label: string
  baseUrl: string | null
  hasKey: boolean
  createdAt: string
}

export interface ProviderInput {
  id?: string
  kind: ProviderKind
  label: string
  baseUrl?: string | null
  /** Only sent when the user types a new key. Omit to keep the stored one. */
  apiKey?: string
}

export interface ModelRef {
  providerId: string
  model: string
}

/** Each pipeline stage can use a different model so cheap work runs on cheap models. */
export type LlmStage =
  | 'triage' // fit scoring, high volume, cheap model
  | 'writing' // cover letters and open-ended answers, strong model
  | 'extraction' // resume parsing, form mapping, voice analysis

export type LlmTask =
  | 'triage'
  | 'cover_letter'
  | 'answers'
  | 'revise'
  | 'extract_profile'
  | 'voice'
  | 'form_map'
  | 'test'

/** Price per million tokens, used for the cost ledger. */
export interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
  cachedInputPerMTok?: number
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type RemotePreference = 'remote' | 'hybrid' | 'onsite'
export type Seniority = 'intern' | 'junior' | 'mid' | 'senior' | 'staff' | 'principal' | 'manager' | 'director' | 'executive'

export interface JobPreferences {
  /** Titles the user wants. Matched loosely against job titles. */
  targetTitles: string[]
  /** Any of these in the title or description raises the pre-score. */
  includeKeywords: string[]
  /** Any of these in the title drops the job before any AI call. */
  excludeTitleKeywords: string[]
  /** Any of these in the description drops the job before any AI call. */
  excludeDescriptionKeywords: string[]
  /** Locations the user can work from. Empty means anywhere. */
  locations: string[]
  remote: RemotePreference[]
  seniority: Seniority[]
  /** In the currency below, yearly. Jobs that list a max below this are dropped. */
  minSalary: number | null
  salaryCurrency: string
  excludedCompanies: string[]
  /** Ignore postings older than this many days. */
  maxPostingAgeDays: number
  needsVisaSponsorship: boolean
  /** Skip a company you applied to within this many days. */
  companyCooldownDays: number
}

export interface Thresholds {
  /** Keyword pre-score (0-100) a job needs before any tokens are spent on it. */
  prescoreMin: number
  /** AI fit score needed to land in the shortlist. Below this the job is archived as not a fit. */
  shortlistScore: number
  /** AI fit score at which autopilot prepares an application without asking. */
  autoPrepareScore: number
  /** AI fit score at which autopilot may submit without asking (when auto-submit is on). */
  autoSubmitScore: number
}

export interface BudgetSettings {
  dailyUsd: number
  monthlyUsd: number
  /** Max jobs sent to AI fit scoring per run. */
  maxTriagePerRun: number
  /** Max applications prepared per run. */
  maxPreparePerRun: number
}

export interface AutopilotSettings {
  enabled: boolean
  intervalHours: number
  autoPrepare: boolean
  autoSubmit: boolean
  dailySubmitCap: number
  /** Auto-submit only when no answer is flagged for your input. Always on in practice. */
  requireNoFlags: boolean
  /** Fill forms and stop before the final click. Good for testing auto-submit. */
  dryRun: boolean
}

export type BrowserChannel = 'chrome' | 'msedge' | 'chromium'

export interface BrowserSettings {
  channel: BrowserChannel
  /** Milliseconds between browser actions. Higher looks more human and breaks less. */
  slowMoMs: number
  /** Keep the browser open after submitting so you can check it. */
  keepOpen: boolean
}

export type CoverLetterLength = 'short' | 'medium' | 'long'

export interface WritingSettings {
  coverLetterLength: CoverLetterLength
  /** Generate a cover letter even when the form doesn't ask for one. */
  alwaysCoverLetter: boolean
  /** Extra phrases the user never wants to see, on top of the built-in list. */
  bannedPhrases: string[]
  /** Free-form guidance, for example "dry humor is fine, never exclamation marks". */
  styleNotes: string
  /** Lint score a draft must reach before it is accepted without another revision. */
  minLintScore: number
  maxRevisions: number
}

export type EeoAnswer = 'decline' | string

export interface EeoSettings {
  gender: EeoAnswer
  race: EeoAnswer
  veteran: EeoAnswer
  disability: EeoAnswer
  pronouns: string
}

export interface Settings {
  routing: Record<LlmStage, ModelRef | null>
  /** Overrides and additions to the built-in price table, keyed by model id. */
  prices: Record<string, ModelPrice>
  preferences: JobPreferences
  thresholds: Thresholds
  budget: BudgetSettings
  autopilot: AutopilotSettings
  browser: BrowserSettings
  writing: WritingSettings
  eeo: EeoSettings
  onboardingDone: boolean
}

// ---------------------------------------------------------------------------
// Profile and materials
// ---------------------------------------------------------------------------

export interface WorkExperience {
  company: string
  title: string
  location?: string
  start?: string // YYYY-MM or free text
  end?: string // YYYY-MM, "present" or free text
  highlights: string[]
}

export interface Education {
  school: string
  degree?: string
  field?: string
  start?: string
  end?: string
}

export interface Project {
  name: string
  description: string
  url?: string
  highlights: string[]
}

/** A question and answer the user wants reused, such as notice period or salary expectation. */
export interface ProfileFact {
  question: string
  answer: string
}

export interface VoiceProfile {
  /** Plain-language description of how the user writes, used in writing prompts. */
  summary: string
  formality: 'casual' | 'neutral' | 'formal'
  avgSentenceWords: number
  traits: string[]
  /** Short phrases lifted from the user's own samples. */
  signaturePhrases: string[]
  /** Things that would sound wrong coming from this person. */
  avoid: string[]
  builtFrom: string[] // document ids
  builtAt: string
}

export interface WorkAuthorization {
  /** Countries the user can work in without sponsorship. */
  authorizedCountries: string[]
  needsSponsorship: boolean
  notes: string
}

export interface Profile {
  fullName: string
  email: string
  phone: string
  location: string
  links: {
    linkedin: string
    github: string
    portfolio: string
    website: string
    other: string[]
  }
  headline: string
  summary: string
  yearsExperience: number | null
  workAuthorization: WorkAuthorization
  experience: WorkExperience[]
  education: Education[]
  skills: string[]
  certifications: string[]
  languages: string[]
  projects: Project[]
  facts: ProfileFact[]
  /** Notes for the AI: things to stress, things never to mention, context it should know. */
  notesForAi: string
  voice: VoiceProfile | null
}

export interface ProfileRecord {
  profile: Profile
  version: number
  updatedAt: string | null
}

export type DocumentKind = 'resume' | 'cover_letter_sample' | 'writing_sample' | 'portfolio' | 'other'

export interface DocumentRecord {
  id: string
  kind: DocumentKind
  name: string
  filePath: string | null
  mime: string | null
  url: string | null
  /** Extracted text, shortened for the list view. Full text stays in the database. */
  textPreview: string
  textLength: number
  isPrimary: boolean
  createdAt: string
}

export interface DocumentInput {
  kind: DocumentKind
  filePath?: string
  url?: string
  text?: string
  name?: string
}

export type AnswerKind = 'fact' | 'template'

/** A saved answer to a question that comes up across applications. */
export interface AnswerBankEntry {
  id: string
  question: string
  answer: string
  /** fact: reuse word for word. template: a starting point the AI adapts per company. */
  kind: AnswerKind
  timesUsed: number
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Sources and companies
// ---------------------------------------------------------------------------

export type AtsKind =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'workday'
  | 'recruitee'
  | 'unknown'

export type SourceKind =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'remotive'
  | 'remoteok'
  | 'arbeitnow'
  | 'hn_whoishiring'
  | 'adzuna'
  | 'manual'

export interface AtsDetection {
  ats: AtsKind
  /** Board token or company slug used by the ATS public API. */
  token: string | null
  /** Job id when the URL points at one posting. */
  jobId: string | null
  companyName: string | null
}

export interface Company {
  id: string
  name: string
  ats: AtsKind
  atsToken: string | null
  careersUrl: string | null
  /** Watched companies have their job boards checked every run. */
  watch: boolean
  /** Blocked companies are never shown or scored. */
  blocked: boolean
  notes: string
  createdAt: string
}

export interface CompanyInput {
  name?: string
  careersUrl?: string
  ats?: AtsKind
  atsToken?: string
  watch?: boolean
  blocked?: boolean
  notes?: string
}

/** A saved search against an aggregator such as Remotive or Adzuna. */
export interface SavedSearch {
  id: string
  source: Exclude<SourceKind, 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'manual'>
  label: string
  /** Source-specific parameters: query text, location, country, category. */
  params: Record<string, string>
  enabled: boolean
  lastRunAt: string | null
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobStage =
  | 'new' // just discovered, not evaluated yet
  | 'filtered_out' // dropped by a hard rule, zero tokens spent
  | 'prescored_out' // keyword overlap too low, zero tokens spent
  | 'duplicate' // same posting seen from another source
  | 'scored' // AI scored it below the shortlist line, archived as not a fit
  | 'shortlisted' // good fit, waiting for you or autopilot
  | 'dismissed' // you said no
  | 'preparing'
  | 'ready' // application drafted, waiting for review or submit
  | 'applied'
  | 'closed' // posting taken down

export type FitBucket = 'perfect' | 'great' | 'good' | 'weak'
export type RemoteType = 'remote' | 'hybrid' | 'onsite' | 'unknown'

export interface FitAssessment {
  score: number // 0-100
  bucket: FitBucket
  summary: string
  matches: string[]
  gaps: string[]
  dealbreakers: string[]
  seniorityFit: 'under' | 'match' | 'over' | 'unknown'
  /** Keywords from the posting worth echoing in the application. */
  keywords: string[]
}

export interface JobSummary {
  id: string
  source: SourceKind
  company: string
  title: string
  location: string | null
  remote: RemoteType
  salaryMin: number | null
  salaryMax: number | null
  salaryCurrency: string | null
  url: string
  ats: AtsKind
  postedAt: string | null
  discoveredAt: string
  stage: JobStage
  filterReason: string | null
  prescore: number | null
  fitScore: number | null
  fitBucket: FitBucket | null
  fitSummary: string | null
  starred: boolean
  applicationId: string | null
}

export interface Job extends JobSummary {
  externalId: string
  applyUrl: string | null
  description: string
  employmentType: string | null
  fit: FitAssessment | null
  dismissReason: string | null
  dismissTags: string[]
  dupOf: string | null
  updatedAt: string
}

export interface JobQuery {
  stages?: JobStage[]
  buckets?: FitBucket[]
  sources?: SourceKind[]
  search?: string
  starredOnly?: boolean
  sort?: 'score' | 'newest' | 'posted' | 'company'
  limit?: number
  offset?: number
}

/** The shape every source returns before the job is stored. */
export interface RawJob {
  source: SourceKind
  externalId: string
  company: string
  title: string
  location: string | null
  remote: RemoteType
  salaryMin: number | null
  salaryMax: number | null
  salaryCurrency: string | null
  employmentType: string | null
  url: string
  applyUrl: string | null
  ats: AtsKind
  atsToken: string | null
  description: string // plain text
  postedAt: string | null
}

export const DISMISS_TAGS = [
  'too senior',
  'too junior',
  'wrong location',
  'not remote',
  'pay too low',
  'wrong industry',
  'wrong tech stack',
  'company',
  'already applied elsewhere',
  'other'
] as const
export type DismissTag = (typeof DISMISS_TAGS)[number]

// ---------------------------------------------------------------------------
// Application forms and answers
// ---------------------------------------------------------------------------

export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'radio'
  | 'checkbox' // single yes/no checkbox
  | 'checkboxes' // group, pick many
  | 'file'
  | 'combobox' // custom dropdown that needs typing

export interface FormField {
  /** Stable key used to match the field across page loads: name, id or normalized label. */
  key: string
  label: string
  type: FieldType
  required: boolean
  options: string[]
  placeholder: string | null
  /** Character limit when the form states one. */
  maxLength: number | null
  /** Short hint about what the file input wants, such as "resume" or "cover letter". */
  fileHint: 'resume' | 'cover_letter' | 'other' | null
}

export type AnswerSource =
  | 'profile' // copied from a profile field
  | 'answer_bank' // reused saved answer
  | 'settings' // EEO and similar defaults
  | 'ai' // written by the model
  | 'user' // typed or edited by the user
  | 'file' // a file upload

export interface PreparedAnswer {
  fieldKey: string
  label: string
  type: FieldType
  required: boolean
  options: string[]
  /** For multi-pick fields this is a JSON array string. For files it is a path. */
  value: string
  source: AnswerSource
  /** 0-1. Low confidence answers are highlighted for review. */
  confidence: number
  /** True when the AI could not answer truthfully from the profile and the user must fill it in. */
  needsUser: boolean
  note: string | null
  lint: LintReport | null
}

export type ApplicationStatus =
  | 'draft' // being prepared
  | 'ready' // waiting for review and submit
  | 'needs_attention' // missing answers, a captcha, a login wall
  | 'submitting'
  | 'submitted'
  | 'failed'
  | 'withdrawn'

export type ApplicationOutcome =
  | 'none'
  | 'rejected'
  | 'ghosted'
  | 'screen'
  | 'interview'
  | 'offer'
  | 'accepted'
  | 'declined'

export type SubmitMode = 'manual' | 'assist' | 'auto'

export interface ApplicationSummary {
  id: string
  jobId: string
  company: string
  title: string
  fitScore: number | null
  fitBucket: FitBucket | null
  status: ApplicationStatus
  outcome: ApplicationOutcome
  submitMode: SubmitMode | null
  flaggedCount: number
  submittedAt: string | null
  outcomeAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Application extends ApplicationSummary {
  coverLetter: string | null
  coverLetterLint: LintReport | null
  answers: PreparedAnswer[]
  formFields: FormField[]
  resumeDocId: string | null
  confirmation: string | null
  screenshotPath: string | null
  error: string | null
  notes: string
}

export interface ApplicationPatch {
  coverLetter?: string
  answers?: PreparedAnswer[]
  notes?: string
  outcome?: ApplicationOutcome
  status?: ApplicationStatus
  resumeDocId?: string | null
}

export interface ApplicationQuery {
  statuses?: ApplicationStatus[]
  outcomes?: ApplicationOutcome[]
  search?: string
  limit?: number
  offset?: number
}

export interface SubmitResult {
  ok: boolean
  status: ApplicationStatus
  /** What happened, in a sentence the UI can show. */
  message: string
  screenshotPath: string | null
}

// ---------------------------------------------------------------------------
// Writing quality
// ---------------------------------------------------------------------------

export type LintSeverity = 'high' | 'medium' | 'low'

export interface LintIssue {
  rule: string
  severity: LintSeverity
  message: string
  /** The offending text, when the rule points at a span. */
  match: string | null
  index: number | null
  suggestion: string | null
}

export interface LintReport {
  /** 100 reads as human-written. Below the user's minimum the draft gets revised. */
  score: number
  issues: LintIssue[]
  stats: {
    words: number
    sentences: number
    avgSentenceWords: number
    sentenceLengthStdDev: number
    paragraphs: number
  }
}

// ---------------------------------------------------------------------------
// Pipeline, runs and events
// ---------------------------------------------------------------------------

export type PipelinePhase = 'idle' | 'discovering' | 'filtering' | 'scoring' | 'preparing' | 'submitting'

export interface PipelineProgress {
  runId: string | null
  phase: PipelinePhase
  message: string
  done: number
  total: number
}

export interface RunOptions {
  discover?: boolean
  triage?: boolean
  prepare?: boolean
  submit?: boolean
  trigger?: 'manual' | 'schedule'
}

export interface RunStats {
  discovered: number
  newJobs: number
  duplicates: number
  filteredOut: number
  prescoredOut: number
  scored: number
  shortlisted: number
  prepared: number
  submitted: number
  errors: number
  costUsd: number
  tokens: number
  stoppedForBudget: boolean
}

export interface RunRecord {
  id: string
  trigger: 'manual' | 'schedule'
  startedAt: string
  finishedAt: string | null
  stats: RunStats
  error: string | null
}

export type EventType =
  | 'discovered'
  | 'filtered'
  | 'scored'
  | 'shortlisted'
  | 'dismissed'
  | 'restored'
  | 'prepared'
  | 'submitted'
  | 'submit_failed'
  | 'outcome'
  | 'run_started'
  | 'run_finished'
  | 'budget_stop'
  | 'error'

export interface EventRecord {
  id: string
  at: string
  type: EventType
  jobId: string | null
  message: string
  data: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Usage and analytics
// ---------------------------------------------------------------------------

export interface UsageSummary {
  todayUsd: number
  monthUsd: number
  todayTokens: number
  monthTokens: number
  dailyBudgetUsd: number
  monthlyBudgetUsd: number
  /** Responses served from the local cache this month. Each one is a call you didn't pay for. */
  cacheHitsMonth: number
}

export interface CountByKey {
  key: string
  count: number
}

export interface AnalyticsReport {
  rangeDays: number
  funnel: {
    discovered: number
    filteredOut: number
    prescoredOut: number
    duplicates: number
    scored: number
    shortlisted: number
    dismissed: number
    prepared: number
    submitted: number
    responses: number
    interviews: number
    offers: number
  }
  /** One row per day in the range. */
  daily: Array<{
    date: string
    discovered: number
    submitted: number
    costUsd: number
    tokens: number
  }>
  outcomesByBucket: Array<{ bucket: FitBucket; submitted: number; responses: number; interviews: number }>
  outcomesBySource: Array<{ source: SourceKind; submitted: number; responses: number; interviews: number }>
  costByTask: Array<{ task: LlmTask; costUsd: number; tokens: number; calls: number }>
  costByModel: Array<{ model: string; costUsd: number; tokens: number; calls: number }>
  scoreDistribution: Array<{ range: string; count: number }>
  topGaps: CountByKey[]
  topMatches: CountByKey[]
  dismissReasons: CountByKey[]
  filterReasons: CountByKey[]
  /** Jobs that never reached the AI because a free rule handled them. */
  tokenSavings: {
    jobsSkippedFree: number
    estimatedTokensSaved: number
    estimatedUsdSaved: number
    cacheHits: number
  }
  averages: {
    costPerApplicationUsd: number | null
    hoursDiscoveryToApply: number | null
    daysToFirstResponse: number | null
  }
}

// ---------------------------------------------------------------------------
// Learned preferences
// ---------------------------------------------------------------------------

/**
 * A change to the free filters suggested by the user's own dismissals, such as
 * "you dismissed 4 Staff roles as too senior, exclude 'staff' from titles?".
 * Applying one means fewer jobs reach the AI, which saves tokens.
 */
export interface PreferenceSuggestion {
  id: string
  message: string
  /** Number of dismissed jobs behind the suggestion. */
  evidence: number
  /** Passed to updateSettings when the user accepts. */
  patch: {
    preferences: Partial<JobPreferences>
  }
}
