import { createHash } from 'node:crypto'
import { EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, AuthorizationEntry, Profile, ProfileName, ProfileRecord } from '@shared/types'
import { type Db, now, parseJson } from '../database'

interface ProfileRow {
  data: string
  version: number
  hash: string
  updated_at: string
}

/** Only these fields change a fit score. Notes, voice, free-form facts and links don't. The application facts listed are the ones the fit view shows. */
function fitHash(p: Profile): string {
  const app = p.application
  const relevant = {
    headline: p.headline,
    summary: p.summary,
    skills: p.skills,
    experience: p.experience,
    education: p.education,
    projects: p.projects,
    yearsExperience: p.yearsExperience,
    workAuthorization: p.workAuthorization,
    certifications: p.certifications,
    application: app
      ? {
          authorization: app.authorization,
          citizenships: app.citizenships,
          relocation: app.relocation,
          workArrangement: app.workArrangement,
          languageLevels: app.languageLevels,
          clearance: app.clearance,
          clearanceEligible: app.clearanceEligible
        }
      : null
  }
  return createHash('sha1').update(JSON.stringify(relevant)).digest('hex')
}

/** Fills what a profile saved before the interview existed (or by an older version) lacks. */
function withApplicationDefaults(stored: Partial<ApplicationFacts> | undefined): ApplicationFacts {
  const base = structuredClone(EMPTY_APPLICATION_FACTS)
  const s = stored ?? {}
  return {
    ...base,
    ...s,
    address: { ...base.address, ...(s.address ?? {}) },
    relocation: { ...base.relocation, ...(s.relocation ?? {}) },
    authorization: Array.isArray(s.authorization) ? s.authorization.map(withAuthorizationDefaults) : base.authorization,
    salary: Array.isArray(s.salary) ? s.salary : base.salary,
    skillYears: { ...base.skillYears, ...(s.skillYears ?? {}) },
    languageLevels: { ...base.languageLevels, ...(s.languageLevels ?? {}) },
    workArrangement: { ...base.workArrangement, ...(s.workArrangement ?? {}) },
    employment: {
      ...base.employment,
      ...(s.employment ?? {}),
      currentPay: { ...base.employment.currentPay, ...(s.employment?.currentPay ?? {}) }
    },
    schedule: { ...base.schedule, ...(s.schedule ?? {}) },
    screening: { ...base.screening, ...(s.screening ?? {}) },
    education: { ...base.education, ...(s.education ?? {}) },
    experience: { ...base.experience, ...(s.experience ?? {}) }
  }
}

/** An authorization entry saved before the visa fields existed gets "not answered" for them. */
function withAuthorizationDefaults(entry: AuthorizationEntry): AuthorizationEntry {
  return { visaType: '', expires: null, anyEmployer: null, ...entry }
}

/**
 * The first word of a full name as the first name and the rest as the last name, only when there are two or
 * more words. "Mary Ann Smith" could hold a middle name, so the middle is not part of the result. A single
 * letter right after the first name, with or without a period ("Dana Q. Public"), is the middle name and comes
 * back as `middle`. One word gives nothing.
 */
export function splitFullName(fullName: string): { first: string; middle?: string; last: string } {
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return { first: '', last: '' }
  if (words.length >= 3 && /^\p{L}\.?$/u.test(words[1])) return { first: words[0], middle: words[1], last: words.slice(2).join(' ') }
  return { first: words[0], last: words.slice(1).join(' ') }
}

/** True when the stored first and last name are what splitting this full name gives, so the owner did not type them. */
function isSplitOf(name: ProfileName, fullName: string): boolean {
  const split = splitFullName(fullName)
  if (name.first === split.first && name.last === split.last) return true
  // Names saved by the builds that took the last word as the last name, or everything after the first word.
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  return words.length >= 2 && name.first === words[0] && (name.last === words[words.length - 1] || name.last === words.slice(1).join(' '))
}

/** The stored name over empty defaults. Without a first and last name, they come from the full name. */
function withNameDefaults(stored: Partial<ProfileName> | undefined, fullName: string): ProfileName {
  const name: ProfileName = { ...structuredClone(EMPTY_PROFILE.name), ...(stored ?? {}) }
  if (!name.first.trim() && !name.last.trim()) {
    const split = splitFullName(fullName)
    name.first = split.first
    name.last = split.last
    if (split.middle && !name.middle.trim()) name.middle = split.middle
  }
  return name
}

function withDefaults(stored: Partial<Profile>): Profile {
  const base = structuredClone(EMPTY_PROFILE)
  return {
    ...base,
    ...stored,
    name: withNameDefaults(stored.name, stored.fullName ?? ''),
    links: { ...base.links, ...(stored.links ?? {}) },
    workAuthorization: { ...base.workAuthorization, ...(stored.workAuthorization ?? {}) },
    application: withApplicationDefaults(stored.application)
  }
}

export class ProfileRepo {
  constructor(private readonly db: Db) {}

  get(): ProfileRecord {
    const row = this.db.get<ProfileRow>('SELECT * FROM profile WHERE id = 1')
    if (!row) return { profile: structuredClone(EMPTY_PROFILE), version: 0, updatedAt: null }
    return {
      profile: withDefaults(parseJson<Partial<Profile>>(row.data, {})),
      version: row.version,
      updatedAt: row.updated_at
    }
  }

  /** Saves the profile. The version goes up only when something that affects fit scoring changed. */
  save(input: Profile): ProfileRecord {
    const profile = withDefaults(input)
    const hash = fitHash(profile)
    const existing = this.db.get<ProfileRow>('SELECT * FROM profile WHERE id = 1')
    // A new full name re-splits the name parts, unless the owner typed them by hand.
    if (existing) {
      const oldName = parseJson<Partial<Profile>>(existing.data, {}).fullName ?? ''
      if (oldName.trim() !== profile.fullName.trim() && isSplitOf(profile.name, oldName)) {
        profile.name = { ...profile.name, ...splitFullName(profile.fullName) }
      }
    }
    const version = !existing ? 1 : existing.hash === hash ? existing.version : existing.version + 1
    this.db.run(
      `INSERT INTO profile (id, data, version, hash, updated_at) VALUES (1, :data, :version, :hash, :at)
       ON CONFLICT(id) DO UPDATE SET data = :data, version = :version, hash = :hash, updated_at = :at`,
      { data: JSON.stringify(profile), version, hash, at: now() }
    )
    // A changed profile may fix a job that kept failing to score, so give every job a fresh start.
    if (existing && version !== existing.version) this.db.run('UPDATE jobs SET triage_failures = 0 WHERE triage_failures != 0')
    return this.get()
  }
}
