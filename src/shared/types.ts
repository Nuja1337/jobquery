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

/**
 * How the user pays for a provider. "free" is a free tier or a local model: calls cost nothing,
 * never count toward the spending caps, and are paced to the provider's free limits instead.
 * "paid" calls are priced per token and count toward the caps.
 */
export type ProviderBilling = 'free' | 'paid'

/** A provider the user configured. The API key never leaves the main process. */
export interface ProviderInfo {
  id: string
  kind: ProviderKind
  label: string
  baseUrl: string | null
  hasKey: boolean
  billing: ProviderBilling
  /** Most calls to start per minute, or null for no pacing. Free tiers need this. */
  requestsPerMinute: number | null
  /** Most calls per calendar day (local time), or null for no daily limit. */
  requestsPerDay: number | null
  createdAt: string
}

export interface ProviderInput {
  id?: string
  kind: ProviderKind
  label: string
  baseUrl?: string | null
  /** Only sent when the user types a new key. Omit to keep the stored one. */
  apiKey?: string
  /** Defaults to "free" for local providers (Ollama, localhost URLs) and "paid" otherwise. */
  billing?: ProviderBilling
  requestsPerMinute?: number | null
  requestsPerDay?: number | null
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

/** Ids are stored in the profile and settings, so they never change once shipped. */
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'contract_to_hire' | 'temporary' | 'internship' | 'freelance'
export type RemotePreference ='remote' | 'hybrid' | 'onsite'
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
  /** How many applications one company may get within the cooldown. At least 1. */
  perCompanyLimit: number
  /** Employment types the user wants. An empty list means any. */
  employmentTypes: EmploymentType[]
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
  /** Most jobs sent to AI fit scoring in one day in continuous mode. */
  maxTriagePerDay: number
  /** Most applications prepared in one day in continuous mode. */
  maxPreparePerDay: number
}

export type AutopilotMode = 'interval' | 'continuous'

export interface AutopilotSettings {
  enabled: boolean
  /** Interval runs one batch every `intervalHours`. Continuous keeps workers going all day within the caps. */
  mode: AutopilotMode
  intervalHours: number
  autoPrepare: boolean
  autoSubmit: boolean
  dailySubmitCap: number
  /** Most applications sent in any one clock hour in continuous mode. */
  hourlySubmitCap: number
  /** Applications filled at once in continuous mode, 1 to 3. */
  submitConcurrency: number
  /** Auto-submit only when no answer is flagged for your input. Always on in practice. */
  requireNoFlags: boolean
  /** Fill forms and stop before the final click. Good for testing auto-submit. */
  dryRun: boolean
  /** Agree to required boxes that only consent to data handling or say the answers are true. Never terms, waivers or AI-use questions. */
  tickRequiredConsent: boolean
  /** Let autopilot send a form where a question only the person answers was filled from their own saved answer. */
  sendSavedUserAnswers: boolean
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
  /** Adapt a saved answer to a general question (why this company, about you) to the company instead of pasting it unchanged. */
  adaptSavedAnswers: boolean
  /** Extra phrases the user never wants to see, on top of the built-in list. */
  bannedPhrases: string[]
  /** Free-form guidance, for example "dry humor is fine, never exclamation marks". */
  styleNotes: string
  /** Lint score a draft must reach before it is accepted without another revision. */
  minLintScore: number
  maxRevisions: number
}

export type YesNoDecline = 'yes' | 'no' | 'decline'
export type GenderId = 'man' | 'woman' | 'non_binary' | 'self_describe' | 'decline'
export type RaceId = 'american_indian' | 'asian' | 'asian_east' | 'asian_south' | 'asian_southeast' | 'black' | 'mena' | 'pacific_islander' | 'white'
export type VeteranId = 'not_protected' | 'protected' | 'decline'
export type VeteranCategoryId = 'disabled' | 'recently_separated' | 'active_wartime' | 'service_medal'
export type SexualOrientationId = 'asexual' | 'bisexual_pansexual' | 'gay' | 'heterosexual' | 'lesbian' | 'queer' | 'self_describe'
export type PronounsId = 'he' | 'she' | 'they' | 'name_only' | 'custom' | 'decline'
/** The 19 subgroups of the 2021 ONS ethnic groups. The group is the part before the first underscore. */
export type UkEthnicityId =
  | 'asian_bangladeshi'
  | 'asian_chinese'
  | 'asian_indian'
  | 'asian_pakistani'
  | 'asian_other'
  | 'black_african'
  | 'black_caribbean'
  | 'black_other'
  | 'mixed_white_asian'
  | 'mixed_white_black_african'
  | 'mixed_white_black_caribbean'
  | 'mixed_other'
  | 'white_british'
  | 'white_irish'
  | 'white_gypsy_traveller'
  | 'white_roma'
  | 'white_other'
  | 'other_arab'
  | 'other_any'
  | 'decline'
export type ReligionId = 'none' | 'christian' | 'buddhist' | 'hindu' | 'jewish' | 'muslim' | 'sikh' | 'other' | 'decline'
/** The Social Mobility Commission's occupation groups for the main household earner at age 14. */
export type HouseholdOccupationId =
  | 'modern_professional'
  | 'clerical_intermediate'
  | 'senior_manager'
  | 'technical_craft'
  | 'semi_routine'
  | 'routine'
  | 'middle_manager'
  | 'traditional_professional'
  | 'long_term_unemployed'
  | 'retired'
  | 'not_applicable'
  | 'decline'
export type SchoolTypeId = 'state_non_selective' | 'state_selective' | 'independent' | 'independent_bursary' | 'outside_uk' | 'decline'

/** The four Social Mobility Commission questions. */
export interface SocioeconomicSettings {
  householdOccupation: HouseholdOccupationId
  schoolType: SchoolTypeId
  freeSchoolMeals: YesNoDecline
  parentDegree: YesNoDecline
}

/**
 * Voluntary self-identification answers, version 2. Values are stable ids, never option text. An empty
 * list or 'decline' means the form's decline option. Rows saved before version 2 hold free text and
 * are converted by normalizeEeo in shared/eeo.ts. New families are added as new keys without a
 * version bump, since normalizeEeo fills missing keys with defaults.
 */
export interface EeoSettings {
  version: 2
  gender: GenderId
  /** Used only when gender is self_describe. */
  genderText: string
  transgender: YesNoDecline
  hispanicLatino: YesNoDecline
  race: RaceId[]
  veteran: VeteranId
  /** Used only when veteran is protected. */
  veteranCategories: VeteranCategoryId[]
  militaryService: YesNoDecline
  militarySpouse: YesNoDecline
  disability: YesNoDecline
  sexualOrientation: SexualOrientationId[]
  /** Used only when sexualOrientation includes self_describe. */
  sexualOrientationText: string
  lgbtq: YesNoDecline
  pronouns: PronounsId
  /** Used only when pronouns is custom. */
  pronounsText: string
  /** Empty by default, which declines age questions. */
  birthYear: number | null
  /** UK and EU forms. Marital status and pregnancy have no setting and always decline. */
  ukEthnicity: UkEthnicityId
  religion: ReligionId
  caring: YesNoDecline
  socioeconomic: SocioeconomicSettings
  neurodivergent: YesNoDecline
}

export interface UpdateSettings {
  /** Check for a new version at launch and every few hours. A check by hand works either way. */
  autoCheck: boolean
}

/** How JobQuery behaves on this PC while it runs unattended. */
export interface SystemSettings {
  /** Closing the window hides it to the system tray and the app keeps running. */
  closeToTray: boolean
  /** Start JobQuery when the user signs in to the computer. */
  startAtLogin: boolean
  /** Stop the computer from sleeping while a run is going or autopilot is on. */
  keepAwake: boolean
  /** Show a system notification when JobQuery needs the user. */
  notifications: boolean
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
  updates: UpdateSettings
  system: SystemSettings
  discovery: DiscoverySettings
  onboardingDone: boolean
}

export interface DiscoverySettings {
  /** Watch any company board that a posting links to. */
  autoWatchBoards: boolean
  /** No company is watched automatically once this many are watched. */
  maxWatchedBoards: number
  /** Most boards read in one run. The rest wait for the next run. */
  boardsPerRun: number
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * Where this copy of the app stands on updates.
 * - disabled: this copy can't update itself (a development build, or Linux outside the AppImage)
 * - idle: no check has run yet
 * - checking, up_to_date: a check is running, or the last one found nothing newer
 * - downloading: a newer version is downloading, and percent says how far along it is
 * - ready: downloaded, and it installs on restart or when the app closes
 * - available: a newer version exists, but this copy can't install it itself (macOS until the app
 *   is signed), so downloadUrl opens the download page
 * - error: the last check or download failed, and message says why
 */
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'up_to_date' | 'downloading' | 'ready' | 'available' | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** The newer version, once one is found. */
  version: string | null
  /** 0 to 100 while downloading, otherwise null. */
  percent: number | null
  /** When the last check finished, as an ISO time. */
  checkedAt: string | null
  /** Why updates are off, or what went wrong. Written for the user. */
  message: string | null
  /** The download page, when the user has to install the new version by hand. */
  downloadUrl: string | null
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

/** The name split the way forms ask for it. The resume carries first and last, never the preferred name. */
export interface ProfileName {
  first: string
  middle: string
  last: string
  preferred: string
  /** How to say the name. */
  pronunciation: string
}

export interface Profile {
  fullName: string
  /** A profile saved before this existed reads with first and last split from fullName when that is safe. */
  name: ProfileName
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
  /** Facts that application forms ask for again and again. Collected once, in the interview. */
  application: ApplicationFacts
}

export type AuthorizationStatus = 'citizen' | 'permanent_resident' | 'visa' | 'none'
/** null means not answered, and the question then waits for the person. */
export type YesNo = boolean | null
export type EducationLevel = 'high_school' | 'some_college' | 'associate' | 'bachelor' | 'master' | 'doctorate'
export type VisaType = '' | 'f1_opt' | 'stem_opt' | 'h1b' | 'tn' | 'other'
export type PlatformKind = 'pc' | 'console' | 'mobile' | 'vr' | 'web'
export type CurrentPayStance = '' | 'decline' | 'amount'

export interface AuthorizationEntry {
  country: string
  status: AuthorizationStatus
  needsSponsorship: boolean
  notes: string
  // The three fields below are filled with defaults when a profile is read. Optional so older code can build an entry.
  visaType?: VisaType
  /** ISO date the permit ends, or null. */
  expires?: string | null
  /** Whether the permit lets the person work for any employer. */
  anyEmployer?: YesNo
}
export type SalaryPeriod = 'year' | 'month' | 'hour'
export type SalaryAnswerStyle = 'number' | 'range' | 'negotiable'
export type TravelWillingness = 'none' | 'some' | 'frequent'
export type LanguageLevel = 'basic' | 'conversational' | 'fluent' | 'native'

/**
 * The answers forms ask for repeatedly. Each one maps to a field family in fieldMap.ts. Empty strings
 * and nulls mean "not answered", and the form field is then left for the person.
 */
export interface ApplicationFacts {
  address: { street: string; city: string; region: string; postalCode: string; country: string }
  /** Dial code such as "+1". */
  phoneCountryCode: string
  /** Work authorization per country. The older profile.workAuthorization stays as the summary. */
  authorization: AuthorizationEntry[]
  /** Expected pay per currency, used with the job's currency or country. */
  salary: Array<{ currency: string; min: number | null; target: number | null; period: SalaryPeriod; answerStyle: SalaryAnswerStyle }>
  noticeWeeks: number | null
  /** ISO date, or null for "as soon as possible". */
  earliestStart: string | null
  relocation: { willing: boolean | null; places: string[] }
  travel: TravelWillingness | null
  /** Years of experience per skill, keyed by the skill as written in the profile. */
  skillYears: Record<string, number>
  /** Level per language in profile.languages. */
  languageLevels: Record<string, LanguageLevel>
  /** Security clearance held. "None" means no clearance. An empty string means not answered yet. */
  clearance: string
  driversLicense: boolean | null
  over18: boolean | null
  references: string
  gpa: string
  workArrangement: {
    remote: YesNo
    hybrid: YesNo
    onsite: YesNo
    maxOfficeDaysPerWeek: number | null
    /** Cities the person can commute to. */
    commutableCities: string[]
  }
  employment: {
    types: EmploymentType[]
    hoursPerWeek: number | null
    currentlyEmployed: YesNo
    desiredTitle: string
    currentPay: { stance: CurrentPayStance; amount: number | null; currency: string; period: SalaryPeriod }
  }
  schedule: { evenings: YesNo; weekends: YesNo; nights: YesNo; onCall: YesNo; overtime: YesNo; timeZones: string[] }
  /** Willingness to go through a check. These never answer "have you ever" questions. */
  screening: { backgroundCheck: YesNo; drugTest: YesNo; creditCheck: YesNo }
  education: {
    highestCompleted: EducationLevel | null
    currentlyEnrolled: YesNo
    /** ISO month or date. */
    expectedGraduation: string | null
    fields: string[]
    relatedFields: string[]
  }
  /** Years per area, or a count of titles. 0 is an answer. null means not answered. */
  experience: {
    professionalSoftware: number | null
    gamesIndustry: number | null
    teamLead: number | null
    peopleManagement: number | null
    shippedTitles: number | null
    aaaTitles: number | null
    platforms: PlatformKind[]
  }
  citizenships: string[]
  exportControlUsPerson: YesNo
  clearanceEligible: YesNo
  /** The answer to "how did you hear about us" when the source gives no better one. */
  heardAbout: string
  /**
   * Whether family, relatives or friends work at the employers the person applies to. False answers
   * "Do you have family working at X?" with No. Null means not answered, and those questions wait for the person.
   */
  relativesAtEmployers?: boolean | null
  /** "none" means the person applies without a referral, so "Did an employee refer you?" is answered No. An empty string means not answered. */
  referrals?: 'none' | ''
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
  /** What the question is about (see questionTopics.ts). Set when the answer is saved. */
  topic?: string | null
  /** Narrows the topic: a currency, country or skill. */
  scope?: string | null
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
  | 'rippling'
  | 'breezy'
  | 'personio'
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
  | 'himalayas'
  | 'jobicy'
  | 'themuse'
  | 'weworkremotely'
  | 'rippling'
  | 'breezy'
  | 'personio'
  | 'manual'

export interface AtsDetection {
  ats: AtsKind
  /** Board token or company slug used by the ATS public API. */
  token: string | null
  /** Job id when the URL points at one posting. */
  jobId: string | null
  companyName: string | null
}

/** How a company came to be watched. */
export type CompanyOrigin = 'manual' | 'posting_link' | 'import' | 'starter'

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
  /** Where the company came from. A company found in a posting is watched without the user adding it. */
  origin: CompanyOrigin
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
  origin?: CompanyOrigin
}

/** A saved search against an aggregator such as Remotive or Adzuna. */
export interface SavedSearch {
  id: string
  source: Exclude<SourceKind, 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'rippling' | 'breezy' | 'personio' | 'manual'>
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
  /** The board token on the job's application system, such as "stripe" on Greenhouse. */
  atsToken?: string | null
  /** The posting's id on that system, so the same posting found through two sources is stored once. */
  atsJobId?: string | null
  description: string
  employmentType: string | null
  /** Levels the source states, as the app's seniority ids. Empty when the source gives none. */
  seniority?: Seniority[]
  /** Years of experience the source states as a minimum, or null. */
  minYears?: number | null
  fit: FitAssessment | null
  dismissReason: string | null
  dismissTags: string[]
  dupOf: string | null
  /** Times AI scoring failed for this job with the current profile. Runs skip it after 3. */
  triageFailures: number
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
  /** The posting's id on the application system when the source knows it. */
  atsJobId?: string | null
  /** Levels the source states (Himalayas, Personio, The Muse), as the app's seniority ids. */
  seniority?: Seniority[]
  /** Years of experience the source states as a minimum, or null. */
  minYears?: number | null
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
  /**
   * The form's own instruction for this question, such as "In 100 words or less" or "Include a link to your portfolio".
   * It is text from the employer's page, kept short. Absent or null when the form gives none.
   */
  hint?: string | null
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
  /**
   * Set when the answer was written while filling the live form, so the person never saw it on the
   * draft. It stays set until a person saves the application, and autopilot sends nothing while an
   * answer still has it.
   */
  liveOnly?: boolean
  /** Set when the answer comes from a rule over the log of earlier applications, so it is worked out again at fill time. */
  rule?: 'previously_applied' | 'demographic'
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
  /** Answers the person has to fill in or check (see answerNeedsUser in shared/answers.ts). */
  flaggedCount: number
  /** AI answers below the confidence auto mode needs. Auto mode won't send while any are left. */
  guessCount: number
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
  /**
   * When auto mode clicked the form's Submit button. Set even when no confirmation followed, so the
   * app never clicks a second time and risks a duplicate application.
   */
  submitClickedAt: string | null
  /** Failed automatic attempts that never reached the Submit click. Autopilot gives up on the third. */
  submitFailures: number
  /** When autopilot filled this form in a dry run and stopped before the click. */
  dryRunAt: string | null
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
  /** updated: most recently changed first (the default). fit: best fit first. */
  sort?: 'updated' | 'fit'
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
  /** Reads every watched board, not only those due. For a forced full check. */
  allBoards?: boolean
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
  /** The AI provider's rate or daily limit was reached, so AI work paused until the next run. */
  stoppedForRateLimit: boolean
}

export interface RunRecord {
  id: string
  trigger: 'manual' | 'schedule' | 'loop'
  startedAt: string
  finishedAt: string | null
  stats: RunStats
  error: string | null
}

// ---------------------------------------------------------------------------
// Continuous mode
// ---------------------------------------------------------------------------

export type WorkerName = 'discover' | 'score' | 'prepare' | 'submit'

export type PauseKind = 'budget' | 'rate_limit' | 'no_model' | 'provider_errors' | 'browser_errors' | 'captcha' | 'sign_in' | 'cap'

/** Why a step stopped early, and until when its worker should wait. Null means until something changes. */
export interface PauseHint {
  kind: PauseKind
  until: string | null
  /** The application form family (lever, greenhouse and so on) a captcha or sign-in pause belongs to. */
  family?: string
  message: string
}

export interface WorkerStatus {
  state: 'idle' | 'working' | 'paused' | 'off'
  /** ISO time a paused worker starts again, or null when it waits for a change. */
  until: string | null
  reason: string | null
  /** What this worker finished since local midnight. */
  doneToday: number
  /** Items it is working on right now. */
  active: number
}

export interface LoopStatus {
  running: boolean
  since: string | null
  workers: Record<WorkerName, WorkerStatus>
  today: { discovered: number; scored: number; prepared: number; submitted: number; errors: number; costUsd: number }
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
  | 'rate_limit_stop'
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
  /** Calls made today through free-tier or local providers. They cost nothing and skip the caps. */
  freeCallsToday: number
}

export interface CountByKey {
  key: string
  count: number
}

/** What happened in a window of time, counted in SQL. Used for "today" and "the last 7 days". */
export interface VolumeCounts {
  /** Jobs found in the window. */
  discovered: number
  /** Of those, jobs a free rule dropped: filters, keyword pre-score and duplicates. */
  filteredOut: number
  /** Of those, jobs that got an AI score (or an application). */
  scored: number
  /** Of those, jobs at or above the shortlist score (or with an application). */
  shortlisted: number
  /** Applications created in the window. */
  prepared: number
  /** Applications sent in the window, counting a Submit click that saw no confirmation. */
  submitted: number
  /** Applications created in the window that now need an answer or a fix from the user. */
  needsAttention: number
  /** Applications created in the window that now wait for review and submit. */
  ready: number
  /** Paid AI spend in the window. */
  costUsd: number
}

export interface ScoreBucket {
  from: number
  to: number
  count: number
}

export interface ProviderQuota {
  providerId: string
  label: string
  requestsToday: number
  /** The daily limit set for the provider, or null for none. */
  requestsPerDay: number | null
  costToday: number
}

export interface AnalyticsReport {
  rangeDays: number
  /** Since local midnight. Does not depend on `rangeDays`. */
  today: VolumeCounts
  /** The last 7 days. Does not depend on `rangeDays`. */
  week: VolumeCounts
  /** Applications sent in each of the last 24 hours, oldest first. `hour` is the ISO time the hour starts. */
  sendsByHour: Array<{ hour: string; count: number }>
  /** Jobs found in the last 7 days with an AI score of 50 or more, in buckets of 5. The last bucket includes 100. */
  scoreHistogram: ScoreBucket[]
  /** The same jobs counted by exact score: index 0 is score 50, index 50 is score 100. */
  scoreCounts: number[]
  /** Company boards. Not limited to a time window. */
  boards: { watched: number; failing: number; stopped: number; dueNow: number }
  /** AI requests and spend today for each provider. */
  quota: ProviderQuota[]
  /** Counts over all time. */
  totals: { submitted: number; responses: number; needsAttention: number; ready: number }
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

// ---------------------------------------------------------------------------
// Review exceptions
// ---------------------------------------------------------------------------

/** Why an application with nothing left for the person to answer could not be sent. */
export type ExceptionReason =
  | 'captcha'
  | 'sign_in'
  | 'multi_page'
  | 'job_board'
  | 'no_submit_button'
  | 'form_rejected'
  | 'no_confirmation'
  | 'timed_out'
  | 'browser'
  | 'gave_up'
  | 'other'

/** One question that many applications ask and the person has not answered. */
export interface NeedsYouGroup {
  /** Stable key for the group: the topic and scope for text questions, the normalized label for the rest. */
  key: string
  topic: string | null
  scope: string | null
  label: string
  /** Every distinct wording of the question in the group. A text group can hold several. */
  wordings: string[]
  required: boolean
  type: FieldType
  /** Set when every field in the group offers the same choices. */
  options: string[] | null
  /** True for questions only the person may answer (AI use, legal, consent). */
  userOnly: boolean
  /** How many applications ask it. */
  count: number
  applications: Array<{ id: string; company: string; title: string; fieldKey: string; note: string | null }>
}

export interface CouldNotSendGroup {
  reason: ExceptionReason
  count: number
  applications: Array<{ id: string; company: string; title: string; error: string | null; screenshotPath: string | null; submitClickedAt: string | null }>
}

export interface SentSample {
  id: string
  company: string
  title: string
  submittedAt: string
  screenshotPath: string | null
}

/** What the Review page shows first: questions to answer once, what could not be sent and a sample of what went out. */
export interface ReviewExceptions {
  needsYou: NeedsYouGroup[]
  couldNotSend: CouldNotSendGroup[]
  sent: { today: number; week: number; sample: SentSample[] }
  totals: { ready: number; needsAttention: number }
}
