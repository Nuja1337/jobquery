import { EMPTY_PROFILE_NAME } from '@shared/defaults'
import type { ApplicationFacts, EducationLevel, EmploymentType, JobPreferences, PlatformKind, Profile, ProfileName, RemotePreference, SalaryPeriod, VisaType } from '@shared/types'

// Pure helpers for the work and availability editors, kept apart from the components so they can be tested.

export const EMPLOYMENT_TYPES: Array<{ id: EmploymentType; label: string }> = [
  { id: 'full_time', label: 'Full time' },
  { id: 'part_time', label: 'Part time' },
  { id: 'contract', label: 'Contract' },
  { id: 'contract_to_hire', label: 'Contract to hire' },
  { id: 'temporary', label: 'Temporary' },
  { id: 'internship', label: 'Internship' },
  { id: 'freelance', label: 'Freelance' }
]

export const EDUCATION_LEVELS: Array<{ id: EducationLevel; label: string }> = [
  { id: 'high_school', label: 'High school' },
  { id: 'some_college', label: 'Some college' },
  { id: 'associate', label: 'Associate degree' },
  { id: 'bachelor', label: "Bachelor's degree" },
  { id: 'master', label: "Master's degree" },
  { id: 'doctorate', label: 'Doctorate' }
]

export const VISA_TYPES: Array<{ id: Exclude<VisaType, ''>; label: string }> = [
  { id: 'f1_opt', label: 'F-1 OPT' },
  { id: 'stem_opt', label: 'STEM OPT' },
  { id: 'h1b', label: 'H-1B' },
  { id: 'tn', label: 'TN' },
  { id: 'other', label: 'Other' }
]

export const PLATFORMS: Array<{ id: PlatformKind; label: string }> = [
  { id: 'pc', label: 'PC' },
  { id: 'console', label: 'Console' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'vr', label: 'VR' },
  { id: 'web', label: 'Web' }
]

export const PAY_PERIODS: Array<{ id: SalaryPeriod; label: string }> = [
  { id: 'year', label: 'Per year' },
  { id: 'month', label: 'Per month' },
  { id: 'hour', label: 'Per hour' }
]

/** Adds the item when it is missing and removes it when it is there. */
export function toggled<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

/** The three-way answer as a select value. null stays apart from No. */
export const triValue = (v: boolean | null | undefined): string => (v === null || v === undefined ? '' : v ? 'yes' : 'no')
export const triParse = (s: string): boolean | null => (s === '' ? null : s === 'yes')

const REMOTE_ORDER: RemotePreference[] = ['remote', 'hybrid', 'onsite']

/** True while the filter is untouched: all three work styles on and no employment type chosen. */
export function filterIsDefault(prefs: Pick<JobPreferences, 'remote' | 'employmentTypes'>): boolean {
  return REMOTE_ORDER.every((r) => prefs.remote.includes(r)) && prefs.remote.length === REMOTE_ORDER.length && prefs.employmentTypes.length === 0
}

/**
 * What the job filter takes from the answers. A work style the person ruled out with No leaves the filter,
 * while Yes and Not answered stay in. Employment types copy over as chosen. Returns null when nothing changes.
 */
export function filterFromAnswers(facts: Pick<ApplicationFacts, 'workArrangement' | 'employment'>): Pick<JobPreferences, 'remote' | 'employmentTypes'> | null {
  const w = facts.workArrangement
  const answers: Record<RemotePreference, boolean | null> = { remote: w.remote, hybrid: w.hybrid, onsite: w.onsite }
  const remote = REMOTE_ORDER.filter((r) => answers[r] !== false)
  // Ruling out all three would leave no job, so that case keeps the default.
  const narrowed = remote.length > 0 && remote.length < REMOTE_ORDER.length
  const types = facts.employment.types
  if (!narrowed && types.length === 0) return null
  return { remote: narrowed ? remote : [...REMOTE_ORDER], employmentTypes: [...types] }
}

/** Fills the filter from the answers only while the filter is still at its default. */
export function fillFilterFromAnswers(prefs: JobPreferences, facts: Pick<ApplicationFacts, 'workArrangement' | 'employment'>): JobPreferences {
  if (!filterIsDefault(prefs)) return prefs
  const fill = filterFromAnswers(facts)
  return fill ? { ...prefs, ...fill } : prefs
}

/** The first word of a full name as the first name and the rest as the last name, when it has two or more words. A single letter right after the first name is the middle name. Keep identical to the main copy. */
export function splitFullName(fullName: string): { first: string; middle?: string; last: string } {
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return { first: '', last: '' }
  if (words.length >= 3 && /^\p{L}\.?$/u.test(words[1])) return { first: words[0], middle: words[1], last: words.slice(2).join(' ') }
  return { first: words[0], last: words.slice(1).join(' ') }
}

/** The stored name parts. With no first and last name yet, they come from the full name. */
export function nameParts(p: Pick<Profile, 'fullName' | 'name'>): ProfileName {
  const name: ProfileName = { ...EMPTY_PROFILE_NAME, ...(p.name ?? {}) }
  if (!name.first.trim() && !name.last.trim()) {
    const split = splitFullName(p.fullName)
    return { ...name, ...split, middle: split.middle ?? name.middle }
  }
  return name
}

const trimmed = (xs: string[]): string[] => xs.map((x) => x.trim()).filter(Boolean)

/** True for the clearance value the old editor saved when "Other" had no name. */
export const isUnnamedOtherClearance = (clearance: string): boolean => clearance.trim().toLowerCase() === 'other'

/** Drops blank list entries and an unnamed "Other" clearance, and keeps the key order. */
export function cleanWorkFacts(facts: ApplicationFacts): ApplicationFacts {
  return {
    ...facts,
    clearance: isUnnamedOtherClearance(facts.clearance) ? '' : facts.clearance.trim(),
    workArrangement: { ...facts.workArrangement, commutableCities: trimmed(facts.workArrangement.commutableCities) },
    employment: { ...facts.employment, desiredTitle: facts.employment.desiredTitle.trim() },
    schedule: { ...facts.schedule, timeZones: trimmed(facts.schedule.timeZones) },
    education: {
      ...facts.education,
      expectedGraduation: facts.education.expectedGraduation || null,
      fields: trimmed(facts.education.fields),
      relatedFields: trimmed(facts.education.relatedFields)
    },
    citizenships: trimmed(facts.citizenships)
  }
}
