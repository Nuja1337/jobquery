import type { DeepPartial } from './api'
import type { ApplicationFacts, FitBucket, LlmStage, ModelPrice, Profile, ProfileName, ProviderBilling, ProviderKind, Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  routing: { triage: null, writing: null, extraction: null },
  prices: {},
  preferences: {
    targetTitles: [],
    includeKeywords: [],
    excludeTitleKeywords: [],
    excludeDescriptionKeywords: [],
    locations: [],
    remote: ['remote', 'hybrid', 'onsite'],
    seniority: [],
    minSalary: null,
    salaryCurrency: 'USD',
    excludedCompanies: [],
    maxPostingAgeDays: 30,
    needsVisaSponsorship: false,
    companyCooldownDays: 90,
    perCompanyLimit: 1,
    employmentTypes: []
  },
  thresholds: {
    prescoreMin: 15,
    shortlistScore: 60,
    autoPrepareScore: 75,
    autoSubmitScore: 85
  },
  budget: {
    dailyUsd: 1,
    monthlyUsd: 15,
    maxTriagePerRun: 60,
    maxPreparePerRun: 10,
    maxTriagePerDay: 3000,
    maxPreparePerDay: 400
  },
  autopilot: {
    enabled: false,
    mode: 'interval',
    intervalHours: 6,
    autoPrepare: true,
    autoSubmit: false,
    dailySubmitCap: 10,
    hourlySubmitCap: 40,
    submitConcurrency: 1,
    requireNoFlags: true,
    dryRun: false,
    tickRequiredConsent: false,
    sendSavedUserAnswers: false
  },
  browser: {
    channel: 'chrome',
    slowMoMs: 60,
    keepOpen: false
  },
  writing: {
    coverLetterLength: 'medium',
    alwaysCoverLetter: false,
    adaptSavedAnswers: true,
    bannedPhrases: [],
    styleNotes: '',
    minLintScore: 80,
    maxRevisions: 2
  },
  eeo: {
    version: 2,
    gender: 'decline',
    genderText: '',
    transgender: 'decline',
    hispanicLatino: 'decline',
    race: [],
    veteran: 'decline',
    veteranCategories: [],
    militaryService: 'decline',
    militarySpouse: 'decline',
    disability: 'decline',
    sexualOrientation: [],
    sexualOrientationText: '',
    lgbtq: 'decline',
    pronouns: 'decline',
    pronounsText: '',
    birthYear: null,
    ukEthnicity: 'decline',
    religion: 'decline',
    caring: 'decline',
    socioeconomic: { householdOccupation: 'decline', schoolType: 'decline', freeSchoolMeals: 'decline', parentDegree: 'decline' },
    neurodivergent: 'decline'
  },
  updates: {
    autoCheck: true
  },
  system: {
    closeToTray: true,
    startAtLogin: false,
    keepAwake: true,
    notifications: true
  },
  discovery: {
    autoWatchBoards: true,
    maxWatchedBoards: 5000,
    boardsPerRun: 2000
  },
  onboardingDone: false
}

/**
 * Settings for running at volume: hundreds of applications a day, with dry run on first so the fills
 * can be checked before anything is sent. Applied on request, never by default.
 */
export const VOLUME_PRESET: DeepPartial<Settings> = {
  thresholds: { shortlistScore: 60, autoPrepareScore: 65, autoSubmitScore: 72 },
  budget: { dailyUsd: 3, monthlyUsd: 60, maxTriagePerDay: 3000, maxPreparePerDay: 400 },
  autopilot: {
    enabled: true,
    mode: 'continuous',
    autoPrepare: true,
    autoSubmit: true,
    dryRun: true,
    dailySubmitCap: 300,
    hourlySubmitCap: 40,
    submitConcurrency: 1,
    requireNoFlags: true,
    tickRequiredConsent: true,
    sendSavedUserAnswers: true
  },
  preferences: { perCompanyLimit: 2, companyCooldownDays: 30, maxPostingAgeDays: 21 },
  browser: { slowMoMs: 25 },
  writing: { coverLetterLength: 'short', minLintScore: 80, maxRevisions: 2 },
  discovery: { autoWatchBoards: true, maxWatchedBoards: 5000, boardsPerRun: 2000 },
  system: { keepAwake: true, closeToTray: true, notifications: true }
}

/** Settings with a preset laid over them. Objects merge key by key. Arrays and plain values replace. Nothing in `current` changes. */
export function applyPreset(current: Settings, preset: DeepPartial<Settings>): Settings {
  return mergeInto<Settings>(current, preset)
}

function mergeInto<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    out[key] = mergeInto((base as Record<string, unknown>)[key], value as DeepPartial<unknown>)
  }
  return out as T
}

/**
 * The public page where new versions are published. It must match `build.publish` in
 * package.json, which tells installed copies where to look (a test checks that they match).
 */
export const RELEASES_URL = 'https://github.com/Nuja1337/jobquery/releases/latest'

export const EMPTY_APPLICATION_FACTS: ApplicationFacts = {
  address: { street: '', city: '', region: '', postalCode: '', country: '' },
  phoneCountryCode: '',
  authorization: [],
  salary: [],
  noticeWeeks: null,
  earliestStart: null,
  relocation: { willing: null, places: [] },
  travel: null,
  skillYears: {},
  languageLevels: {},
  clearance: '',
  driversLicense: null,
  over18: null,
  references: 'Available on request.',
  gpa: '',
  heardAbout: '',
  relativesAtEmployers: null,
  referrals: '',
  workArrangement: { remote: null, hybrid: null, onsite: null, maxOfficeDaysPerWeek: null, commutableCities: [] },
  employment: {
    types: [],
    hoursPerWeek: null,
    currentlyEmployed: null,
    desiredTitle: '',
    currentPay: { stance: '', amount: null, currency: '', period: 'year' }
  },
  schedule: { evenings: null, weekends: null, nights: null, onCall: null, overtime: null, timeZones: [] },
  screening: { backgroundCheck: null, drugTest: null, creditCheck: null },
  education: { highestCompleted: null, currentlyEnrolled: null, expectedGraduation: null, fields: [], relatedFields: [] },
  experience: {
    professionalSoftware: null,
    gamesIndustry: null,
    teamLead: null,
    peopleManagement: null,
    shippedTitles: null,
    aaaTitles: null,
    platforms: []
  },
  citizenships: [],
  exportControlUsPerson: null,
  clearanceEligible: null
}

export const EMPTY_PROFILE_NAME: ProfileName = { first: '', middle: '', last: '', preferred: '', pronunciation: '' }

export const EMPTY_PROFILE: Profile = {
  fullName: '',
  name: EMPTY_PROFILE_NAME,
  email: '',
  phone: '',
  location: '',
  links: { linkedin: '', github: '', portfolio: '', website: '', other: [] },
  headline: '',
  summary: '',
  yearsExperience: null,
  workAuthorization: { authorizedCountries: [], needsSponsorship: false, notes: '' },
  experience: [],
  education: [],
  skills: [],
  certifications: [],
  languages: [],
  projects: [],
  facts: [],
  notesForAi: '',
  voice: null,
  application: EMPTY_APPLICATION_FACTS
}

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)',
  openai_compatible: 'Other OpenAI-compatible API'
}

export const PROVIDER_DEFAULT_BASE_URL: Record<ProviderKind, string | null> = {
  anthropic: null,
  openai: null,
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  openai_compatible: null
}

/**
 * Ready-made setups shown when adding a provider, grouped as free and paid. Free-tier limits
 * change often, so the numbers are cautious starting points the user can edit. Checked October 2026.
 */
export interface ProviderPreset {
  id: string
  /** Shown on the button and used as the provider's label. */
  label: string
  kind: ProviderKind
  baseUrl: string | null
  billing: ProviderBilling
  needsKey: boolean
  /** Where to create a key, or null when none is needed. */
  keyUrl: string | null
  /** The provider's price page, or null when there isn't one. */
  pricingUrl: string | null
  /** Where the user checks usage or sets a spend limit, or null when there isn't a page. */
  spendUrl: string | null
  /** One sentence on how to cap spending at the provider, or null when there is nothing to add. */
  spendTip: string | null
  requestsPerMinute: number | null
  requestsPerDay: number | null
  /** Starting models per stage, or null to pick from the provider's list. */
  models: Record<LlmStage, string> | null
  /** One or two plain sentences for the user: cost, limits, privacy. */
  note: string
  /** True when the provider may use what's sent to it to train or improve its models. */
  trainsOnData: boolean
}

/** Shown wherever a user adds or reviews a paid provider. */
export const BILLING_RESPONSIBILITY =
  "Your AI provider bills you directly. JobQuery's costs and budgets are estimates from published prices, so your bill can be higher. JobQuery isn't responsible for any charges from your provider."

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'gemini-free',
    label: 'Google Gemini (free tier)',
    kind: 'gemini',
    baseUrl: null,
    billing: 'free',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    spendUrl: 'https://aistudio.google.com/usage',
    spendTip: null,
    requestsPerMinute: 10,
    requestsPerDay: 250,
    models: { triage: 'gemini-2.5-flash-lite', writing: 'gemini-2.5-flash', extraction: 'gemini-2.5-flash' },
    note: "You don't need a card. Use a key from a Google project without billing. If billing is on, Google charges for each call and JobQuery's budgets won't stop it. Google may use what you send on the free tier to improve its products, and people may read it, including your resume and answers. This doesn't apply if you're in the European Economic Area, Switzerland or the UK.",
    trainsOnData: true
  },
  {
    id: 'groq-free',
    label: 'Groq (free tier)',
    kind: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    billing: 'free',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    pricingUrl: 'https://groq.com/pricing',
    spendUrl: 'https://console.groq.com/settings/limits',
    spendTip: "On a paid Groq plan, you can set a spend limit under Settings, Billing, Limits in the Groq console.",
    requestsPerMinute: 30,
    requestsPerDay: 1000,
    models: null,
    note: "You don't need a card. It runs fast open models, with a daily limit for each model. If your Groq account is on a paid plan, mark this provider paid so the budgets apply.",
    trainsOnData: false
  },
  {
    id: 'openrouter-free',
    label: 'OpenRouter (free models)',
    kind: 'openrouter',
    baseUrl: null,
    billing: 'free',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    pricingUrl: 'https://openrouter.ai/models?max_price=0',
    spendUrl: 'https://openrouter.ai/settings/keys',
    spendTip: "If you buy credits, you can set a credit limit on the key so it can't spend more than you choose.",
    requestsPerMinute: 20,
    requestsPerDay: 50,
    models: null,
    note: 'Pick models whose names end in ":free". Until you have bought credits, you get about 50 requests a day across all free models.',
    trainsOnData: true
  },
  {
    id: 'mistral-free',
    label: 'Mistral (free plan)',
    kind: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    billing: 'free',
    needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    pricingUrl: 'https://mistral.ai/pricing',
    spendUrl: null,
    spendTip: null,
    requestsPerMinute: 20,
    requestsPerDay: null,
    models: { triage: 'mistral-small-latest', writing: 'mistral-medium-latest', extraction: 'mistral-small-latest' },
    note: "You don't need a card, but Mistral may ask for a phone number. It may use requests on the free plan to train its models. If you're on a paid Mistral plan, mark this provider paid so the budgets apply.",
    trainsOnData: true
  },
  {
    id: 'ollama',
    label: 'Ollama (on this computer)',
    kind: 'ollama',
    baseUrl: null,
    billing: 'free',
    needsKey: false,
    keyUrl: 'https://ollama.com/download',
    pricingUrl: null,
    spendUrl: null,
    spendTip: null,
    requestsPerMinute: null,
    requestsPerDay: null,
    models: null,
    note: "It's free and private, and nothing leaves your computer. It needs a fairly strong computer, and the writing is weaker than the big paid models.",
    trainsOnData: false
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (on this computer)',
    kind: 'openai_compatible',
    baseUrl: 'http://localhost:1234/v1',
    billing: 'free',
    needsKey: false,
    keyUrl: 'https://lmstudio.ai',
    pricingUrl: null,
    spendUrl: null,
    spendTip: null,
    requestsPerMinute: null,
    requestsPerDay: null,
    models: null,
    note: "It's free and private. Start the local server in LM Studio first.",
    trainsOnData: false
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: null,
    billing: 'paid',
    needsKey: true,
    keyUrl: 'https://platform.claude.com/settings/keys',
    pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    spendUrl: 'https://platform.claude.com/settings/limits',
    spendTip: "Set a monthly spend limit on the Limits page of the Claude Console.",
    requestsPerMinute: null,
    requestsPerDay: null,
    models: { triage: 'claude-haiku-5-5', writing: 'claude-sonnet-5-5', extraction: 'claude-haiku-5-5' },
    note: "You pay for each call. A Claude Pro or Max subscription doesn't include API use.",
    trainsOnData: false
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: null,
    billing: 'paid',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    pricingUrl: 'https://platform.openai.com/docs/pricing',
    spendUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    spendTip: "OpenAI bills from credits you buy ahead. Auto recharge is on by default, so turn it off if you don't want OpenAI to buy more credits on its own.",
    requestsPerMinute: null,
    requestsPerDay: null,
    models: { triage: 'gpt-5-mini', writing: 'gpt-5', extraction: 'gpt-5-mini' },
    note: "You pay for each call. A ChatGPT Plus or Pro subscription doesn't include API use.",
    trainsOnData: false
  },
  {
    id: 'gemini-paid',
    label: 'Google Gemini (paid)',
    kind: 'gemini',
    baseUrl: null,
    billing: 'paid',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    spendUrl: 'https://aistudio.google.com/spend',
    spendTip: "Set a monthly spend cap on the Spend page in AI Studio. Google says spending can run past the cap for about 10 minutes.",
    requestsPerMinute: null,
    requestsPerDay: null,
    models: { triage: 'gemini-2.5-flash', writing: 'gemini-2.5-pro', extraction: 'gemini-2.5-flash' },
    note: "You pay for each call once billing is turned on for the key. Google doesn't use paid-tier data to improve its products.",
    trainsOnData: false
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (paid models)',
    kind: 'openrouter',
    baseUrl: null,
    billing: 'paid',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    pricingUrl: 'https://openrouter.ai/models',
    spendUrl: 'https://openrouter.ai/settings/keys',
    spendTip: "OpenRouter bills from credits you buy ahead. You can also set a credit limit on the key.",
    requestsPerMinute: null,
    requestsPerDay: null,
    models: null,
    note: 'You pay for each call from credits you buy, and one key reaches hundreds of models.',
    trainsOnData: false
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible API',
    kind: 'openai_compatible',
    baseUrl: null,
    billing: 'paid',
    needsKey: true,
    keyUrl: null,
    pricingUrl: null,
    spendUrl: null,
    spendTip: null,
    requestsPerMinute: null,
    requestsPerDay: null,
    models: null,
    note: "Use this for Together, DeepSeek, Fireworks and others. Set the address, and mark it free if you won't be charged.",
    trainsOnData: false
  }
]

/** True for addresses on this computer, such as Ollama or LM Studio. Those calls are always free. */
export function isLocalUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

export const PROVIDER_NEEDS_KEY: Record<ProviderKind, boolean> = {
  anthropic: true,
  openai: true,
  gemini: true,
  openrouter: true,
  ollama: false,
  openai_compatible: false
}

/**
 * Suggested models per stage. The settings screen also loads the live model list
 * from the provider, so these are only starting points.
 */
export const SUGGESTED_MODELS: Partial<Record<ProviderKind, Record<LlmStage, string>>> = {
  anthropic: { triage: 'claude-haiku-5-5', writing: 'claude-sonnet-5-5', extraction: 'claude-haiku-5-5' },
  openai: { triage: 'gpt-5-mini', writing: 'gpt-5', extraction: 'gpt-5-mini' },
  gemini: { triage: 'gemini-2.5-flash', writing: 'gemini-2.5-pro', extraction: 'gemini-2.5-flash' }
}

/**
 * Built-in prices in USD per million tokens. Anthropic prices were checked in October 2026.
 * The others are older list prices. Users can correct any of them in Settings, and
 * the user's numbers always win.
 */
export const BUILTIN_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cachedInputPerMTok: 0.01 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cachedInputPerMTok: 0.2 },
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cachedInputPerMTok: 0.25 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 },
  'gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4, cachedInputPerMTok: 0.005 },
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-2.5-flash-lite': { inputPerMTok: 0.1, outputPerMTok: 0.4 }
}

/**
 * A score below the shortlist line is always in the lowest bucket, so a job the app archives is
 * never labeled as a great fit. The cut-offs for perfect and great only apply above the line.
 */
export function bucketFor(score: number, shortlistScore: number): FitBucket {
  if (score < shortlistScore) return 'weak'
  if (score >= 85) return 'perfect'
  if (score >= 70) return 'great'
  return 'good'
}

export const BUCKET_LABELS: Record<FitBucket, string> = {
  perfect: 'Perfect fit',
  great: 'Great fit',
  good: 'Good fit',
  weak: 'Not a fit'
}
