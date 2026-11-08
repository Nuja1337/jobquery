import { RACE_LABELS, RELIGION_LABELS, SEXUAL_ORIENTATION_LABELS, VETERAN_CATEGORY_IDS } from '@shared/eeo'
import type {
  EeoSettings,
  FormField,
  HouseholdOccupationId,
  RaceId,
  SchoolTypeId,
  Settings,
  SexualOrientationId,
  UkEthnicityId,
  VeteranCategoryId,
  YesNoDecline
} from '@shared/types'
import { isChoice, pickOption, type MappedAnswer } from './fieldMap'

// Voluntary self-identification (race, gender, veteran status and the like). These questions are
// answered from the owner's settings, the form's decline option, or the owner's exact saved answer.
// They never go to the AI and never get a guess.

export type DemographicFamily =
  | 'gender'
  | 'pronouns'
  | 'transgender'
  | 'sexual_orientation'
  | 'lgbtq'
  | 'race'
  | 'hispanic'
  | 'veteran'
  | 'military_spouse'
  | 'disability'
  | 'age'
  | 'religion'
  | 'marital'
  | 'pregnancy'
  | 'caring'
  | 'socioeconomic'
  | 'school_type'
  | 'parent_degree'
  | 'neurodivergent'
  | 'identity'

/** The part of a saved answer this file reads. */
export interface SavedChoice {
  answer: string
  kind: 'fact' | 'template'
}

/** Options that decline to answer, in the wordings forms use. */
export const DECLINE =
  /decline|prefer not|prefer to not|(?:do(?:n['’]?t| not)) (?:wish|want) to (?:answer|say|disclose|identify|self[- ]?identify|provide|share|respond)|don['’]?t wish|do not wish|not to (?:say|disclose|answer|self.?identify|provide|respond)|rather not|choose not|\bno answer\b|\bnot (?:specified|disclosed|declared)\b/i

// An option that states a status as well as declining, such as "I identify as a protected veteran, but
// choose not to self-identify the classification(s)". Picking it would assert the status.
const ASSERTS_STATUS = /^\s*(?:yes\b|i am\b|i['’]m\b|i identify\b|i have\b|i was\b|i previously\b|i served\b)/i

/**
 * The one option that declines, or null. Options that also assert a status are dropped, and several
 * candidates give null, so the field is left for the person instead of guessed.
 */
export function declineOption(options: string[]): string | null {
  const candidates = options.filter((o) => DECLINE.test(o) && !ASSERTS_STATUS.test(o))
  return candidates.length === 1 ? candidates[0] : null
}

// Types that can hold a self-identification answer. A text area is a written answer, never one of these.
const SELF_ID_TYPES = new Set(['select', 'radio', 'combobox', 'multiselect', 'checkboxes', 'checkbox', 'text', 'date', 'number'])

// Words that show the label is something else: a coding question, a game design question, a rating.
const NOT_SELF_ID =
  /\b(?:race conditions?|data races?|race (?:track|car|mode|game|day)|racing|debug\w*|players?|gamers?|games?|gaming|accessib\w*|accommodat\w*|representation|industry|esrb|ratings?|rated|violence|design\w*|develop\w*|engineer\w*|experience|skills?|projects?|built|build\w*|shipped|worked|example|explain|why|localiz\w*|market\w*|storylines?|content|audiences?|characters?|thread\w*)\b/i

// Wording that self-identification questions use. A long label needs one of these.
const SELF_ID_WORDING =
  /\b(?:identif\w*|lived experience of|self[- ]?(?:id|describ)\w*|describes? (?:you|your)|consider (?:yourself|myself)|member of|voluntary|eeo\w*|equal (?:employment )?opportunity|assigned at birth|(?:are|do|have|did|were) you\b|what (?:is|are|was|were) your|which (?:of the following )?|please (?:select|choose|indicate|specify|state)|mark all|select all|check all|(?:did|do|does) (?:either|any|both) of your|free school meals|socio-?economic|caring responsibilit\w*|school (?:did you|you) attend|(?:aged?|age of|around|about) 14\b)/i

const SHORT_LABEL_WORDS = 8

/** The last sentence that ends in a question mark, or the last sentence when none does. */
function questionSentence(label: string): string {
  const parts = label.split(/(?<=[.?!])\s+/).filter(Boolean)
  const asked = parts.filter((p) => p.endsWith('?'))
  const last = asked.length > 0 ? asked[asked.length - 1] : (parts[parts.length - 1] ?? label)
  // "To help us improve representation, how would you describe your gender?" asks the part after the comma.
  return last.replace(/^(?:to|in order to|so that|so we can)\b[^,]*,\s*(?=(?:how|what|which|do|are|please)\b)/, '')
}

/** The label without "(optional)" and other bracketed notes, lowercased. */
const core = (label: string): string => label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\([^)]*\)/g, ' ').replace(/[*:]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

const PATTERNS: Array<[DemographicFamily, RegExp]> = [
  ['military_spouse', /military spouse|spouse of (?:a )?(?:veteran|service ?member|military)|military dependent/],
  ['pronouns', /\bpronouns?\b/],
  ['transgender', /\btransgender\b|\btrans (?:man|woman|person|experience|status)\b|same as (?:the )?sex (?:you were )?assigned/],
  ['sexual_orientation', /\bsexual (?:orientation|identity|preference)\b|^orientation$/],
  ['lgbtq', /\blgbt\w*|\bqueer\b|\blgb\b/],
  ['veteran', /\bveterans?\b|armed forces|\bvevraa\b|military (?:service|status)|served in the (?:military|armed)|branch of (?:the )?(?:service|military)/],
  // Before disability, since a caring question often mentions a disabled adult.
  ['caring', /\bcaring responsibilit\w*|\bcarers?\b|\bcaregivers?\b|care responsibilit\w*/],
  ['disability', /\bdisabilit(?:y|ies)\b|\bdisabled\b/],
  ['race', /\brace\b|\bracial\b|\bethnic\w*|\byour (?:asian|black|white|mixed|african|caribbean|arab)\b[a-z /,-]{0,40}\b(?:background|heritage)\b/],
  ['hispanic', /\bhispanic|\blatinx?\b|\blatino|\blatina|\blatine\b|spanish origin/],
  ['gender', /\bgender\b|\bsex\b/],
  ['neurodivergent', /\bneurodiver\w*|\bneurotypical|\bdyslex\w*|\badhd\b|\bautis\w*/],
  ['religion', /\breligio(?:n|us)\b/],
  ['marital', /\bmarital\b|\bmarri(?:ed|age)\b|civil partnership/],
  ['pregnancy', /\bpregnan\w*|\bmaternity\b/],
  ['socioeconomic', /free school meals|socio-?economic|household (?:main )?(?:earner|income|occupation)|main (?:household |income )?earner|chief income earner|occupation of (?:your )?(?:main |primary )?(?:parent|guardian|earner)|(?:parent|guardian)s?(?:['’]s?)? (?:main )?occupation|working[- ]class/],
  ['school_type', /\btype of school|school (?:did you|you) attend\b.{0,40}\b(?:state|private|independent|fee|selective|grammar)\b|\b(?:state|private|independent|fee|selective|grammar)\b.{0,40}\bschool (?:did you|you) attend|state[- ]funded|fee[- ]paying|independent (?:or )?fee|attended a (?:state|private|independent) school/],
  ['parent_degree', /first[- ]generation|first in your family|(?:parent|guardian)s?\b.{0,40}\b(?:degree|universit|college)/],
  ['age', /\bage (?:band|bands|range|group|bracket|category)\b|\bdate of birth|\bbirth ?date\b|\bdob\b|\byear of birth|\bbirth year|\bhow old\b|^(?:your |what is your |please (?:state|enter) your )?age$|\b(?:aged?|over|under) (?:40|forty)\b|\b40 (?:years|or (?:older|over))/],
  ['identity', /\bhow do you identify\b|\bdo you identify as\b|\bidentify as\b/]
]

/**
 * The self-identification family a field belongs to, or null. A label counts only when it is short
 * (such as "Race" or "Veteran status") or uses self-identification wording. A text area never counts,
 * and neither does a label about code, game design or ratings, such as "Describe a race condition".
 */
export function demographicFamily(field: FormField): DemographicFamily | null {
  if (!SELF_ID_TYPES.has(field.type)) return null
  const label = core(field.label)
  // The exclusions read the question only, so an intro such as "a more diverse games industry" does not drop it.
  if (!label || NOT_SELF_ID.test(questionSentence(label).replace(/\blived experience of\b/g, ' '))) return null
  const wordCount = label.split(' ').length
  if (wordCount > SHORT_LABEL_WORDS && !SELF_ID_WORDING.test(label)) return null
  const hit = PATTERNS.find(([, re]) => re.test(label))
  return hit ? hit[0] : null
}

// ---------------------------------------------------------------------------
// Matching the owner's settings to a form's options
// ---------------------------------------------------------------------------

/**
 * What a family resolves to: the values to fill, 'decline' when the setting declines (or says nothing),
 * or null when the setting says something that no option or box can hold.
 */
type Resolved = string[] | 'decline' | null

interface Ctx {
  field: FormField
  /** The label without brackets, lowercased. */
  label: string
  /** The options of a choice field. Empty for a text box or a checkbox. */
  options: string[]
  multi: boolean
  eeo: EeoSettings
  year: number
}

type Want = boolean | 'decline' | null

const isDecline = (option: string): boolean => DECLINE.test(option) && !ASSERTS_STATUS.test(option)

/**
 * The only option that fits, trying the patterns in order from strict to loose. A pattern that fits
 * several options is skipped, and none fitting gives null. Decline options are never candidates.
 */
function oneOf(options: string[], ...tiers: RegExp[]): string | null {
  const pool = options.filter((o) => !isDecline(o))
  for (const re of tiers) {
    const hits = pool.filter((o) => re.test(o.trim()))
    if (hits.length === 1) return hits[0]
  }
  return null
}

const pickOne = (option: string | null): Resolved => (option ? [option] : null)

const wantOf = (value: YesNoDecline): Want => (value === 'yes' ? true : value === 'no' ? false : 'decline')

interface Fallback {
  yes?: RegExp[]
  no?: RegExp[]
}

/** Yes or No from a list. Options such as "Yes, I have a disability..." count, and so do the given patterns. */
function yesNo(options: string[], want: boolean, fallback: Fallback = {}): Resolved {
  const pool = options.filter((o) => !isDecline(o))
  return pickOne(pickOption(pool, want ? 'Yes' : 'No') ?? oneOf(pool, ...((want ? fallback.yes : fallback.no) ?? [])))
}

/** Fills a yes/no family into a checkbox, a text box or a list. */
function applyWant(c: Ctx, want: Want, fallback: Fallback = {}): Resolved {
  if (want === 'decline' || want === null) return want
  if (c.field.type === 'checkbox') return want ? ['true'] : null
  if (c.options.length === 0) return [want ? 'Yes' : 'No']
  return yesNo(c.options, want, fallback)
}

const SELF_DESCRIBE = /self[- ]?describe|\bnot listed\b|prefer to describe|^other\b|^another\b|something else/i

/** The text the owner wrote, as an option of its own or as the list's "self-describe" option. */
function selfDescribe(options: string[], text: string): Resolved {
  const wanted = text.trim().toLowerCase()
  if (!wanted) return null
  const exact = options.find((o) => o.trim().toLowerCase() === wanted && !isDecline(o))
  return exact ? [exact] : pickOne(oneOf(options, SELF_DESCRIBE))
}

// --- Gender ---------------------------------------------------------------

const GENDER_TEXT = { man: 'Male', woman: 'Female', non_binary: 'Non-binary' } as const

const MAN = [/^(?:male|man)$/i, /^(?:male|man)\s*(?:[/(,].*)?$/i]
const WOMAN = [/^(?:female|woman)$/i, /^(?:female|woman)\s*(?:[/(,].*)?$/i]
const CIS_MAN = /^cis(?:gender)?\W*(?:male|man)$/i
const CIS_WOMAN = /^cis(?:gender)?\W*(?:female|woman)$/i
const NON_BINARY = [/non[- ]?binary/i, /genderqueer|gender non[- ]?conforming|gender variant|gender[- ]?fluid|third gender|enby/i]

function gender(c: Ctx): Resolved {
  const id = c.eeo.gender
  if (id === 'decline') return 'decline'
  if (c.options.length === 0) {
    const text = id === 'self_describe' ? c.eeo.genderText.trim() : GENDER_TEXT[id]
    return text ? [text] : null
  }
  if (id === 'self_describe') return selfDescribe(c.options, c.eeo.genderText)
  // "Cisgender male" only fits an owner who said they are not transgender. Declining or saying yes never picks it.
  const cis = c.eeo.transgender !== 'no' ? [] : id === 'man' ? [CIS_MAN] : id === 'woman' ? [CIS_WOMAN] : []
  const tiers = id === 'man' ? MAN : id === 'woman' ? WOMAN : NON_BINARY
  const picked = pickOne(oneOf(c.options, ...tiers, ...cis))
  // A list that has only cisgender and transgender wordings is left to the decline option.
  if (!picked && c.eeo.transgender === 'decline' && c.options.some((o) => CIS_MAN.test(o) || CIS_WOMAN.test(o))) return 'decline'
  return picked
}

// --- Pronouns -------------------------------------------------------------

const PRONOUN_TIERS = {
  he: [/^he\s*[/,]\s*him(?:\s*[/,]\s*his)?$/i, /^(?:he|him)$/i],
  she: [/^she\s*[/,]\s*her(?:\s*[/,]\s*hers)?$/i, /^(?:she|her)$/i],
  they: [/^they\s*[/,]\s*them(?:\s*[/,]\s*theirs)?$/i, /^(?:they|them)$/i]
} as const
const PRONOUN_TEXT = { he: 'he/him', she: 'she/her', they: 'they/them' } as const
const NAME_ONLY = /\buse (?:my )?name\b|\bname only\b|\bno pronouns\b|\bdon['’]?t use pronouns\b|\bwithout pronouns\b|^none$/i

function pronouns(c: Ctx): Resolved {
  const id = c.eeo.pronouns
  if (id === 'decline') return 'decline'
  const text = c.eeo.pronounsText.trim()
  if (c.options.length === 0) {
    if (id === 'name_only') return 'decline'
    if (id === 'custom') return text ? [text] : null
    return [PRONOUN_TEXT[id]]
  }
  if (id === 'name_only') return pickOne(oneOf(c.options, NAME_ONLY))
  if (id === 'custom') {
    const squash = (s: string): string => s.toLowerCase().replace(/[\s.]+/g, '')
    const exact = text ? c.options.find((o) => squash(o) === squash(text) && !isDecline(o)) : undefined
    if (exact) return [exact]
    return text ? pickOne(oneOf(c.options, SELF_DESCRIBE)) : null
  }
  return pickOne(oneOf(c.options, ...PRONOUN_TIERS[id]))
}

// --- Transgender ----------------------------------------------------------

// "Is your gender identity the same as the sex you were assigned at birth?" asks the opposite question.
const INVERTED_TRANS = /(?:same as|matches?|corresponds? (?:to|with)|consistent with|aligns? with)\b.{0,40}\b(?:assigned|birth)|\bcisgender\b/

function transgender(c: Ctx): Resolved {
  let want = wantOf(c.eeo.transgender)
  // A label that names transgender asks that, whatever else it explains.
  if (typeof want === 'boolean' && INVERTED_TRANS.test(c.label) && !/\btrans(?:gender)?\b/.test(c.label)) want = !want
  return applyWant(c, want, {
    yes: [/^(?:i am )?(?:a )?trans(?:gender)?(?: (?:man|woman|person))?$/i],
    no: [/^(?:i am )?not (?:a )?trans/i, /^non[- ]?trans/i, /^cis(?:gender)?$/i]
  })
}

// --- Race and Hispanic or Latino -------------------------------------------

const HISPANIC = /hispanic|latin[oaxe]\b|spanish origin/i
const NOT_HISPANIC = /\bnot (?:of )?(?:hispanic|latin)|\bnon[- ]?hispanic/i
const TWO_OR_MORE = /two or more|more than one|multi-?racial|multiple races|biracial/i
// Option wording that only a UK ethnic group list uses.
const UK_LIST =
  /\bbritish\b|\bcaribbean\b|\bbangladeshi\b|\bpakistani\b|\bgypsy\b|\btraveller\b|\broma\b|\bwelsh\b|white\s*(?:and|&|\/|\+)\s*(?:asian|black)|any other (?:asian|black|white|mixed|ethnic)\b/i

const ASIAN = /(?<!east |south |southeast |south east |south-east )\basian\b(?! indian)/i
const RACE_TIERS: Record<RaceId, RegExp[]> = {
  american_indian: [/american indian|alaska\w* native|native american|indigenous/i],
  asian: [ASIAN],
  asian_east: [/(?<!south[- ]?)\beast asian/i, ASIAN],
  asian_south: [/\bsouth asian|asian indian|indian subcontinent/i, ASIAN],
  asian_southeast: [/south[- ]?east asian/i, ASIAN],
  black: [/black|african[- ]american|african descent|african origin/i],
  mena: [/middle east|north afric|\bmena\b|\barab/i],
  pacific_islander: [/pacific islander|hawaiian/i],
  white: [/\bwhite\b|caucasian|european/i]
}

const hispanicOption = (options: string[]): string | null =>
  oneOf(
    options.filter((o) => !NOT_HISPANIC.test(o)),
    HISPANIC
  )

/** The option for one race, or for the Asian group when several Asian ids are picked. */
function raceOption(options: string[], ids: RaceId[]): string | null {
  const id = ids.length > 1 ? 'asian' : ids[0]
  return oneOf(
    options.filter((o) => !HISPANIC.test(o) || NOT_HISPANIC.test(o)),
    ...RACE_TIERS[id]
  )
}

function race(c: Ctx): Resolved {
  const { eeo, options } = c
  const wantHispanic = eeo.hispanicLatino === 'yes'
  const ids = eeo.race
  if (options.some((o) => UK_LIST.test(o))) return ukEthnicity(c)
  if (ids.length === 0 && eeo.hispanicLatino === 'decline') return 'decline'
  if (options.length === 0) {
    const names = ids.map((id) => RACE_LABELS[id])
    if (wantHispanic) names.unshift('Hispanic or Latino')
    return names.length > 0 ? [names.join(', ')] : 'decline'
  }
  const hispanic = hispanicOption(options)
  // A list that only asks "Hispanic or Latino" or "Not Hispanic or Latino".
  if (options.filter((o) => !isDecline(o)).every((o) => HISPANIC.test(o.replace(/\([^)]*\)/g, ' ')))) {
    if (wantHispanic) return pickOne(hispanic)
    return eeo.hispanicLatino === 'no' ? pickOne(oneOf(options, NOT_HISPANIC)) : 'decline'
  }
  if (ids.length === 0 && !wantHispanic) return 'decline'
  if (!c.multi) {
    // One category on a combined list. Hispanic or Latino outranks the race picks.
    if (wantHispanic && hispanic) return [hispanic]
    if (ids.length === 0) return null
    const groups = new Set(ids.map((id) => (id.startsWith('asian') ? 'asian' : id)))
    if (groups.size > 1) return pickOne(oneOf(options, TWO_OR_MORE))
    return pickOne(raceOption(options, ids))
  }
  const picked: string[] = []
  if (wantHispanic && hispanic) picked.push(hispanic)
  for (const id of ids) {
    const option = raceOption(options, [id])
    if (option && !picked.includes(option)) picked.push(option)
  }
  return picked.length > 0 ? picked : null
}

function hispanicQuestion(c: Ctx): Resolved {
  return applyWant(c, wantOf(c.eeo.hispanicLatino), { yes: [/^hispanic|^latin/i], no: [NOT_HISPANIC] })
}

// --- Veteran --------------------------------------------------------------

const CATEGORY_PATTERNS: Record<VeteranCategoryId, RegExp> = {
  disabled: /\bdisabled veteran/i,
  recently_separated: /\brecently separated/i,
  active_wartime: /active[- ]duty wartime|campaign badge|\bwartime\b/i,
  service_medal: /service medal/i
}
const NOT_PROTECTED =
  /\bnot (?:a |an )?protected|\b(?:do|does) not (?:fall|qualify|identify)|\bdon['’]?t (?:fall|qualify|identify)|\bnon[- ]protected|\bnone of the (?:above|classifications)/i
const NOT_VETERAN = /\b(?:am|is) not (?:a |an )?veteran|\bnever served\b|\b(?:have|has) not served\b|\bno military service\b/i
// "I previously served in the military, but none of the above apply" and "I am a veteran, but not a protected veteran".
const SERVED_NOT_PROTECTED = /\b(?:previously|formerly) served\b|\bveteran,? but (?:not|none)\b|\bserved\b.*\bnone of the above\b/i
// "I identify as a protected veteran, but choose not to self-identify the classification(s)".
const CHOOSE_NOT = /\bbut (?:i )?(?:choose|prefer|do not|don['’]?t|would rather)\b/i
const PROTECTED_YES = /identify as one or more|classifications? of (?:a )?protected|(?:above|these|listed) categories|\bam a protected veteran|^yes\b.*protected/i

function categoryOptions(options: string[]): Map<VeteranCategoryId, string> {
  const found = new Map<VeteranCategoryId, string>()
  for (const id of VETERAN_CATEGORY_IDS) {
    const option = oneOf(options, CATEGORY_PATTERNS[id])
    if (option) found.set(id, option)
  }
  return found
}

/** The four protected veteran categories, listed as options. */
function veteranCategories(c: Ctx, categories: Map<VeteranCategoryId, string>): Resolved {
  const { veteran: status, veteranCategories: wanted } = c.eeo
  if (status === 'decline') return 'decline'
  if (status === 'protected') {
    const picks = wanted.flatMap((id) => categories.get(id) ?? [])
    if (picks.length === 0 || (!c.multi && picks.length > 1)) return null
    return picks
  }
  const named = new Set(categories.values())
  return pickOne(
    oneOf(
      c.options.filter((o) => !named.has(o)),
      /\bnone of the\b/i,
      /\bnot (?:a |an )?protected/i,
      /^none$/i,
      /\bnot (?:a |an )?veteran/i
    )
  )
}

/** Yes or No for a veteran question. "Protected" wording follows the veteran setting, other wording follows military service. */
function veteranWant(eeo: EeoSettings, protectedWording: boolean): Want {
  if (eeo.veteran === 'protected') return true
  if (protectedWording) return eeo.veteran === 'not_protected' ? false : 'decline'
  if (eeo.militaryService === 'yes') return true
  if (eeo.militaryService === 'no') return false
  return eeo.veteran === 'not_protected' ? null : 'decline'
}

/** A list of statuses such as "I am not a protected veteran". */
function veteranStatus(c: Ctx): Resolved {
  const { veteran: status, militaryService } = c.eeo
  if (status === 'decline') return 'decline'
  const pool = c.options.filter((o) => !isDecline(o) && !CHOOSE_NOT.test(o))
  if (status === 'protected') {
    const fits = pool.filter((o) => !NOT_PROTECTED.test(o) && !NOT_VETERAN.test(o) && !SERVED_NOT_PROTECTED.test(o))
    return pickOne(oneOf(fits, PROTECTED_YES))
  }
  // Not protected. An owner who served says so on lists that have an option for it.
  if (militaryService === 'yes') {
    const served = oneOf(pool, SERVED_NOT_PROTECTED)
    if (served) return [served]
  }
  if (militaryService === 'no') {
    const never = oneOf(pool, NOT_VETERAN)
    if (never) return [never]
  }
  const fits = pool.filter((o) => !SERVED_NOT_PROTECTED.test(o) && !NOT_VETERAN.test(o) && !SAYS_VETERAN.test(o))
  return pickOne(oneOf(fits, /^i am not a protected veteran$/i, NOT_PROTECTED))
}

function veteran(c: Ctx): Resolved {
  const { eeo, field } = c
  if (field.type === 'checkbox') {
    const category = VETERAN_CATEGORY_IDS.find((id) => CATEGORY_PATTERNS[id].test(c.label))
    if (category) return eeo.veteran === 'protected' && eeo.veteranCategories.includes(category) ? ['true'] : 'decline'
    if (NOT_PROTECTED.test(c.label)) return eeo.veteran === 'not_protected' ? ['true'] : 'decline'
    return applyWant(c, veteranWant(eeo, /protected/.test(c.label)))
  }
  if (c.options.length === 0) {
    if (eeo.veteran === 'decline') return 'decline'
    return [eeo.veteran === 'protected' ? 'I identify as one or more of the classifications of protected veteran' : 'I am not a protected veteran']
  }
  const categories = categoryOptions(c.options)
  if (categories.size >= 2) return veteranCategories(c, categories)
  const pool = c.options.filter((o) => !isDecline(o))
  if (pickOption(pool, 'Yes') && pickOption(pool, 'No')) {
    return applyWant(c, veteranWant(eeo, /protected/.test(c.label) || pool.some((o) => /protected/i.test(o))))
  }
  return veteranStatus(c)
}

// --- Disability -----------------------------------------------------------

function disability(c: Ctx): Resolved {
  return applyWant(c, wantOf(c.eeo.disability), {
    yes: [/^i (?:do )?have (?:a |an )?(?:\w+ )?disabilit/i, /^i have\b/i],
    no: [/^i (?:do not|don['’]?t|have no|am not)\b.*disab/i]
  })
}

// --- Sexual orientation ---------------------------------------------------

const GAY_OR_LESBIAN = /\b(?:gay|lesbian)\b\s*(?:[/,&]|or|and)\s*\b(?:gay|lesbian)\b/i
const BI_AND_PAN = /bi(?:sexual)?\s*(?:[/+,&]|or|and)\s*pan|pan(?:sexual)?\s*(?:[/+,&]|or|and)\s*bi\b|\bbi\+/i
const ORIENTATION_TIERS: Partial<Record<SexualOrientationId, RegExp[]>> = {
  asexual: [/^asexual$/i, /\basexual\b/i],
  gay: [/^gay$/i, GAY_OR_LESBIAN, /^gay\b/i],
  heterosexual: [/heterosexual|^straight/i],
  lesbian: [/^lesbian$/i, GAY_OR_LESBIAN, /^lesbian\b/i],
  queer: [/^queer$/i, /\bqueer\b/i]
}

function orientationOption(c: Ctx, id: SexualOrientationId): string | null {
  if (id === 'self_describe') return selfDescribe(c.options, c.eeo.sexualOrientationText)?.[0] ?? null
  if (id === 'bisexual_pansexual') {
    const combined = oneOf(c.options, BI_AND_PAN)
    if (combined) return combined
    // With separate "Bisexual" and "Pansexual" options, this setting cannot tell which one is meant.
    const bi = c.options.filter((o) => /^bisexual$/i.test(o.trim()))
    const pan = c.options.filter((o) => /^pansexual$/i.test(o.trim()))
    return bi.length + pan.length === 1 ? (bi[0] ?? pan[0]) : null
  }
  return oneOf(c.options, ...(ORIENTATION_TIERS[id] ?? []))
}

function sexualOrientation(c: Ctx): Resolved {
  const ids = c.eeo.sexualOrientation
  if (ids.length === 0) return 'decline'
  if (c.options.length === 0) {
    const names = ids.map((id) => (id === 'self_describe' ? c.eeo.sexualOrientationText.trim() : SEXUAL_ORIENTATION_LABELS[id])).filter(Boolean)
    return names.length > 0 ? [names.join(', ')] : null
  }
  if (!c.multi && ids.length > 1) return pickOne(oneOf(c.options, /more than one|multiple|two or more/i))
  const picked = [...new Set(ids.map((id) => orientationOption(c, id)).filter((o): o is string => o !== null))]
  return picked.length > 0 ? picked : null
}

// --- Age ------------------------------------------------------------------

interface Band {
  lo: number
  hi: number
}

/** The ages an option covers, read from wording such as "25-34", "65+", "Under 18" or "Over 55". */
function ageBand(option: string): Band | null {
  const t = option.toLowerCase()
  let m = /(\d{2})\s*(?:-|–|—|to)\s*(\d{2})/.exec(t)
  if (m) return { lo: Number(m[1]), hi: Number(m[2]) }
  m = /(\d{2})\s*(?:\+|or (?:older|over|above|more)|and (?:older|over|above|up))/.exec(t)
  if (m) return { lo: Number(m[1]), hi: Infinity }
  m = /(?:over|above|older than)\s*(\d{2})/.exec(t)
  if (m) return { lo: Number(m[1]) + 1, hi: Infinity }
  m = /(?:under|below|younger than|less than)\s*(\d{2})/.exec(t)
  if (m) return { lo: 0, hi: Number(m[1]) - 1 }
  return null
}

/** "Are you 40 or older?" from the birth year. A birth year gives two possible ages, so a close call is left unanswered. */
function olderThanWant(label: string, youngest: number, oldest: number): Want {
  const n = /\b(\d{2})\b/.exec(label)
  if (!n) return null
  const limit = Number(n[1])
  if (/\b(?:under|younger than|below)\b/.test(label)) return oldest < limit ? true : youngest >= limit ? false : null
  if (/\b(?:over|older than|above)\b/.test(label)) return youngest > limit ? true : oldest <= limit ? false : null
  return youngest >= limit ? true : oldest < limit ? false : null
}

function age(c: Ctx): Resolved {
  const { birthYear } = c.eeo
  if (birthYear === null) return 'decline'
  const oldest = c.year - birthYear
  const youngest = oldest - 1
  if (/year of birth|birth year/.test(c.label)) {
    if (c.options.length === 0) return [String(birthYear)]
    return pickOne(c.options.find((o) => o.trim() === String(birthYear)) ?? null)
  }
  const bands = c.options.map((option) => ({ option, band: ageBand(option) }))
  if (bands.filter((b) => b.band !== null).length >= 2) {
    const fits = bands.filter((b) => b.band && b.band.lo <= youngest && b.band.hi >= oldest)
    return fits.length === 1 ? [fits[0].option] : null
  }
  // A date of birth or an exact age needs more than a year.
  if (c.field.type === 'date' || c.field.type === 'number' || /date of birth|birth ?date|\bdob\b|how old/.test(c.label)) return 'decline'
  return applyWant(c, olderThanWant(c.label, youngest, oldest))
}

// --- UK ethnic group (2021 ONS groups and subgroups) -------------------------

type UkGroup = 'asian' | 'black' | 'mixed' | 'white' | 'other'

// An option that names a whole group, such as "Asian or Asian British" or "Mixed or Multiple ethnic groups".
const GROUP_ONLY: Record<UkGroup, RegExp> = {
  asian: /^asian(?:[\s,/]+(?:or\s+)?(?:asian|british|welsh|scottish))*$/i,
  black: /^black(?:[\s,/]+(?:or\s+)?(?:black|british|welsh|scottish|african|caribbean))*$/i,
  mixed: /^(?:mixed|multiple)(?:[\s,/]+(?:or\s+)?(?:mixed|multiple|ethnic|groups?|heritage|background))*$/i,
  white: /^white$/i,
  other: /^other(?:\s+ethnic)?(?:\s+groups?)?$/i
}
const UK_GROUPS = Object.keys(GROUP_ONLY) as UkGroup[]

// Subgroup wording, in priority order. A group read from the option limits the list to that group.
const UK_SUBGROUPS: Array<[Exclude<UkEthnicityId, 'decline'>, RegExp]> = [
  ['asian_bangladeshi', /\bbangladeshi\b/i],
  ['asian_chinese', /\bchinese\b/i],
  ['asian_indian', /(?<!american )\bindian\b/i],
  ['asian_pakistani', /\bpakistani\b/i],
  ['asian_other', /\bother\b.*\basian\b/i],
  ['black_other', /\bother\b.*\b(?:black|african|caribbean)\b/i],
  ['black_african', /^(?:black(?: british)?[\s,/-]*)?african$/i],
  ['black_caribbean', /^(?:black(?: british)?[\s,/-]*)?caribbean$/i],
  ['mixed_white_black_african', /white\s*(?:and|&|\/|\+)\s*black\s+african/i],
  ['mixed_white_black_caribbean', /white\s*(?:and|&|\/|\+)\s*black\s+caribbean/i],
  ['mixed_white_asian', /white\s*(?:and|&|\/|\+)\s*asian/i],
  ['mixed_other', /\bother\b.*\b(?:mixed|multiple)\b|\b(?:mixed|multiple)\b.*\bother\b/i],
  ['white_gypsy_traveller', /gypsy|traveller|traveler/i],
  ['white_roma', /^roma\b/i],
  ['white_irish', /^irish$/i],
  ['white_other', /\bother\b.*\bwhite\b/i],
  ['white_british', /^(?:english|welsh|scottish|northern irish|british)\b/i],
  ['other_arab', /^arab\b/i],
  ['other_any', /\bany other ethnic group\b/i]
]

const groupOf = (id: UkEthnicityId): UkGroup | null => (id === 'decline' ? null : (id.split('_')[0] as UkGroup))

/** The subgroup an option names. Inside a known group, a bare "Other" means that group's "any other". */
function ukSubgroup(group: UkGroup | null, text: string): UkEthnicityId | null {
  const t = text.trim()
  const hit = UK_SUBGROUPS.find(([id, re]) => (group === null || groupOf(id) === group) && re.test(t))
  if (hit) return hit[0]
  if (group !== null && /^(?:any )?other\b/i.test(t)) return group === 'other' ? 'other_any' : (`${group}_other` as UkEthnicityId)
  return null
}

const UK_SEPARATORS = [/\s*:\s*/, /\s+[-–—]\s+/, /\s+\/\s+/]

/** What an option stands for: a subgroup, a whole group, or nothing recognizable. */
function classifyUk(option: string): { group: UkGroup | null; sub: UkEthnicityId | null } {
  const text = option.trim()
  // "Group: Subgroup", "Group - Subgroup" and "Group / Subgroup".
  for (const sep of UK_SEPARATORS) {
    const m = sep.exec(text)
    if (!m) continue
    const head = text.slice(0, m.index).trim()
    const tail = text.slice(m.index + m[0].length).trim()
    const group = UK_GROUPS.find((g) => GROUP_ONLY[g].test(head))
    if (group && tail) {
      const sub = ukSubgroup(group, tail)
      if (sub) return { group, sub }
    }
  }
  // "Black African" is a subgroup, while "Black, Black British, Caribbean or African" is the group.
  const bare = ukSubgroup(null, text)
  if (bare) return { group: groupOf(bare), sub: bare }
  const whole = UK_GROUPS.find((g) => GROUP_ONLY[g].test(text))
  if (whole) return { group: whole, sub: null }
  // "White British", "Asian Indian".
  const lead = /^(asian|black|mixed|white)\b[\s,/-]+(.+)$/i.exec(text)
  if (lead) {
    const group = lead[1].toLowerCase() as UkGroup
    const sub = ukSubgroup(group, lead[2])
    if (sub) return { group, sub }
  }
  return { group: null, sub: null }
}

/** The ONS subgroup from a list of subgroups, or the group from a list that asks for the group first. */
function ukEthnicity(c: Ctx): Resolved {
  const id = c.eeo.ukEthnicity
  if (id === 'decline') return 'decline'
  const parsed = c.options.filter((o) => !isDecline(o)).map((option) => ({ option, ...classifyUk(option) }))
  const exact = parsed.filter((p) => p.sub === id)
  if (exact.length > 0) return exact.length === 1 ? [exact[0].option] : null
  // A list that names no subgroup asks for the group.
  if (parsed.some((p) => p.sub !== null)) return null
  const groups = parsed.filter((p) => p.group === groupOf(id))
  return groups.length === 1 ? [groups[0].option] : null
}

// --- Religion -------------------------------------------------------------

const RELIGION_TIERS: Record<Exclude<EeoSettings['religion'], 'decline'>, RegExp[]> = {
  none: [/^no religion$/i, /^none$/i, /^no religion or belief$/i, /\bno religion\b|non-?religious|\bnot religious\b/i],
  christian: [/^christian$/i, /^christian\b/i],
  buddhist: [/^buddhis[mt]$/i, /\bbuddhis[mt]/i],
  hindu: [/^hindu(?:ism)?$/i, /\bhindu/i],
  jewish: [/^jewish$/i, /^judaism$/i, /\bjewish|\bjudaism/i],
  muslim: [/^muslim$/i, /^islam$/i, /\bmuslim|\bislam/i],
  sikh: [/^sikh(?:ism)?$/i, /\bsikh/i],
  other: [/^any other religion/i, /^other religion/i, /^other\b/i]
}

function religion(c: Ctx): Resolved {
  const id = c.eeo.religion
  if (id === 'decline') return 'decline'
  const pool = c.options.filter((o) => !isDecline(o))
  if (c.options.length === 0) return id === 'other' ? null : [RELIGION_LABELS[id]]
  // "Do you follow a religion?" in Yes or No form.
  if (pickOption(pool, 'Yes') && pickOption(pool, 'No')) return applyWant(c, id !== 'none')
  return pickOne(oneOf(c.options, ...RELIGION_TIERS[id]))
}

// --- Caring, neurodivergent -------------------------------------------------

function caring(c: Ctx): Resolved {
  return applyWant(c, wantOf(c.eeo.caring), { yes: [/^yes\b/i], no: [/^no\b/i, /^none\b/i] })
}

// A named condition is narrower than "neurodivergent", so a Yes cannot answer it.
const NAMED_CONDITION = /\b(?:dyslex\w*|adhd|autis\w*|dyspraxi\w*|dyscalcul\w*|tourette\w*)\b/

function neurodivergent(c: Ctx): Resolved {
  let want = wantOf(c.eeo.neurodivergent)
  const general = /neurodiver\w*|neurotypical/.test(c.label)
  if (!general && NAMED_CONDITION.test(c.label)) return want === false ? applyWant(c, false) : 'decline'
  const yesNoForm = c.options.length === 0 || c.field.type === 'checkbox' || (pickOption(c.options, 'Yes') !== null && pickOption(c.options, 'No') !== null)
  if (typeof want === 'boolean' && yesNoForm && /neurotypical/.test(c.label) && !/neurodiver/.test(c.label)) want = !want
  return applyWant(c, want, {
    yes: [/^neurodiver\w*$/i, /^i (?:am|identify as) (?:a )?neurodiver\w*$/i],
    no: [/^neurotypical$/i, /^i (?:am not|do not|don['’]t)\b/i]
  })
}

// --- Social Mobility Commission questions ------------------------------------

const OCCUPATION_TIERS: Record<Exclude<HouseholdOccupationId, 'decline'>, RegExp[]> = {
  modern_professional: [/modern professional/i],
  clerical_intermediate: [/clerical/i],
  senior_manager: [/senior manager/i],
  technical_craft: [/technical (?:and|&|or) craft|craft occupations/i],
  semi_routine: [/semi[- ]?routine/i],
  routine: [/^routine\b/i, /(?<!semi[- ]?)\broutine manual/i],
  middle_manager: [/middle or junior manager|junior manager/i],
  traditional_professional: [/traditional professional/i],
  long_term_unemployed: [/long[- ]term unemployed/i],
  retired: [/^retired\b/i],
  not_applicable: [/does not apply|not applicable|^n\/?a$/i]
}

const SCHOOL_TIERS: Record<Exclude<SchoolTypeId, 'decline'>, RegExp[]> = {
  state_non_selective: [/non[- ]selective/i, /^(?:a )?(?:uk )?state\b[^(]*$/i],
  state_selective: [/\bstate\b.*(?<!non[- ])\bselective\b/i, /\bgrammar\b/i],
  independent: [/\b(?:independent|fee[- ]paying|private)\b(?!.*bursar)/i],
  independent_bursary: [/bursar/i],
  outside_uk: [/outside (?:of )?(?:the )?(?:uk|united kingdom)|\babroad\b|\boverseas\b|non[- ]uk/i]
}

// "Are you the first in your family to go to university?" asks the opposite question.
const FIRST_GENERATION = /first[- ]generation|first in your family|first (?:person|one|member) in your family/

function socioeconomic(c: Ctx): Resolved {
  const { socioeconomic: s } = c.eeo
  if (/free school meals/.test(c.label)) return applyWant(c, wantOf(s.freeSchoolMeals), { yes: [/^yes\b/i], no: [/^no\b/i] })
  if (/earner|occupation|employment status/.test(c.label)) {
    if (s.householdOccupation === 'decline' || c.options.length === 0) return 'decline'
    return pickOne(oneOf(c.options, ...OCCUPATION_TIERS[s.householdOccupation]))
  }
  return 'decline'
}

function schoolType(c: Ctx): Resolved {
  const id = c.eeo.socioeconomic.schoolType
  if (id === 'decline' || c.options.length === 0) return 'decline'
  return pickOne(oneOf(c.options, ...SCHOOL_TIERS[id]))
}

function parentDegree(c: Ctx): Resolved {
  let want = wantOf(c.eeo.socioeconomic.parentDegree)
  if (FIRST_GENERATION.test(c.label)) {
    // A parent with a degree rules out first generation. No degree does not prove it, so that case declines.
    want = want === true ? false : 'decline'
  }
  return applyWant(c, want, { yes: [/^yes\b/i], no: [/^no\b/i] })
}

// --- Entry ----------------------------------------------------------------

function resolve(family: DemographicFamily | null, c: Ctx): Resolved {
  if (family === null) return 'decline'
  if ((c.field.type === 'date' || c.field.type === 'number') && family !== 'age') return 'decline'
  switch (family) {
    case 'gender':
      return gender(c)
    case 'pronouns':
      return pronouns(c)
    case 'transgender':
      return transgender(c)
    case 'sexual_orientation':
      return sexualOrientation(c)
    case 'lgbtq':
      return applyWant(c, wantOf(c.eeo.lgbtq))
    case 'race':
      return race(c)
    case 'hispanic':
      return hispanicQuestion(c)
    case 'veteran':
      return veteran(c)
    case 'military_spouse':
      return applyWant(c, wantOf(c.eeo.militarySpouse))
    case 'disability':
      return disability(c)
    case 'age':
      return age(c)
    case 'religion':
      return religion(c)
    case 'caring':
      return caring(c)
    case 'neurodivergent':
      return neurodivergent(c)
    case 'socioeconomic':
      return socioeconomic(c)
    case 'school_type':
      return schoolType(c)
    case 'parent_degree':
      return parentDegree(c)
    default:
      // Marital status, pregnancy and the rest have no setting, so they decline.
      return 'decline'
  }
}

const needsYou = (): MappedAnswer => ({
  value: '',
  source: 'settings',
  confidence: 0,
  needsUser: true,
  note: 'This asks about your background and has no option to decline. Answer it yourself.'
})
const blankAnswer = (): MappedAnswer => ({ value: '', source: 'settings', confidence: 0, needsUser: false, note: null })

// Wording that says the person is a veteran, as in "I am a veteran, but not a protected veteran".
const SAYS_VETERAN = /\b(?:i am|i['’]m|i was) an? (?:[\w-]+ ){0,2}veterans?\b/i

/**
 * Answers a self-identification field. Order: the owner's setting, the form's decline option, the
 * owner's exact saved answer, then blank for an optional field or a flag for a required one. It never
 * returns null and never asks a model. `year` is only for tests.
 */
export function demographicAnswer(field: FormField, settings: Settings, saved: SavedChoice | null, year = new Date().getFullYear()): MappedAnswer {
  const multi = field.type === 'multiselect' || field.type === 'checkboxes'
  const ctx: Ctx = { field, label: core(field.label), options: isChoice(field) ? field.options : [], multi, eeo: settings.eeo, year }
  const result = resolve(demographicFamily(field), ctx)

  if (Array.isArray(result)) {
    return { value: multi ? JSON.stringify(result) : result[0], source: 'settings', confidence: 0.9, needsUser: false, note: null }
  }

  const note = result === null ? "Your self-identification setting matched none of this form's options, so jobpls chose the decline option." : null
  if (field.type === 'checkbox') {
    return field.required ? needsYou() : { value: 'false', source: 'settings', confidence: 0.95, needsUser: false, note: null }
  }
  if (isChoice(field) && field.options.length > 0) {
    const declined = declineOption(field.options)
    if (declined) {
      return { value: multi ? JSON.stringify([declined]) : declined, source: 'settings', confidence: 0.95, needsUser: false, note }
    }
  }

  if (saved && saved.kind === 'fact' && saved.answer.trim()) {
    if (isChoice(field) && field.options.length > 0) {
      const picked = pickOption(field.options, saved.answer)
      if (picked) {
        return { value: multi ? JSON.stringify([picked]) : picked, source: 'answer_bank', confidence: 0.9, needsUser: false, note: 'From your saved answers.' }
      }
    } else {
      return { value: saved.answer, source: 'answer_bank', confidence: 0.9, needsUser: false, note: 'From your saved answers.' }
    }
  }

  return field.required ? needsYou() : blankAnswer()
}
