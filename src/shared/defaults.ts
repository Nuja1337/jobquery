import type { FitBucket, LlmStage, ModelPrice, Profile, ProviderKind, Settings } from './types'

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
    companyCooldownDays: 90
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
    maxPreparePerRun: 10
  },
  autopilot: {
    enabled: false,
    intervalHours: 6,
    autoPrepare: true,
    autoSubmit: false,
    dailySubmitCap: 10,
    requireNoFlags: true,
    dryRun: false
  },
  browser: {
    channel: 'chrome',
    slowMoMs: 60,
    keepOpen: false
  },
  writing: {
    coverLetterLength: 'medium',
    alwaysCoverLetter: false,
    bannedPhrases: [],
    styleNotes: '',
    minLintScore: 80,
    maxRevisions: 2
  },
  eeo: {
    gender: 'decline',
    race: 'decline',
    veteran: 'decline',
    disability: 'decline',
    pronouns: ''
  },
  onboardingDone: false
}

export const EMPTY_PROFILE: Profile = {
  fullName: '',
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
  voice: null
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
