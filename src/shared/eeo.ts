import { DEFAULT_SETTINGS } from './defaults'
import type {
  EeoSettings,
  GenderId,
  HouseholdOccupationId,
  PronounsId,
  RaceId,
  ReligionId,
  SchoolTypeId,
  SexualOrientationId,
  SocioeconomicSettings,
  UkEthnicityId,
  VeteranCategoryId,
  VeteranId,
  YesNoDecline
} from './types'

// Ids and labels for the self-identification settings. The ids are stored in the database, so they
// never change. The labels are for the settings card only. Forms use their own option text, which the
// matcher in main/apply/demographics.ts maps from these ids.

export const GENDER_LABELS: Record<GenderId, string> = {
  man: 'Man',
  woman: 'Woman',
  non_binary: 'Non-binary',
  self_describe: 'Self-describe',
  decline: 'Decline to answer'
}

export const YES_NO_DECLINE_LABELS: Record<YesNoDecline, string> = { yes: 'Yes', no: 'No', decline: 'Decline to answer' }

export const RACE_LABELS: Record<RaceId, string> = {
  american_indian: 'American Indian or Alaska Native',
  asian: 'Asian',
  asian_east: 'East Asian',
  asian_south: 'South Asian',
  asian_southeast: 'Southeast Asian',
  black: 'Black or African American',
  mena: 'Middle Eastern or North African',
  pacific_islander: 'Native Hawaiian or Pacific Islander',
  white: 'White'
}

export const VETERAN_LABELS: Record<VeteranId, string> = {
  not_protected: 'I am not a protected veteran',
  protected: 'I am a protected veteran',
  decline: 'Decline to answer'
}

export const VETERAN_CATEGORY_LABELS: Record<VeteranCategoryId, string> = {
  disabled: 'Disabled veteran',
  recently_separated: 'Recently separated veteran',
  active_wartime: 'Active duty wartime or campaign badge veteran',
  service_medal: 'Armed Forces service medal veteran'
}

export const SEXUAL_ORIENTATION_LABELS: Record<SexualOrientationId, string> = {
  asexual: 'Asexual',
  bisexual_pansexual: 'Bisexual or pansexual',
  gay: 'Gay',
  heterosexual: 'Heterosexual',
  lesbian: 'Lesbian',
  queer: 'Queer',
  self_describe: 'Self-describe'
}

export const PRONOUNS_LABELS: Record<PronounsId, string> = {
  he: 'he/him',
  she: 'she/her',
  they: 'they/them',
  name_only: 'Use my name only',
  custom: 'Other',
  decline: 'Decline to answer'
}

// The 2021 ONS ethnic groups (England and Wales census) and their 19 subgroups.
export const UK_ETHNICITY_LABELS: Record<UkEthnicityId, string> = {
  asian_bangladeshi: 'Asian: Bangladeshi',
  asian_chinese: 'Asian: Chinese',
  asian_indian: 'Asian: Indian',
  asian_pakistani: 'Asian: Pakistani',
  asian_other: 'Asian: Any other Asian background',
  black_african: 'Black: African',
  black_caribbean: 'Black: Caribbean',
  black_other: 'Black: Any other Black, Black British or Caribbean background',
  mixed_white_asian: 'Mixed or Multiple: White and Asian',
  mixed_white_black_african: 'Mixed or Multiple: White and Black African',
  mixed_white_black_caribbean: 'Mixed or Multiple: White and Black Caribbean',
  mixed_other: 'Mixed or Multiple: Any other Mixed or Multiple background',
  white_british: 'White: English, Welsh, Scottish, Northern Irish or British',
  white_irish: 'White: Irish',
  white_gypsy_traveller: 'White: Gypsy or Irish Traveller',
  white_roma: 'White: Roma',
  white_other: 'White: Any other White background',
  other_arab: 'Other: Arab',
  other_any: 'Other: Any other ethnic group',
  decline: 'Decline to answer'
}

export const RELIGION_LABELS: Record<ReligionId, string> = {
  none: 'No religion',
  christian: 'Christian',
  buddhist: 'Buddhist',
  hindu: 'Hindu',
  jewish: 'Jewish',
  muslim: 'Muslim',
  sikh: 'Sikh',
  other: 'Any other religion',
  decline: 'Decline to answer'
}

export const HOUSEHOLD_OCCUPATION_LABELS: Record<HouseholdOccupationId, string> = {
  modern_professional: 'Modern professional (teacher, nurse, software designer)',
  clerical_intermediate: 'Clerical and intermediate (secretary, call center agent)',
  senior_manager: 'Senior manager or administrator',
  technical_craft: 'Technical and craft (mechanic, plumber, electrician)',
  semi_routine: 'Semi-routine manual and service (retail assistant, care assistant)',
  routine: 'Routine manual and service (driver, cleaner, laborer)',
  middle_manager: 'Middle or junior manager',
  traditional_professional: 'Traditional professional (accountant, solicitor, doctor, engineer)',
  long_term_unemployed: 'Long-term unemployed',
  retired: 'Retired',
  not_applicable: 'Does not apply to me',
  decline: 'Decline to answer'
}

export const SCHOOL_TYPE_LABELS: Record<SchoolTypeId, string> = {
  state_non_selective: 'State school, non-selective',
  state_selective: 'State school, selective',
  independent: 'Independent or fee-paying school',
  independent_bursary: 'Independent school with a bursary of 90% or more',
  outside_uk: 'School outside the UK',
  decline: 'Decline to answer'
}

const ids = <T extends string>(labels: Record<T, string>): T[] => Object.keys(labels) as T[]

export const GENDER_IDS = ids(GENDER_LABELS)
export const YES_NO_DECLINE_IDS = ids(YES_NO_DECLINE_LABELS)
export const RACE_IDS = ids(RACE_LABELS)
export const VETERAN_IDS = ids(VETERAN_LABELS)
export const VETERAN_CATEGORY_IDS = ids(VETERAN_CATEGORY_LABELS)
export const SEXUAL_ORIENTATION_IDS = ids(SEXUAL_ORIENTATION_LABELS)
export const PRONOUNS_IDS = ids(PRONOUNS_LABELS)
export const UK_ETHNICITY_IDS = ids(UK_ETHNICITY_LABELS)
export const RELIGION_IDS = ids(RELIGION_LABELS)
export const HOUSEHOLD_OCCUPATION_IDS = ids(HOUSEHOLD_OCCUPATION_LABELS)
export const SCHOOL_TYPE_IDS = ids(SCHOOL_TYPE_LABELS)

export const EEO_VERSION = 2
export const MIN_BIRTH_YEAR = 1900
const MAX_TEXT = 200

/** The defaults: every family declines. */
export const defaultEeo = (): EeoSettings => structuredClone(DEFAULT_SETTINGS.eeo)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** The known ids in a list, once each, in the order of the id list so the stored JSON stays stable. */
function pickList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return []
  return allowed.filter((id) => value.includes(id))
}

const text = (value: unknown): string => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '')

function birthYear(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= MIN_BIRTH_YEAR && value <= new Date().getFullYear() ? value : null
}

function socioeconomic(value: unknown): SocioeconomicSettings {
  const d = defaultEeo().socioeconomic
  const raw = isRecord(value) ? value : {}
  return {
    householdOccupation: pick(raw.householdOccupation, HOUSEHOLD_OCCUPATION_IDS, d.householdOccupation),
    schoolType: pick(raw.schoolType, SCHOOL_TYPE_IDS, d.schoolType),
    freeSchoolMeals: pick(raw.freeSchoolMeals, YES_NO_DECLINE_IDS, d.freeSchoolMeals),
    parentDegree: pick(raw.parentDegree, YES_NO_DECLINE_IDS, d.parentDegree)
  }
}

function fromCurrent(raw: Record<string, unknown>): EeoSettings {
  const d = defaultEeo()
  const veteran = pick(raw.veteran, VETERAN_IDS, d.veteran)
  return {
    version: EEO_VERSION,
    gender: pick(raw.gender, GENDER_IDS, d.gender),
    genderText: text(raw.genderText),
    transgender: pick(raw.transgender, YES_NO_DECLINE_IDS, d.transgender),
    hispanicLatino: pick(raw.hispanicLatino, YES_NO_DECLINE_IDS, d.hispanicLatino),
    race: pickList(raw.race, RACE_IDS),
    veteran,
    // Categories only mean something for a protected veteran.
    veteranCategories: veteran === 'protected' ? pickList(raw.veteranCategories, VETERAN_CATEGORY_IDS) : [],
    militaryService: pick(raw.militaryService, YES_NO_DECLINE_IDS, d.militaryService),
    militarySpouse: pick(raw.militarySpouse, YES_NO_DECLINE_IDS, d.militarySpouse),
    disability: pick(raw.disability, YES_NO_DECLINE_IDS, d.disability),
    sexualOrientation: pickList(raw.sexualOrientation, SEXUAL_ORIENTATION_IDS),
    sexualOrientationText: text(raw.sexualOrientationText),
    lgbtq: pick(raw.lgbtq, YES_NO_DECLINE_IDS, d.lgbtq),
    pronouns: pick(raw.pronouns, PRONOUNS_IDS, d.pronouns),
    pronounsText: text(raw.pronounsText),
    birthYear: birthYear(raw.birthYear),
    ukEthnicity: pick(raw.ukEthnicity, UK_ETHNICITY_IDS, d.ukEthnicity),
    religion: pick(raw.religion, RELIGION_IDS, d.religion),
    caring: pick(raw.caring, YES_NO_DECLINE_IDS, d.caring),
    socioeconomic: socioeconomic(raw.socioeconomic),
    neurodivergent: pick(raw.neurodivergent, YES_NO_DECLINE_IDS, d.neurodivergent)
  }
}

// ---------------------------------------------------------------------------
// Rows saved before version 2: { gender, race, veteran, disability, pronouns } as free text.
// ---------------------------------------------------------------------------

/** Blank text, whitespace and wording that declines. */
const DECLINES = /^\s*$|decline|prefer not|prefer to not|rather not|choose not|do(?:n['’]?t| not) (?:wish|want)|not to (?:say|answer|disclose)|\bno answer\b|^n\/?a$/i

const legacyText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function legacyGender(raw: string): Pick<EeoSettings, 'gender' | 'genderText'> {
  const t = raw.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (DECLINES.test(raw)) return { gender: 'decline', genderText: '' }
  if (/^(?:male|man|m|cis(?:gender)? (?:male|man)|boy)$/.test(t)) return { gender: 'man', genderText: '' }
  if (/^(?:female|woman|f|cis(?:gender)? (?:female|woman)|girl)$/.test(t)) return { gender: 'woman', genderText: '' }
  if (/^(?:non ?binary|nonbinary|enby|genderqueer|gender non ?conforming|genderfluid|gender fluid)$/.test(t)) return { gender: 'non_binary', genderText: '' }
  return { gender: 'self_describe', genderText: text(raw) }
}

function legacyRace(raw: string): Pick<EeoSettings, 'hispanicLatino' | 'race'> {
  if (DECLINES.test(raw)) return { hispanicLatino: 'decline', race: [] }
  const t = raw.toLowerCase()
  let hispanicLatino: YesNoDecline = 'decline'
  if (/\bnot (?:of )?(?:hispanic|latin)|\bnon-?hispanic/.test(t)) hispanicLatino = 'no'
  else if (/hispanic|\blatin[oaxe]?\b|spanish origin/.test(t)) hispanicLatino = 'yes'
  const found = new Set<RaceId>()
  if (/american indian|alaska|native american|indigenous/.test(t)) found.add('american_indian')
  if (/southeast asian|south east asian/.test(t)) found.add('asian_southeast')
  else if (/\beast asian/.test(t)) found.add('asian_east')
  else if (/south asian|asian indian/.test(t)) found.add('asian_south')
  else if (/\basian\b/.test(t)) found.add('asian')
  if (/black|african american|african descent/.test(t)) found.add('black')
  if (/middle east|north africa|\bmena\b|\barab/.test(t)) found.add('mena')
  if (/pacific islander|hawaiian/.test(t)) found.add('pacific_islander')
  if (/\bwhite\b|caucasian|european/.test(t)) found.add('white')
  return { hispanicLatino, race: RACE_IDS.filter((id) => found.has(id)) }
}

function legacyVeteran(raw: string): VeteranId {
  if (DECLINES.test(raw)) return 'decline'
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  if (/^(?:no|n|none)\b/.test(t) || /\bnot (?:a )?(?:protected )?veteran|not a protected|\bno protected/.test(t)) return 'not_protected'
  if (/protected veteran|disabled veteran|identify as one or more/.test(t)) return 'protected'
  return 'decline'
}

function legacyDisability(raw: string): YesNoDecline {
  if (DECLINES.test(raw)) return 'decline'
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  if (/^(?:no|n|none)\b/.test(t) || /do(?:es)? not have a disability|\bno disabilit|not disabled/.test(t)) return 'no'
  if (/^(?:yes|y)\b/.test(t) || /^i (?:have|do have) a disability/.test(t)) return 'yes'
  return 'decline'
}

function legacyPronouns(raw: string): Pick<EeoSettings, 'pronouns' | 'pronounsText'> {
  if (DECLINES.test(raw)) return { pronouns: 'decline', pronounsText: '' }
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  if (/^he(?: ?[/,] ?him)?$/.test(t)) return { pronouns: 'he', pronounsText: '' }
  if (/^she(?: ?[/,] ?her)?$/.test(t)) return { pronouns: 'she', pronounsText: '' }
  if (/^they(?: ?[/,] ?them)?$/.test(t)) return { pronouns: 'they', pronounsText: '' }
  return { pronouns: 'custom', pronounsText: text(raw) }
}

function fromLegacy(raw: Record<string, unknown>): EeoSettings {
  return {
    ...defaultEeo(),
    ...legacyGender(legacyText(raw.gender)),
    ...legacyRace(legacyText(raw.race)),
    veteran: legacyVeteran(legacyText(raw.veteran)),
    disability: legacyDisability(legacyText(raw.disability)),
    ...legacyPronouns(legacyText(raw.pronouns))
  }
}

/**
 * Reads a stored or incoming eeo value of any shape and returns version 2. Call it on the raw value,
 * before merging over defaults, because the defaults already carry a version and would hide an old
 * row. A malformed value gives the defaults. Unknown keys are ignored.
 */
export function normalizeEeo(raw: unknown): EeoSettings {
  if (!isRecord(raw)) return defaultEeo()
  const current = typeof raw.version === 'number' && raw.version >= EEO_VERSION
  return current ? fromCurrent(raw) : fromLegacy(raw)
}
