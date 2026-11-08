import type { ApplicationFacts, LanguageLevel } from '@shared/types'

// Pure helpers for the application facts editor, kept apart from the components so they can be tested.

/** How many of the profile's skills get a row of their own in the interview. */
export const TOP_SKILLS = 10

export const COUNTRIES = [
  'United States', 'Canada', 'United Kingdom', 'Ireland', 'Germany', 'France', 'Netherlands', 'Sweden', 'Finland', 'Denmark',
  'Norway', 'Poland', 'Spain', 'Italy', 'Portugal', 'Switzerland', 'Austria', 'Australia', 'New Zealand', 'Japan',
  'Singapore', 'India', 'Brazil', 'Mexico'
]

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'JPY', 'SGD', 'INR', 'BRL', 'MXN']

export const LANGUAGE_LEVELS: Array<{ id: LanguageLevel; label: string }> = [
  { id: 'basic', label: 'Basic' },
  { id: 'conversational', label: 'Conversational' },
  { id: 'fluent', label: 'Fluent' },
  { id: 'native', label: 'Native' }
]

export const CLEARANCES = ['None', 'Public Trust', 'Confidential', 'Secret', 'Top Secret', 'TS/SCI']

/** "German (B1)" gives "German". */
export function languageName(entry: string): string {
  return entry.replace(/\s*[([].*$/, '').replace(/\s*[-–,:].*$/, '').trim()
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The skills that get a row: the profile's top skills first, then any other skill that already has years. */
export function skillRows(skills: string[], skillYears: Record<string, number>): string[] {
  const rows: string[] = []
  for (const name of [...skills.slice(0, TOP_SKILLS), ...Object.keys(skillYears)]) {
    const clean = name.trim()
    if (clean && !rows.some((r) => sameName(r, clean))) rows.push(clean)
  }
  return rows
}

/** The languages that get a row: the profile's languages, then any other language that already has a level. */
export function languageRows(languages: string[], levels: Record<string, LanguageLevel>): string[] {
  const rows: string[] = []
  for (const name of [...languages.map(languageName), ...Object.keys(levels)]) {
    if (name && !rows.some((r) => sameName(r, name))) rows.push(name)
  }
  return rows
}

/** Sets or clears the years for one skill, keeping the other entries and their order. */
export function withSkillYears(skillYears: Record<string, number>, skill: string, years: number | null): Record<string, number> {
  const next: Record<string, number> = {}
  const key = Object.keys(skillYears).find((k) => sameName(k, skill)) ?? skill
  let placed = false
  for (const [k, v] of Object.entries(skillYears)) {
    if (k === key) {
      if (years !== null) next[k] = years
      placed = true
    } else next[k] = v
  }
  if (!placed && years !== null) next[key] = years
  return next
}

/** Sets or clears the level for one language. */
export function withLanguageLevel(levels: Record<string, LanguageLevel>, language: string, level: LanguageLevel | null): Record<string, LanguageLevel> {
  const next: Record<string, LanguageLevel> = {}
  const key = Object.keys(levels).find((k) => sameName(k, language)) ?? language
  let placed = false
  for (const [k, v] of Object.entries(levels)) {
    if (k === key) {
      if (level !== null) next[k] = level
      placed = true
    } else next[k] = v
  }
  if (!placed && level !== null) next[key] = level
  return next
}

/** Drops blank rows and keeps the key order, so a saved profile compares equal to itself. */
export function cleanApplication(facts: ApplicationFacts): ApplicationFacts {
  return {
    ...facts,
    authorization: facts.authorization.filter((a) => a.country.trim()).map((a) => ({ ...a, country: a.country.trim() })),
    salary: facts.salary.filter((s) => s.currency.trim() && (s.min !== null || s.target !== null)),
    relocation: { ...facts.relocation, places: facts.relocation.places.map((p) => p.trim()).filter(Boolean) },
    skillYears: Object.fromEntries(Object.entries(facts.skillYears).filter(([k, v]) => k.trim() && typeof v === 'number' && Number.isFinite(v))),
    languageLevels: Object.fromEntries(Object.entries(facts.languageLevels).filter(([k, v]) => k.trim() && v))
  }
}
