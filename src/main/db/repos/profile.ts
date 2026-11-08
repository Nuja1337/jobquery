import { createHash } from 'node:crypto'
import { EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, Profile, ProfileRecord } from '@shared/types'
import { type Db, now, parseJson } from '../database'

interface ProfileRow {
  data: string
  version: number
  hash: string
  updated_at: string
}

/** Only these fields change a fit score. Notes, voice, facts and links don't. */
function fitHash(p: Profile): string {
  const relevant = {
    headline: p.headline,
    summary: p.summary,
    skills: p.skills,
    experience: p.experience,
    education: p.education,
    projects: p.projects,
    yearsExperience: p.yearsExperience,
    workAuthorization: p.workAuthorization,
    certifications: p.certifications
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
    authorization: Array.isArray(s.authorization) ? s.authorization : base.authorization,
    salary: Array.isArray(s.salary) ? s.salary : base.salary,
    skillYears: { ...base.skillYears, ...(s.skillYears ?? {}) },
    languageLevels: { ...base.languageLevels, ...(s.languageLevels ?? {}) }
  }
}

function withDefaults(stored: Partial<Profile>): Profile {
  const base = structuredClone(EMPTY_PROFILE)
  return {
    ...base,
    ...stored,
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
