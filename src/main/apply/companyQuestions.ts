import type { ApplicationFacts, FormField } from '@shared/types'
import { normalizeCompany } from '../pipeline/dedupe'
import { answer, isChoice, type MapContext, type MappedAnswer, pickOption, relatedCompany, sameCompany, words } from './fieldMap'

// Questions about the person's history with the employer: worked there before, applied there
// before, family or friends who work there, and who referred them. The first two come from the
// work history and the application log. The last two come from facts the person gave.

const plainOf = (label: string): string =>
  label
    .toLowerCase()
    .replace(/\(optional\)|\(required\)|\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const needs = (note: string): MappedAnswer => ({ value: '', source: 'profile', confidence: 0, needsUser: true, note })

/** A conditional follow-up ("If yes, ...") whose question was answered No. It stays blank and does not block the form. */
const notNeeded = (note: string): MappedAnswer => ({ value: '', source: 'profile', confidence: 0.85, needsUser: false, note })

const NOT_APPLICABLE_OPTION = /^\s*(?:n\/?a|not applicable|none|does not apply)\s*\.?\s*$/i

/** The follow-up of a No. A list that offers "n/a" gets it, since a required list cannot stay blank. Otherwise it stays blank. */
function followUpSkipped(field: FormField, note: string): MappedAnswer {
  if (isChoice(field) && field.options.length > 0) {
    const na = field.options.find((o) => NOT_APPLICABLE_OPTION.test(o))
    const picked = na ? answer(field, na, 'profile', 0.85, note) : null
    if (picked) return picked
  }
  return notNeeded(note)
}

const FOLLOW_UP = /^\W*(?:if|when) (?:yes|so|you answered yes|you have|you did|you were|applicable)\b/

const hasYesNo = (field: FormField): boolean => field.type === 'checkbox' || (isChoice(field) && field.options.length > 0 && pickOption(field.options, 'Yes') !== null && pickOption(field.options, 'No') !== null)

/** "No" or "Yes" in the shape the field takes, or the person is asked when the options have neither. */
function yesNo(field: FormField, value: boolean, confidence = 0.85): MappedAnswer {
  return answer(field, value ? 'Yes' : 'No', 'profile', confidence) ?? needs('The options on this question have no Yes or No. Answer it yourself.')
}

// ---------------------------------------------------------------------------
// Worked for the company before
// ---------------------------------------------------------------------------

// "Have you ever worked for ...", "Have you previously been employed by ...", "we would like to know if you have worked for ...".
const WORKED_QUESTION =
  /\b(?:have|has|had|did|were|are) you(?: [a-z]+){0,2}? (?:worked|been employed|been an? (?:employee|contractor|consultant)|employed)\b|\b(?:if|whether) you(?:'ve| have| had)? (?:ever |previously |formerly )?(?:worked|been employed)\b/
const NOT_EMPLOYMENT = /\b(?:family|relatives?|friends?|spouse|partner|referr\w*|know anyone|know someone|compet\w*|customers?|clients?|vendors?|suppliers?|remote|remotely|government|military|years?)\b/
const SELF_EMPLOYER = /\b(?:for|at|by|with|of)\s+(?:our|this|the)\s+(?:organi[sz]ation|company|studio|team|group|employer|business)\b|\b(?:worked|employed)\s+(?:for|at|by|with)\s+(?:us|here)\b/i
const PROPER = "[A-Z][\\w&.'-]*"
const NAME = `${PROPER}(?: (?:${PROPER}|of)){0,3}`
const PARENT_COMPANY = new RegExp(`\\ban? (${PROPER}(?: ${PROPER}){0,2}) (?:company|companies|group|studio|studios|subsidiary|subsidiaries|affiliate|affiliates|entity|entities)\\b`, 'g')
const AFTER_PREPOSITION = new RegExp(`\\b(?:for|at|by|services to)\\s+(?:the\\s+)?(${NAME})`, 'g')
const EMPLOYMENT_VERB = /\b(?:worked|employed|employee|contractor|consultant)\b/i
const NOT_A_NAME = new Set(['I', 'We', 'Our', 'The', 'A', 'An', 'If', 'Yes', 'No', 'Have', 'Do', 'Did', 'Has', 'You', 'Your', 'This', 'That', 'Any'])

/** The employers a question names, in the label's own capitals. "self" stands for the company the form belongs to. */
function employersNamed(label: string): string[] {
  const found = new Set<string>()
  if (SELF_EMPLOYER.test(label)) found.add('self')
  for (const m of label.matchAll(PARENT_COMPANY)) found.add(m[1])
  const verb = label.search(EMPLOYMENT_VERB)
  if (verb >= 0) {
    for (const m of label.slice(verb).matchAll(AFTER_PREPOSITION)) {
      const name = m[1].replace(/[.,]$/, '').trim()
      if (name && !NOT_A_NAME.has(name)) found.add(name)
    }
  }
  return [...found]
}

/** True when a name in a question is the form's own company, written in full or shortened ("Riot" for "Riot Games"). */
function isOwnCompany(name: string, company: string): boolean {
  if (name === 'self' || sameCompany(name, company)) return true
  const shorter = normalizeCompany(name)
  return shorter !== '' && normalizeCompany(company).startsWith(`${shorter} `)
}

/** True when a name is the company's name with more words after it ("Google DeepMind" for "Google"). Not the same employer. */
function extendsCompany(name: string, company: string): boolean {
  return name !== 'self' && relatedCompany(name, company) && !isOwnCompany(name, company)
}

type History = 'yes' | 'no' | 'unsure'

/** Whether the work history shows a job at any of the employers named. */
function workedFor(employers: string[], ctx: MapContext): History {
  let unsure = false
  for (const name of employers) {
    const target = isOwnCompany(name, ctx.company) ? ctx.company : name
    for (const job of ctx.profile.experience) {
      if (sameCompany(job.company, target)) return 'yes'
      if (relatedCompany(job.company, target)) unsure = true
    }
  }
  return unsure ? 'unsure' : 'no'
}

/**
 * "Have you ever worked for X?" answered from the work history: No when no job matches the company or
 * the parent the question names, Yes when one does. A name that is close but not the same ("Meta" and
 * "Meta Platforms") is left for the person. The "If yes, ..." follow-up of a No stays blank.
 */
export function employmentHistoryAnswer(field: FormField, ctx: MapContext): MappedAnswer | null {
  if (field.type === 'file' || !ctx.company.trim()) return null
  const plain = plainOf(field.label)
  const followUp = FOLLOW_UP.test(plain)
  if (followUp ? !/\b(?:worked|employed|employment)\b/.test(plain) : !WORKED_QUESTION.test(plain)) return null
  if (NOT_EMPLOYMENT.test(plain.replace(/\b(?:last|which|what) years?\b|\byears? (?:and|or) months?\b|\blast year\b/g, ' '))) return null
  const employers = employersNamed(field.label)
  if (employers.length === 0 || employers.some((name) => extendsCompany(name, ctx.company))) return null
  const history = workedFor(employers, ctx)
  if (followUp) return history === 'no' ? followUpSkipped(field, 'Left blank because your work history shows no job there.') : null
  if (history === 'unsure') return needs('A past employer has a similar name. Answer this yourself.')
  return yesNo(field, history === 'yes')
}

// ---------------------------------------------------------------------------
// Applied to the company before
// ---------------------------------------------------------------------------

const APPLIED_QUESTION = /\b(?:have|had|did|has) you (?:ever |previously |already |before |formerly |in the past )*(?:applied|submitted an application)\b/
const THIS_ROLE = /\b(?:this|the|that|same) (?:role|position|job|opening|vacancy|posting|requisition)\b/
// Words that may follow "applied" when the question is about the company itself.
const APPLIED_FILLER = new Set([
  'to', 'at', 'with', 'for', 'here', 'us', 'our', 'company', 'organization', 'organisation', 'team', 'studio', 'group', 'business',
  'employer', 'before', 'previously', 'ever', 'already', 'again', 'in', 'the', 'past', 'this', 'that', 'a', 'an', 'any', 'other',
  'position', 'positions', 'role', 'roles', 'job', 'jobs', 'opening', 'openings', 'vacancy', 'vacancies', 'and', 'or', 'of', 'same'
])

/**
 * "Have you previously applied to Riot Games?" answered from the log of earlier applications.
 * `previouslyApplied` says whether the person has applied to that company before. Without it the
 * person is asked. A question about this exact role gets No when there is no earlier application
 * and is left for the person when there is one.
 */
export function previouslyAppliedAnswer(field: FormField, company: string, previouslyApplied?: (company: string) => boolean): MappedAnswer | null {
  if (field.type === 'file' || !company.trim()) return null
  const plain = plainOf(field.label)
  const followUp = FOLLOW_UP.test(plain)
  const sentence = plain.split('?')[0]
  const match = followUp ? null : APPLIED_QUESTION.exec(sentence)
  // "If applicable, ..." is not about applying. Only "apply", "applied" and "application" make a follow-up one.
  if (followUp ? !/\bappl(?:y|ies|ied|ying|ication|ications)\b/.test(plain) : !match) return null

  if (match) {
    const after = sentence.slice(match.index + match[0].length)
    const own = new Set([...words(company), ...words(normalizeCompany(company))])
    const other = words(after).filter((w) => !APPLIED_FILLER.has(w) && !own.has(w))
    if (other.length > 0) return null
  }

  if (!previouslyApplied) return needs("jobpls can't tell whether you applied here before. Answer it yourself.")
  let before: boolean
  try {
    before = previouslyApplied(company)
  } catch {
    return needs("jobpls can't tell whether you applied here before. Answer it yourself.")
  }
  if (followUp) return before ? null : followUpSkipped(field, 'Left blank because you have not applied here before.')
  if (before && THIS_ROLE.test(sentence)) return needs('You applied here before. Check whether it was this role and answer yourself.')
  return yesNo(field, before)
}

// ---------------------------------------------------------------------------
// Family and friends who work at the company, and referrals
// ---------------------------------------------------------------------------

/**
 * "known" answers from a fact the person gave and runs with the other facts. "inferred" asks the
 * person when they gave none, and runs after their saved answers, so a saved answer still wins.
 */
type Mode = 'known' | 'inferred'

/** Family, friend and referral questions the person has not given a fact for. They are theirs to answer. */
export function unansweredHistoryAnswer(field: FormField, ctx: MapContext): MappedAnswer | null {
  const plain = plainOf(field.label)
  const facts = ctx.profile.application
  return relativesAnswer(field, plain, facts, ctx.company, 'inferred') ?? referralAnswer(field, plain, facts, 'inferred')
}

const RELATIVE = /\b(?:family(?: members?)?|relatives?|relations|friends?|spouses?|partners?|significant others?|loved ones|close contacts?)\b/
const WORKS_AT = /\b(?:work|works|worked|working|employed|employ\w*)\b/
// The company itself: its name, or "us", "our company", "this organization".
const ABOUT_COMPANY = /\b(?:us|our|this company|the company|company|organi[sz]ation|employer|team|studio)\b/

/** Whether the question asks about the company itself, by name or in general words. */
function aboutCompany(plain: string, company: string): boolean {
  if (ABOUT_COMPANY.test(plain)) return true
  const own = words(normalizeCompany(company))
  if (own.length === 0) return false
  const text = ` ${words(plain).join(' ')} `
  return text.includes(` ${own.join(' ')} `)
}

/**
 * "Do you have any immediate family members working at X?" is No when the person said no relative or
 * friend works at the employers they apply to. When they did not say, or said yes, it is theirs to answer.
 */
export function relativesAnswer(field: FormField, plain: string, facts: ApplicationFacts, company: string, mode: Mode): MappedAnswer | null {
  if (field.type === 'file' || !RELATIVE.test(plain) || !WORKS_AT.test(plain)) return null
  const said = facts.relativesAtEmployers === false
  if (FOLLOW_UP.test(plain)) return said && mode === 'known' ? followUpSkipped(field, 'Left blank because no family or friends work there.') : null
  if (!aboutCompany(plain, company) || /\b(?:industry|field|tech|sector|similar role)\b/.test(plain)) return null
  if (said) return mode === 'known' ? yesNo(field, false, 0.85) : null
  if (mode === 'known') return null
  return needs(
    facts.relativesAtEmployers === true
      ? 'You said family or friends work at employers you apply to. Say who yourself.'
      : 'Add whether family or friends work at employers you apply to in Profile.'
  )
}

const REFERRED_QUESTION =
  /\b(?:did|has|have|was|were|do|does)\b[^?]{0,50}\b(?:refer|referred|referral)\b|\bwho (?:referred|refers) you\b|\breferred by\b|\b(?:employee|candidate|internal) referral\b|\breferr?er(?:'s)? (?:name|email|e-mail|full name)\b|\breferral (?:name|email|e-mail|code|id)\b|\brefer(?:red)? you\b/
const NOT_A_REFERRAL_QUESTION = /\breferral (?:source|program|bonus|policy)\b|\bhow did you\b|\bwhere did you\b|\bhear about\b|\breferences?\b|\bwould you (?:like|be willing) to refer\b/
const NO_REFERRAL_OPTIONS = ['None', 'No referral', 'Not referred', 'I was not referred', 'N/A', 'Not applicable']

/**
 * "Did an employee refer you?" and "Who referred you?" are answered for someone who applies without
 * a referral: No, an empty box, or "No referral." for a required text field. Otherwise the person answers.
 */
export function referralAnswer(field: FormField, plain: string, facts: ApplicationFacts, mode: Mode): MappedAnswer | null {
  if (field.type === 'file' || !REFERRED_QUESTION.test(plain) || NOT_A_REFERRAL_QUESTION.test(plain)) return null
  const none = facts.referrals === 'none'
  if (none !== (mode === 'known')) return null
  if (FOLLOW_UP.test(plain)) return none ? followUpSkipped(field, 'Left blank because you apply without a referral.') : null
  // An optional box about a referral is left blank when the person has not said, instead of flagged.
  if (!none && !field.required && (field.type === 'text' || field.type === 'textarea')) return notNeeded('Left blank because you have not said whether you have a referral.')
  if (!none) return needs('Add whether you apply with a referral in Profile.')
  if (field.type === 'text' || field.type === 'textarea') {
    return field.required ? answer(field, 'No referral.', 'profile', 0.85) : notNeeded('Left blank because you apply without a referral.')
  }
  if (field.type === 'checkbox') return answer(field, 'No', 'profile', 0.85)
  if (isChoice(field) && field.options.length > 0) {
    if (hasYesNo(field)) return yesNo(field, false)
    for (const wanted of NO_REFERRAL_OPTIONS) {
      const picked = answer(field, wanted, 'profile', 0.85)
      if (picked) return picked
    }
    return needs('The options on this question have no way to say you were not referred. Choose one yourself.')
  }
  return answer(field, 'No', 'profile', 0.85)
}
