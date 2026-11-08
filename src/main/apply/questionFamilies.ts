// Question families that ask what the person is willing to do or able to meet: work on site, commute, keep a
// schedule, take a drug test. Only a fact the person gave can answer these. A guess on one is a knockout
// answer, so a field in a family that no rule answered is never sent to the model.

export type WillingnessFamily =
  | 'onsite'
  | 'hybrid'
  | 'remote'
  | 'time_zone'
  | 'commute'
  | 'overtime'
  | 'schedule'
  | 'hours'
  | 'employment_type'
  | 'drug_test'
  | 'background_check'
  | 'credit_check'
  | 'export_control'
  | 'immigration_case'

/** The families in the order they are tried. The first match wins, so the specific ones come first. */
export const WILLINGNESS_FAMILIES: readonly WillingnessFamily[] = [
  'export_control',
  'immigration_case',
  'drug_test',
  'credit_check',
  'background_check',
  'commute',
  'hybrid',
  'onsite',
  'remote',
  'time_zone',
  'overtime',
  'schedule',
  'hours',
  'employment_type'
]

// The kinds of work that make a question about the role's employment type. "permanent work authorization" is a question about authorization.
const EMPLOYMENT_KIND =
  /\bfull[-\s]?time\b|\bpart[-\s]?time\b|\bcontract(?:or|ing|s)?\b|\btemp(?:orary)?\b|\bfreelanc\w*|\binternship\b|\bseasonal\b|\bpermanent(?!\s+(?:resident|residen\w*|work\w*\s+(?:authori|permit|visa|eligib|status)|authori|status|eligib))\b|\bfixed[-\s]term\b/
// Wording about the role or the person's willingness. "Have you worked as a contractor?" and "contract testing tools" have none.
const EMPLOYMENT_CUE =
  /\b(?:willing\w*|able|open|comfortable|available|availability|prepared|ready|happy|okay|ok|fine|interested|seeking|looking|prefer\w*|consider\w*|accept\w*|can you|could you|will you|would you|this is an?|this (?:role|position|job|opportunity) is|currently (?:employed|working)|are you (?:currently |presently )?(?:employed|working))\b/
const EMPLOYMENT_TYPE = new RegExp(`^(?=[\\s\\S]*(?:${EMPLOYMENT_CUE.source}))[\\s\\S]*(?:${EMPLOYMENT_KIND.source})|\\bemployment (?:type|basis|status)\\b`, 'i')

const PATTERNS: Record<WillingnessFamily, RegExp> = {
  onsite: /\bon[-\s]?site\b|\bin[-\s]office\b|\bin[-\s]person\b|\b(?:work|working|be)\b[^?]{0,30}\b(?:from|in|at) (?:the|our|an?) (?:office|studio)\b|\bdays? (?:a|per|each) week (?:in|at) the (?:office|studio)\b/i,
  hybrid: /\bhybrid\b/i,
  // Only willingness to work remotely. "Do you have experience working remotely?" is not this.
  remote: /\b(?:willing\w*|able|open|comfortable|okay|ok|prepared|ready|happy)\b[^?]{0,60}\b(?:work(?:ing)?\s+(?:fully\s+|completely\s+|100%\s+)?(?:remote(?:ly)?|from home)|remotely)\b/i,
  time_zone: /\b(?:willing\w*|able|available|comfortable|open|can you|will you)\b[^?]{0,80}(?:\btime ?zones?\b|\boverlap\w*|\b(?:pacific|eastern|mountain|european|us|u\.s\.|uk)\s+(?:standard\s+)?(?:time|hours)\b|\b(?:pst|pdt|est|edt|cst|cdt|mst|mdt|cet|cest|utc|gmt)\b)/i,
  commute: /\bcommut\w*/i,
  overtime: /\bovertime\b|\bcrunch\b|\bextra hours\b|\blong hours\b|\bafter[-\s]hours\b|\bunpaid hours\b/i,
  schedule: /\bevenings?\b|\bweekends?\b|\bsaturdays?\b|\bsundays?\b|\bnights?\b|\bovernight\b|\bshift(?:s| work)?\b|\bon[-\s]call\b|\bwork(?:ing)? schedule\b|\bflexible (?:hours|schedule)\b|\bpublic holidays?\b/i,
  hours: /\bhours? (?:per|a|each|\/) ?(?:week|day|month)\b|\bhours\/week\b|\b\d+\s*(?:hours|hrs)\b|\b(?:working|work|weekly) hours\b|\bnumber of hours\b|\bhours (?:available|of availability)\b/i,
  employment_type: EMPLOYMENT_TYPE,
  drug_test: /\bdrug[-\s](?:test|screen|free|panel)\w*|\bsubstance[-\s](?:abuse[-\s])?(?:test|screen)\w*|\btoxicolog\w*|\bdrug and alcohol\b/i,
  background_check: /\bbackground[-\s]?(?:check|screen|investigation|verification)\w*/i,
  credit_check: /\bcredit[-\s](?:check|history|report|screen|score)\w*|\bfinancial background\b/i,
  // Case sensitive on purpose for the acronyms: "ear" and "itar" are not words, but "EAR" is a regulation.
  export_control: /\bITAR\b|\bEAR\b|\bEAR99\b|\bexport[-\s](?:control|administration|law|regulation)s?\b|\bU\.?S\.? persons?\b|\bforeign persons?\b|\bdeemed export\b/,
  immigration_case: /\bimmigration\b/i
}

/**
 * The willingness family a question belongs to, or null. These questions ask whether the person will or can meet
 * a condition of the job (be on site, commute, work evenings, pass a background check). The profile rarely
 * states these, so a rule or a stated fact must answer them and the model must not.
 */
export function willingnessFamily(label: string): WillingnessFamily | null {
  const text = label.replace(/\s+/g, ' ').trim()
  if (!text) return null
  for (const family of WILLINGNESS_FAMILIES) if (PATTERNS[family].test(text)) return family
  return null
}

const SUBJECT: Record<WillingnessFamily, string> = {
  onsite: 'working on site',
  hybrid: 'a hybrid schedule',
  remote: 'working remotely',
  time_zone: 'time zones',
  commute: 'commuting',
  overtime: 'overtime',
  schedule: 'your work schedule',
  hours: 'your weekly hours',
  employment_type: 'the type of employment',
  drug_test: 'a drug test',
  background_check: 'a background check',
  credit_check: 'a credit check',
  export_control: 'export control rules',
  immigration_case: 'an immigration case'
}

/**
 * The note shown on a required question in a willingness family that no rule answered. It says what the
 * question is about and that the person answers it.
 */
export function willingnessNote(family: WillingnessFamily): string {
  return `This asks about ${SUBJECT[family]}. Your profile does not answer it, so answer it yourself.`
}
