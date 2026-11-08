import type { AnswerSource, Education, FormField, Profile, Settings, SourceKind } from '@shared/types'
import { normalizeCompany } from '../pipeline/dedupe'
import { countryOf, isCountryName, jobCountry } from '../util/geo'
import { jaccard, normalizeQuestion } from '../util/text'
import { citizenshipAnswer, mapApplicationField } from './applicationFacts'
import { employmentHistoryAnswer, unansweredHistoryAnswer } from './companyQuestions'
import { namedCountries, namedCountry, sameCountryName } from './countries'

// Answers that come straight from the profile or settings, with no model call.
// Anything this can't answer with confidence is left for the answer bank or the AI.

export interface MappedAnswer {
  value: string
  source: AnswerSource
  confidence: number
  needsUser: boolean
  note: string | null
}

const DECLINE = /decline|prefer not|don'?t wish|do not wish|not to (?:say|disclose|answer|self.?identify)|rather not|choose not/i

export const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** True when every word of `part` appears as a whole word in `whole`. */
const hasAllWords = (whole: string[], part: string[]) => part.length > 0 && part.every((w) => whole.includes(w))

/** The only option that passes the test, or null when none or several do. */
const only = (options: string[], test: (o: string) => boolean): string | null => {
  const hits = options.filter(test)
  return hits.length === 1 ? hits[0] : null
}

/** A trailing phone dial code, such as the " +1" in "United States +1". */
const DIAL_CODE = /\s*\(?\+\d[\d\s-]*\)?\s*$/
const withoutDialCode = (text: string): string => text.replace(DIAL_CODE, '').trim()

/**
 * Picks the option that matches the wanted answer. Words are compared whole, so "Male" never picks
 * "Cisgender female" and "Asian" never picks "White/Caucasian". When two options fit equally well it
 * returns null, so the field is left for the user instead of guessed. A trailing dial code is noise,
 * so "United States" picks "United States +1" and not "United States Minor Outlying Islands +1".
 */
export function pickOption(options: string[], wanted: string): string | null {
  if (options.length === 0) return null
  const w = wanted.trim().toLowerCase()
  const exact = options.find((o) => o.trim().toLowerCase() === w)
  if (exact) return exact
  if (options.some((o) => DIAL_CODE.test(o))) {
    const bare = options.map(withoutDialCode)
    const hit = pickCore(bare, wanted)
    if (hit !== null && bare.filter((b) => b === hit).length === 1) return options[bare.indexOf(hit)]
  }
  return pickCore(options, wanted)
}

function pickCore(options: string[], wanted: string): string | null {
  const w = wanted.trim().toLowerCase()
  const exact = options.find((o) => o.trim().toLowerCase() === w)
  if (exact) return exact
  if (w === 'yes' || w === 'no') {
    const re = w === 'yes' ? /^\s*yes\b/i : /^\s*no\b/i
    return only(options, (o) => re.test(o))
  }
  if (w === 'decline') return options.find((o) => DECLINE.test(o)) ?? null
  const ww = words(wanted)
  const sameWords = only(options, (o) => words(o).join(' ') === ww.join(' '))
  if (sameWords) return sameWords
  // "Asian" picks "Asian (not Hispanic or Latino)", but not when "East Asian" and "South Asian" both fit.
  const containing = options.filter((o) => hasAllWords(words(o), ww))
  if (containing.length === 1) return containing[0]
  if (containing.length > 1) return null
  const within = only(options, (o) => hasAllWords(ww, words(o)))
  if (within) return within
  const scored = options
    .map((o) => ({ o, s: jaccard(normalizeQuestion(o), normalizeQuestion(wanted)) }))
    .sort((a, b) => b.s - a.s)
  if (!scored[0] || scored[0].s < 0.5) return null
  return scored[1] && scored[1].s === scored[0].s ? null : scored[0].o
}

export const isChoice = (f: FormField) => ['select', 'radio', 'combobox', 'multiselect', 'checkboxes'].includes(f.type)

export function answer(field: FormField, wanted: string, source: AnswerSource, confidence: number, note: string | null = null): MappedAnswer | null {
  if (!wanted.trim()) return null
  if (isChoice(field) && field.options.length > 0) {
    const picked = pickOption(field.options, wanted)
    if (!picked) return null
    const value = field.type === 'multiselect' || field.type === 'checkboxes' ? JSON.stringify([picked]) : picked
    return { value, source, confidence, needsUser: false, note }
  }
  if (field.type === 'checkbox') {
    return { value: /^(yes|true|1|checked)$/i.test(wanted) ? 'true' : 'false', source, confidence, needsUser: false, note }
  }
  return { value: wanted, source, confidence, needsUser: false, note }
}

const STOP_WORDS = new Set(['what', 'are', 'your', 'you', 'do', 'does', 'is', 'the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'have', 'any', 'this', 'role', 'position', 'would', 'be', 'if', 'my', 'i'])

function contentWords(text: string): Set<string> {
  return new Set(normalizeQuestion(text).split(' ').filter((w) => w && !STOP_WORDS.has(w)))
}

/** Share of the shorter question's meaningful words found in the longer one, 0 to 1. */
function overlap(a: string, b: string): number {
  const wa = contentWords(a)
  const wb = contentWords(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / Math.min(wa.size, wb.size)
}

/** Finds a fact the user gave ("Notice period: 2 weeks") that matches the question. */
export function matchFact(profile: Profile, label: string): string | null {
  let best: { answer: string; score: number } | null = null
  for (const fact of profile.facts) {
    const score = Math.max(overlap(label, fact.question), jaccard(normalizeQuestion(label), normalizeQuestion(fact.question)))
    if (score >= 0.75 && (!best || score > best.score)) best = { answer: fact.answer, score }
  }
  return best?.answer ?? null
}

function currentJob(profile: Profile) {
  const first = profile.experience[0]
  if (!first) return null
  const end = (first.end ?? '').trim().toLowerCase()
  return end === '' || end === 'present' || end === 'current' || end === 'now' ? first : null
}

const HEARD_ABOUT: Partial<Record<SourceKind, string>> = {
  greenhouse: 'Company website',
  lever: 'Company website',
  ashby: 'Company website',
  smartrecruiters: 'Company website',
  workable: 'Company website',
  remotive: 'Job board',
  remoteok: 'Job board',
  arbeitnow: 'Job board',
  adzuna: 'Job board',
  himalayas: 'Job board',
  jobicy: 'Job board',
  themuse: 'Job board',
  weworkremotely: 'Job board',
  rippling: 'Company website',
  breezy: 'Company website',
  personio: 'Company website',
  hn_whoishiring: 'Hacker News',
  manual: 'Company website'
}

const AI_TERMS = /\b(ai|a\.i\.|genai|gen ai|generative ai|artificial intelligence|llms?|large language models?|chatgpt|gpt-?\d*|copilot|claude|gemini|machine[- ]generated)\b/i
const APPLICATION_TERMS = /\b(polic(y|ies)|disclos\w*|(your|this|the|my) application|this form|cover letter|resume|cv|submission|(your|these|the|my) (answers|responses)|(prepar|complet|writ|draft|fill)\w* (this|your|the|these)\b)/i
// Wording about AI producing text for the person, as opposed to AI as the subject of the job.
// "Did you use AI assistance?" and "Were any answers generated by ChatGPT?" have it. "Which LLM
// tools have you used in production?" doesn't, and is left to the writer.
const AI_USE_TERMS = /\b(assist(ance|ed)?|generated|wrote|written|authored|drafted|ghostwr\w*)\b/i
const LEGAL_TERMS = /arbitrat|non-?compete|non-?solicit|legal agreement|terms of (the )?agreement|terms of (service|use)|terms (and|&) conditions|\bwaive|\bwaiver\b|\bcertify\b|\battest|\bi declare\b|under penalty|true,? (complete|accurate) and|true and (complete|correct|accurate)|\bi (agree|consent|acknowledge|confirm|understand)\b|\b(please )?confirm (that|you)\b|privacy (policy|notice)|data (processing|retention|protection)|\bgdpr\b/i

// Questions about criminal history. A saved answer of the person's own may fill them, and autopilot sends
// the form only when Settings allows it, like the other user-only questions.
const LEGAL_HISTORY_TERMS = /\b(convicted|conviction|criminal|felony|felonies|misdemeanou?r|arrested|arrest record)\b/i

/**
 * Questions only the person can answer: how they used AI on the application, legal history, legal agreements,
 * attestations and consent. Returns a note for the user, or null. Checked before anything else,
 * including regenerate, and the AI is never asked. A saved answer of the user's own still applies.
 */
export function mustAskUser(field: { label: string; type: string }): string | null {
  const label = field.label
  if (AI_TERMS.test(label) && (APPLICATION_TERMS.test(label) || AI_USE_TERMS.test(label) || field.type === 'checkbox')) {
    return 'This employer asks about AI use in applications. Read their policy and answer this yourself.'
  }
  if (LEGAL_HISTORY_TERMS.test(label)) return 'This asks about legal history. Answer it yourself.'
  if (LEGAL_TERMS.test(label)) {
    return field.type === 'checkbox'
      ? 'This box agrees to or confirms something on your behalf. Read it and tick it yourself.'
      : 'This is a legal agreement or attestation. Read it and answer it yourself.'
  }
  return null
}

// Opt-ins to messages and marketing. The app always declines them.
const CHANNEL = '(?:sms|text messages?|by text|whatsapp|newsletters?|marketing (?:communications?|emails?|e-?mails?|messages?|materials?|offers?|content)|talent (?:community|network|pool)|job alerts?)'
const OPT_IN_CHANNEL = new RegExp(`\\b${CHANNEL}\\b`, 'i')
// Wording that makes the channel something the person would receive or be contacted by. A question
// about newsletters as a topic ("What newsletters do you subscribe to?") or a job on a team that
// builds them ("Would you like to work on our SMS product?") has none of it.
const OPT_IN_REQUEST = new RegExp(
  [
    new RegExp(`\\b(?:receiv\\w*|hear from)\\b[^.?]{0,80}\\b${CHANNEL}\\b`),
    new RegExp(`\\bget\\s+(?:(?:our|the|my|these|occasional|periodic|regular|weekly)\\s+)*${CHANNEL}\\b`),
    /\bcontacted\b[^.?]{0,60}\b(?:sms|texts?|whatsapp)\b/,
    /opt[\s-]?in/,
    /sign me up/,
    /subscribe me/,
    /keep me (?:updated|informed|posted)/,
    /\bsend me\b/,
    /\btext me\b/,
    /\bcontact me\b/,
    /join our talent (?:community|network|pool)/,
    /^\W*(?:please )?subscribe\b/,
    /^\W*yes\b.*\bconsent\b/
  ]
    .map((r) => r.source)
    .join('|'),
  'i'
)
// First-person requests to receive messages. Job-interest words don't override these.
const OPT_IN_EXPLICIT = /\breceiv\w*|opt[\s-]?in|sign me up|subscribe me|keep me|send me|text me|contact me|\bcontacted\b|join our talent/i
// A question about skills or experience, even when it names SMS or newsletters.
const NOT_OPT_IN = /\b(experience|built|build|describe|how (do|did|would) you|have you|tell us|explain|example)\b/i
// A question about a job on a team that builds the channel.
const JOB_INTEREST = /\b(work on|team|role|position|product|lead|considered|write|join the)\b/i
const OPT_OUT = /\b(do not|don'?t|opt[\s-]?out|unsubscribe|no longer)\b/i

// Options that decline without starting with "No": "I do not opt in", "Decline", "Not interested".
const NO_LIKE = /^\s*(?:i (?:do not|don'?t|would not|won'?t|decline|opt out)|do not|don'?t|decline|opt[\s-]?out|not (?:now|interested|at this time)|unsubscribe)\b/i

/** The option that says no: "No", "No, thanks", or a single option such as "I do not opt in". */
function noOption(options: string[]): string | null {
  return pickOption(options, 'No') ?? only(options, (o) => NO_LIKE.test(o))
}

const isChoiceWithOptions = (f: FormField) => ['select', 'radio', 'combobox', 'multiselect', 'checkboxes'].includes(f.type) && f.options.length > 0

/** True for a question that opts the person in to messages or marketing. */
export function isOptIn(label: string): boolean {
  if (!OPT_IN_CHANNEL.test(label) || !OPT_IN_REQUEST.test(label) || NOT_OPT_IN.test(label) || OPT_OUT.test(label)) return false
  return OPT_IN_EXPLICIT.test(label) || !JOB_INTEREST.test(label)
}

/**
 * Opt-ins to SMS, WhatsApp, newsletters, marketing, a talent community or job alerts are declined:
 * an unticked box, or "No". A required box that must be ticked to opt in is left for the person.
 */
export function optInAnswer(field: FormField): MappedAnswer | null {
  // Text and textarea fields ask for a written answer, never for an opt-in.
  if (field.type === 'file' || field.type === 'text' || field.type === 'textarea' || !isOptIn(field.label)) return null
  const declined = (value: string): MappedAnswer => ({ value, source: 'settings', confidence: 1, needsUser: false, note: 'jobpls declines opt-ins to messages and marketing.' })
  const ask: MappedAnswer = { value: '', source: 'settings', confidence: 0, needsUser: true, note: 'This form requires opting in to messages. Tick it yourself if you want to.' }
  if (field.type === 'checkbox') return field.required ? ask : declined('false')
  if (isChoiceWithOptions(field)) {
    const no = noOption(field.options)
    if (no) return declined(field.type === 'multiselect' || field.type === 'checkboxes' ? JSON.stringify([no]) : no)
    return field.required ? ask : { ...declined(''), confidence: 0, note: null }
  }
  return declined('No')
}

// A box is ticked for the person only when every clause of its label is on this whitelist.
// (a) Consent to the handling of the applicant's own data. GDPR or "data protection" alone is not enough.
const PRIVACY_CONSENT = new RegExp(
  [
    /\b(?:(?:applicant|candidate|recruitment|job applicant) )?privacy (?:policy|notice|statement)s?\b/,
    /\b(?:processing|collect\w*|stor\w*|retain\w*|retention|handl\w*) (?:of )?(?:my|your) (?:\w+ ){0,2}(?:data|information)\b/,
    /\bmy (?:personal |demographic )?data\b/,
    /\b(?:applicant|candidate) data\b/
  ]
    .map((r) => r.source)
    .join('|'),
  'i'
)
// (b) The application's answers are true.
// "True and complete" and "true, accurate and complete" are taken out whole.
const TRUTHFUL = /\b(?:information|answers?|statements?|everything|application)\b[^.]{0,80}\b(?:true|accurate|complete|correct)\b(?:,?\s*(?:and\s+|or\s+)?(?:true|accurate|complete|correct)\b)*/i
// (c) What may stay in a clause once the matched privacy or truthfulness phrase is taken out.
const BEST_KNOWLEDGE = /to the best of my knowledge(?: and belief)?/gi
const ALLOWED_PHRASES = new RegExp(
  [
    BEST_KNOWLEDGE,
    /in accordance with/,
    /as (?:described|set out|outlined) in/,
    /for recruitment purposes/,
    /for (?:up to )?\d+ (?:months?|years?)/,
    /for the purposes? of (?:my|this|reviewing|evaluating|processing)(?: \w+){0,2} applications?/,
    /as part of (?:this|my|the)(?: job)? application/,
    /which i have voluntarily disclosed/,
    /(?:under|pursuant to) (?:the )?gdpr/,
    /the content of/
  ]
    .map((r) => r.source)
    .join('|'),
  'gi'
)
// Words that only say "I agree", name the data being handled, or are small connecting words.
const FILLER_WORDS = new Set(
  (
    'by checking ticking selecting clicking submitting on this the box checkbox form can you do please we i have has read understand acknowledge agree consent confirm accept certify attest declare yes ' +
    'following that and to is are be being with in of for as my your our me it its a an at part may will shall voluntarily disclosed provided ' +
    'personal demographic application applications applicant candidate recruitment recruiting hiring data information company employer s'
  ).split(' ')
)
const DATA_VERB = /^(?:collect\w*|stor\w*|process\w*|retain\w*|retention|handl\w*|use|using)$/
// Where one label turns into another promise: sentence ends, "and I", "and that", "and my", ", I",
// "and the / a / an", "including", and "and" before a verb that agrees to something.
const CLAUSE_BREAK =
  /[.!?;:]+|,?\s+and\s+(?=i\b|that\b|my\b|to\b|the\b|an?\b|(?:consent|agree|authori[sz]e|accept|release|permit|allow|submit|understand|acknowledge|confirm|certify)\b)|,\s*i\b|,?\s*\bincluding\b/gi

// Never ticked for the person, whatever else the box says.
const NEVER_TICK = new RegExp(
  [
    /arbitrat/,
    /non-?compete/,
    /non-?solicit/,
    /\bwaive/,
    /\bwaiver\b/,
    /terms of (the )?agreement/,
    /terms of (service|use)/,
    /terms (and|&) conditions/,
    /\bagreement\b/,
    /background check/,
    /consumer report/,
    /under penalty/,
    /third[- ]part/,
    /\bindemn/,
    /\bbinding\b/,
    /\b(release|liabilit\w*|verif\w*|investigat\w*|references?|biometric\w*|records?|recorded|recording|drug|credit|criminal|convict\w*|automated|clearance)\b/,
    /at[- ]?will|invent|confidential|disparag|handbook|code of (conduct|ethics)|image|likeness|photo|publication|social security|\bssn\b|immigration|health|psychometric|assessment|screening|cookies|advertis/,
    /years old|\bwilling\b|\bable to\b|experience|regulation|familiar|\bknowledge\b/,
    /\b(receiv\w*|marketing|newsletters?|contact(ed)?)\b/,
    /\b(sms|text|phone|whatsapp)\b/,
    /\b(shar(e|ed|es|ing)|transfer\w*|sell|sold|partners?|affiliates?)\b/
  ]
    .map((r) => r.source)
    .join('|'),
  'i'
)

// A question about data processing as a skill isn't consent. The label has to ask for agreement or a confirmation.
const ASKS_AGREEMENT = /\b(consent|agree|acknowledge|accept|confirm|certify|attest|declare|understand|read|permission|authori[sz]e|allow)\b|\b(is|are) (true|accurate|correct)\b|\btrue,? (accurate|complete|correct)/i

/**
 * Takes the privacy or truthfulness phrase out of a clause and checks that only filler, the company's
 * name and the allowed phrases are left. `known` says whether such a phrase was there at all.
 */
function checkClause(clause: string, companyWords: Set<string>): { known: boolean; clean: boolean } {
  let known = false
  const rest = clause
    .toLowerCase()
    .replace(ALLOWED_PHRASES, ' ')
    .replace(new RegExp(PRIVACY_CONSENT.source, 'gi'), () => ((known = true), ' '))
    .replace(new RegExp(TRUTHFUL.source, 'gi'), () => ((known = true), ' '))
  const left = rest.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FILLER_WORDS.has(w) && !DATA_VERB.test(w) && !companyWords.has(w))
  return { known, clean: left.length === 0 }
}

/**
 * True when the box only consents to the handling of the applicant's data or says the answers are
 * true, and agrees to nothing else. `company` is the employer's name, which may appear in the label.
 */
export function isTickableConsent(label: string, company = ''): boolean {
  if (!ASKS_AGREEMENT.test(label) || AI_TERMS.test(label) || isOptIn(label)) return false
  // "To the best of my knowledge" is fine. Any other mention of knowledge is a skill question.
  if (NEVER_TICK.test(label.replace(BEST_KNOWLEDGE, ' '))) return false
  const companyWords = new Set(words(normalizeCompany(company)))
  const checked = label.split(CLAUSE_BREAK).map((c) => c.trim()).filter(Boolean).map((c) => checkClause(c, companyWords))
  return checked.some((c) => c.known) && checked.every((c) => c.clean)
}

export const AGREED_NOTE = 'Agreed because Settings allows it.'

/**
 * With "Tick required privacy and truthfulness boxes" on, a required box of that kind is agreed to:
 * a ticked checkbox, or "Yes". Returns null for anything else.
 */
export function agreeAnswer(field: FormField, settings: Settings, company = ''): MappedAnswer | null {
  if (!settings.autopilot.tickRequiredConsent || !field.required || !isTickableConsent(field.label, company)) return null
  const agreed = (value: string): MappedAnswer => ({ value, source: 'settings', confidence: 1, needsUser: false, note: AGREED_NOTE })
  if (field.type === 'checkbox') return agreed('true')
  if (isChoiceWithOptions(field)) {
    const yes = pickOption(field.options, 'Yes')
    if (!yes) return null
    return agreed(field.type === 'multiselect' || field.type === 'checkboxes' ? JSON.stringify([yes]) : yes)
  }
  return null
}

/** True for an answer that agreeAnswer filled in. */
export function wasAgreedBySettings(answer: { source: AnswerSource; note: string | null; value: string }): boolean {
  return answer.source === 'settings' && answer.note === AGREED_NOTE && answer.value !== ''
}

// "Country" is the phone country code on some forms. The others ask where the person lives.
const COUNTRY_QUESTION = /^(country|country\/region|country or region|country of residence|country of current residence|current country( of residence)?|(please )?(select|choose|enter) the country (where|in which) you (currently )?(reside|live)\.?|what country do you (currently )?(reside|live) in\??|which country do you (currently )?(reside|live) in\??)$/i
const COUNTRY_NOT_RESIDENCE = /\b(work|citizen|citizenship|born|birth|nationality|visa|sponsor|authori[sz]ed)\b/i

const SCHOOL_LABEL = /^(school|school name|university|university name|college|institution|school or university|university or college)$/i
const DISCIPLINE_LABEL = /^(discipline|field of study|major|area of study|study field|discipline \/ field of study|field of study \/ major|major \/ field of study|major or field of study)$/i
const DEGREE_LABEL = /^(degree|degree type|highest degree( earned| obtained| completed)?|highest level of education( completed)?|level of education)$/i

const yearOf = (end: string | undefined): number => {
  const text = (end ?? '').trim().toLowerCase()
  if (/present|current|now|ongoing/.test(text)) return 9999
  const year = text.match(/\b(19|20)\d{2}\b/)
  return year ? Number(year[0]) : 0
}

/** The education entry with the latest end date, or the first one when none has a date. */
export function latestEducation(profile: Profile): Education | null {
  let best: Education | null = null
  for (const ed of profile.education) {
    if (!ed.school.trim() && !ed.degree && !ed.field) continue
    if (!best || yearOf(ed.end) > yearOf(best.end)) best = ed
  }
  return best
}

/** Option texts to try for a degree, best first. "BS" tries "Bachelor of Science" before "Bachelor's Degree". */
export function degreeCandidates(degree: string): string[] {
  const text = degree.trim()
  const t = text.toLowerCase().replace(/[.']/g, '')
  const long = /\s/.test(text) && text.length > 6 ? [text] : []
  if (/\b(phd|dphil|doctorate|doctoral)\b|doctor of philosophy/.test(t)) {
    return [...long, 'Doctor of Philosophy (Ph.D.)', 'Doctor of Philosophy', 'Doctorate', 'Doctoral Degree']
  }
  if (/\bmba\b|master of business administration/.test(t)) {
    return ['Master of Business Administration (M.B.A.)', 'Master of Business Administration', "Master's Degree", 'Masters Degree']
  }
  if (/\b(ms|msc|ma|meng|mfa|med|mph|mpa|master|masters)\b/.test(t)) {
    const specific = /\bmsc?\b|master of science/.test(t) ? ['Master of Science'] : /\bma\b|master of arts/.test(t) ? ['Master of Arts'] : []
    return [...long, ...specific, "Master's Degree", 'Masters Degree', "Master's", 'Masters']
  }
  if (/\b(bs|bsc|bse|ba|bba|beng|bfa|bcom|ab|bachelor|bachelors|undergraduate)\b/.test(t)) {
    const specific = /\bbsc?\b|\bbse\b|bachelor of science/.test(t) ? ['Bachelor of Science'] : /\b(ba|ab)\b|bachelor of arts/.test(t) ? ['Bachelor of Arts'] : []
    return [...long, ...specific, "Bachelor's Degree", 'Bachelors Degree', "Bachelor's", 'Bachelors']
  }
  if (/^(aa|as|aas)\b|\bassociates?\b/.test(t)) return [...long, "Associate's Degree", 'Associates Degree', "Associate's", 'Associate']
  if (/high school|secondary|\bged\b/.test(t)) return ['High School', 'High School Diploma', 'High school or equivalent', 'GED']
  return long
}

function answerDegree(field: FormField, degree: string): MappedAnswer | null {
  if (isChoiceWithOptions(field)) {
    for (const wanted of degreeCandidates(degree)) {
      const picked = pickOption(field.options, wanted)
      if (picked) return answer(field, picked, 'profile', 0.8)
    }
    return null
  }
  return answer(field, degree, 'profile', 0.85)
}

// "Have you ever worked for Figma before?" and "Have you ever been employed by Stripe or a Stripe affiliate?"
const PREVIOUS_EMPLOYMENT = /\b(ever|previously|before|formerly)\b.*\b(worked|employed|employee|contractor|consultant)\b|\b(current|former|past|previous) (employee|contractor|consultant)\b/i
const NOT_EMPLOYMENT = /\b(family|relatives?|friends?|spouse|partner|referr\w*|know anyone|know someone|with|compet\w*|customers?|clients?|vendors?|suppliers?)\b/i

// Words that may follow the company name in a question about working there.
// Any other word is probably part of a longer name, such as "Google DeepMind" after "Google".
const AFTER_COMPANY = 'or|and|before|previously|formerly|ever|as|in|at|since|within|during|either|whether|now|currently|s|inc|llc|ltd|gmbh|corp|corporation|co|company|limited|incorporated|plc|affiliates?|subsidiar\\w+'

/**
 * True when the question asks about working for the company itself: "worked for Figma",
 * "employed by Stripe", "former employee of Acme". The name has to come right after.
 * "Worked with Stripe's API", "worked for a Stripe customer" and "worked remote" don't count.
 */
function namesCompanyAsEmployer(text: string, company: string): boolean {
  const name = words(normalizeCompany(company)).join(' ')
  if (!name) return false
  const lead = '(?:(?:worked|employed) (?:for|at|by)|(?:employee|contractor|consultant) (?:of|at|for))(?: the)?'
  return new RegExp(`(?:^| )${lead} ${name}(?: (?:${AFTER_COMPANY})(?: |$)|$)`).test(words(text).join(' '))
}

/** True when two company names are the same once legal suffixes like Inc and LLC are dropped. */
export function sameCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a)
  const y = normalizeCompany(b)
  return x !== '' && x === y
}

/** True when one name is the other plus more words ("Meta" and "Meta Platforms"). Not the same company for sure. */
export function relatedCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a)
  const y = normalizeCompany(b)
  return x !== '' && y !== '' && x !== y && (x.startsWith(`${y} `) || y.startsWith(`${x} `))
}

// "Are you currently located in the US?" The question has to start by asking where the person is.
const RESIDENCE_SUBJECT = /^(are you|do you) (currently )?(located|based|living|residing|reside|live)\b/i
// Status and eligibility questions that mention a country but don't ask where the person lives.
const NOT_PLAIN_RESIDENCE = /\b(citizen\w*|permanent|green card|lawful|legal\w*|tax\w*|visa|national\w*|authori[sz]ed|resident|residents)\b/i

/** Rank of a degree, 5 for a doctorate down to 1 for high school. 0 when the text isn't recognized. */
function degreeRank(degree: string): number {
  const t = degree.toLowerCase().replace(/[.']/g, '')
  if (/\b(phd|dphil|doctorate|doctoral)\b|doctor of philosophy/.test(t)) return 5
  if (/\bmba\b|master of business administration|\b(ms|msc|ma|meng|mfa|med|mph|mpa|master|masters)\b/.test(t)) return 4
  if (/\b(bs|bsc|bse|ba|bba|beng|bfa|bcom|ab|bachelor|bachelors|undergraduate)\b/.test(t)) return 3
  if (/^(aa|as|aas)\b|\bassociates?\b/.test(t)) return 2
  if (/high school|secondary|\bged\b/.test(t)) return 1
  return 0
}

/** The highest degree on the profile, or null when there is none or one of them isn't recognized. */
export function highestDegree(profile: Profile): string | null {
  let best: { degree: string; rank: number } | null = null
  for (const ed of profile.education) {
    const degree = (ed.degree ?? '').trim()
    if (!degree) continue
    const rank = degreeRank(degree)
    if (rank === 0) return null
    if (!best || rank > best.rank) best = { degree, rank }
  }
  return best?.degree ?? null
}

/** Wording of a question that wants a written answer, not a name, number or link. */
const PROSE = /\b(describe|tell us|explain|share|example|experiences?|skills?|about (a|an|the|your|some)|projects?|built|shipped|worked on|why|how (do|did|would) you)\b/

/** Words of a "how many years of experience" question that don't name a skill. */
const GENERIC_YEARS_WORDS = new Set([
  'how', 'many', 'years', 'year', 'of', 'total', 'overall', 'professional', 'relevant', 'work', 'working',
  'industry', 'full', 'time', 'experience', 'do', 'you', 'have', 'in', 'the', 'your', 'number', 'yrs'
])

type LinkKind = 'linkedin' | 'github' | 'portfolio' | 'website'
const LINK_NAMES: Record<LinkKind, string> = { linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'portfolio', website: 'website' }
/** Fields a link can be typed into. Choices, checkboxes and files never take one. */
const LINK_FIELD_TYPES = new Set(['text', 'textarea', 'url', 'combobox'])
// Wording that asks about the site or about work done there, not for the link itself.
const NOT_A_LINK_QUESTION = /^(?:do|does|did|are|is|have|has|would|can|could|will)\b|\b(?:describe|tell us|explain|examples?|experiences?|projects?|built|build|shipped|worked|why|how|actions|contribut\w*|repos?|repositor\w+|proud|favou?rite|company|employer|school|university|client|references?|referee|manager|supervisor)\b/

/** Which of the person's links a short label asks for, or null when it asks something else. */
function linkKindOf(label: string): LinkKind | null {
  const plain = label.replace(/\(optional\)|\(required\)|\*|:/g, ' ').replace(/\s+/g, ' ').trim()
  if (words(plain).length > 10 || NOT_A_LINK_QUESTION.test(plain)) return null
  if (/linkedin/.test(plain)) return 'linkedin'
  if (/github/.test(plain)) return 'github'
  if (/portfolio/.test(plain)) return 'portfolio'
  if (/\b(?:website|web site|personal site|personal page|homepage)\b/.test(plain)) return 'website'
  return null
}

const AUTHORIZATION =/authori[sz]ed to work|legally (authori[sz]ed|eligible|permitted)|right to work|eligible to work|work permit|legal authori[sz]ation|authori[sz]ation to work/
/** Wording that flips what a question means. An authorization or sponsorship question that has it is left to the person. */
const NEGATED = /\bnot\b|n't\b|\bnever\b|\bno longer\b/
/** "Do you require a work permit?" asks the opposite of "Do you hold a work permit?". */
const NEEDS_PERMIT = /\b(?:require|requires|required|need|needs|needed)\b[^?]{0,40}\b(?:work (?:permit|visa|authori[sz]ation)|authori[sz]ation to work|right to work|(?:a |an )?(?:visa|permit))\b/

export interface MapContext {
  profile: Profile
  settings: Settings
  jobSource: SourceKind
  jobLocation: string | null
  company: string
  /** The ATS board's country, when it has one. Used when the location doesn't name a country ("Remote"). */
  jobCountry?: string | null
  /** The currency the job posting pays in, such as "EUR". */
  jobCurrency?: string | null
  /** The current time. Tests set it so dates are fixed. */
  now?: Date
}

/**
 * Answers common fields from the profile and settings. Returns null when the field
 * isn't one of the known kinds, so the caller can try the answer bank or the AI.
 */
export function mapKnownField(field: FormField, ctx: MapContext): MappedAnswer | null {
  const { profile, settings } = ctx
  const label = field.label.toLowerCase()
  const key = field.key.toLowerCase()
  const both = `${label} ${key}`
  const names = profile.fullName.trim().split(/\s+/)
  const first = names[0] ?? ''
  const last = names.length > 1 ? names.slice(1).join(' ') : ''

  if (field.type === 'file') return null

  // Opt-ins to messages and marketing are declined, ahead of the consent check, as answerFields does.
  const optIn = optInAnswer(field)
  if (optIn) return optIn

  const ask = mustAskUser(field)
  if (ask) return { value: '', source: 'settings', confidence: 0, needsUser: true, note: ask }
  const userOnly = (note: string): MappedAnswer => ({ value: '', source: 'profile', confidence: 0, needsUser: true, note })
  const linkAnswer = (kind: LinkKind, confidence: number): MappedAnswer | null => {
    const { linkedin, github, portfolio, website } = profile.links
    const value = { linkedin, github, portfolio: portfolio || website, website: website || portfolio }[kind]
    if (value.trim()) return answer(field, value, 'profile', confidence)
    const note = `Add your ${LINK_NAMES[kind]} link in Profile.`
    // An optional box stays blank and does not block the form. A required one waits for the person.
    return field.required ? userOnly(note) : { ...userOnly(note), needsUser: false }
  }

  // Facts from the interview: address, phone code, salary, notice period, years with a skill and the
  // like. They come first, since "Phone country code" would otherwise get the phone number. When a
  // fact is missing the answer asks the person, unless they gave the same answer in free-form facts.
  const fromFacts = mapApplicationField(field, ctx)
  if (fromFacts && !(fromFacts.needsUser && matchFact(profile, field.label))) return fromFacts

  // Identity and contact, only for short fields that ask for the value itself. "Describe your
  // experience with GitHub Actions" or "Tell us about a mobile app you shipped" are questions.
  const contactField = field.type === 'email' || field.type === 'tel' || field.type === 'url' || (field.type === 'text' && !PROSE.test(label))
  if (contactField) {
    if (/preferred (first )?name/.test(both)) return answer(field, first, 'profile', 0.9)
    if (/\b(first[\s_-]?name|given name|fname)\b/.test(both)) return answer(field, first, 'profile', 0.98)
    if (/\b(last[\s_-]?name|surname|family name|lname)\b/.test(both)) return answer(field, last, 'profile', 0.98)
    if (/^(full |legal |your )?name\*?$|^full[\s_-]?name|legal name/.test(label.trim()) || key === 'name') return answer(field, profile.fullName, 'profile', 0.95)
    if (field.type === 'email' || /\be-?mail\b/.test(both)) return answer(field, profile.email, 'profile', 0.98)
    if (field.type === 'tel' || /\bphone\b|^(mobile|cell)\b(?!\s+(app|apps|application|dev|development|engineer|platform))|\b(mobile|cell) (phone|number|no)\b/.test(both)) {
      return answer(field, profile.phone, 'profile', 0.95)
    }
    if (/linkedin/.test(both)) return linkAnswer('linkedin', 0.95)
    if (/github/.test(both)) return linkAnswer('github', 0.95)
    if (/portfolio/.test(both)) return linkAnswer('portfolio', 0.9)
    if (/\b(website|personal site)\b/.test(both) && !NOT_A_LINK_QUESTION.test(label)) return linkAnswer('website', 0.85)
    if (/\b(blog|url)\b/.test(both)) return answer(field, profile.links.website || profile.links.portfolio, 'profile', 0.85)
  }
  // A link asked for in a text area or a combobox: "Github profile", "Linkedin". A question that
  // only mentions the site ("Describe your experience with GitHub Actions") is not one of these.
  if (LINK_FIELD_TYPES.has(field.type) && !contactField) {
    const kind = linkKindOf(label)
    if (kind) return linkAnswer(kind, 0.9)
  }
  // "Current or previous employer" takes the most recent job when there's no current one.
  const orPrevious = /\b(current|present)\s+or\s+(previous|past|most recent|last)\b/.test(label)
  const recentJob = () => currentJob(profile) ?? (orPrevious ? (profile.experience[0] ?? null) : null)
  if (/\b(current|present)(\s+or\s+(previous|past|most recent|last))?\s+(company|employer)\b|^company$|employer name/.test(label)) {
    const job = recentJob()
    return job ? answer(field, job.company, 'profile', 0.9) : null
  }
  if (/\b(current|present)(\s+or\s+(previous|past|most recent|last))?\s+(title|role|position|job title)\b/.test(label)) {
    const job = recentJob()
    return job ? answer(field, job.title, 'profile', 0.9) : null
  }
  if (/^(location|city|current location|where are you (currently )?(located|based))/.test(label.trim()) || key === 'location') {
    return answer(field, profile.location, 'profile', 0.85)
  }
  // Total years only. "How many years of Python experience do you have?" names a skill, and the
  // total would be a false answer there. Only a question made of generic words gets the total.
  if (
    /years of (professional |relevant |work |industry )?experience|how many years/.test(label) &&
    words(label).every((w) => GENERIC_YEARS_WORDS.has(w)) &&
    (field.type === 'number' || field.type === 'text') &&
    profile.yearsExperience != null
  ) {
    return answer(field, String(profile.yearsExperience), 'profile', 0.75)
  }

  // Work authorization and sponsorship.
  const countries = profile.workAuthorization.authorizedCountries
  // Lowercase "us" in "work for us" isn't the country. "US" in capitals is. A question that doesn't
  // name a country ("in the region specified for this position") is about the job's country.
  const inJobCountry = jobCountry(ctx.jobLocation, ctx.jobCountry)
  const named = namedCountry(field.label)
  const asked = named ?? inJobCountry
  const authorizedAnywhere = countries.length > 0 || profile.application.authorization.some((e) => e.status !== 'none')
  /** The interview's entry for a country, which wins over the older summary, and what the profile says about working there. */
  const lookup = (country: string | null) => {
    const found = country ? profile.application.authorization.find((e) => sameCountryName(e.country, country)) : undefined
    /** True or false when the profile says whether they may work in the country, else null. */
    const authorized = (): boolean | null => {
      if (found) return found.status !== 'none'
      if (!authorizedAnywhere || !country) return null
      return countries.some((c) => sameCountryName(c, country))
    }
    return { entry: found, authorizedHere: authorized }
  }
  const { entry, authorizedHere } = lookup(asked)
  const notSure = "Couldn't tell which country this asks about. Answer it yourself."
  if (/sponsor/.test(label)) {
    // A country that only the longer list knows (China, Korea) counts only when the question is
    // plainly about needing sponsorship there. Other wording keeps the job's country, as before.
    const plainlyNeeds = /\b(?:require|requires|required|need|needs|needed)\b[^?]{0,60}\bsponsor|\bsponsor\w*\b[^?]{0,40}\b(?:required|needed)\b/.test(label)
    const sponsorFor = named && countryOf(field.label.replace(/\bus\b/g, '')) === null && !plainlyNeeds ? lookup(inJobCountry) : { entry, authorizedHere }
    // Someone who doesn't need sponsorship at home still needs it in a country they aren't
    // authorized to work in.
    const needs = sponsorFor.entry ? sponsorFor.entry.status === 'none' || (sponsorFor.entry.status === 'visa' && sponsorFor.entry.needsSponsorship) : profile.workAuthorization.needsSponsorship || sponsorFor.authorizedHere() === false
    // "Are you authorized to work in the US without sponsorship?" asks the opposite of
    // "Will you require sponsorship?", so Yes there means no sponsorship is needed.
    if (/without\b.{0,40}\bsponsor/.test(label)) {
      if (needs) return answer(field, 'No', 'profile', 0.9)
      if (AUTHORIZATION.test(label) && (countries.length > 0 || profile.application.authorization.length > 0) && authorizedHere() === null) return userOnly(notSure)
      return answer(field, 'Yes', 'profile', 0.9)
    }
    if (NEGATED.test(label)) {
      return userOnly('This sponsorship question is worded in a way the app could misread. Answer it yourself.')
    }
    return answer(field, needs ? 'Yes' : 'No', 'profile', 0.9)
  }
  const asksPermit = NEEDS_PERMIT.test(label) && /\b(?:work|working|employment)\b/.test(label)
  if (asksPermit || AUTHORIZATION.test(label)) {
    if (!authorizedAnywhere && !entry) return null
    if (NEGATED.test(label)) return userOnly('This work authorization question is worded in a way the app could misread. Answer it yourself.')
    // A question about two countries ("China or Japan") has no single answer.
    if (namedCountries(field.label).length > 1) return userOnly(notSure)
    // Needing a permit is the reverse of being authorized. A person with no authorization there, or
    // one who needs sponsorship, needs a permit.
    if (asksPermit) {
      const here = authorizedHere()
      if (!entry && here === null) return userOnly(notSure)
      const needsPermit = entry ? entry.status === 'none' || (entry.status === 'visa' && entry.needsSponsorship) : !here || profile.workAuthorization.needsSponsorship
      return answer(field, needsPermit ? 'Yes' : 'No', 'profile', 0.9)
    }
    const here = authorizedHere()
    return here === null ? userOnly(notSure) : answer(field, here ? 'Yes' : 'No', 'profile', 0.9)
  }

  const citizen = citizenshipAnswer(field, asked, profile.application)
  if (citizen) return citizen

  // Voluntary self-identification. Defaults to declining. When the form has no decline option, an
  // optional question stays blank and a required one is left for the person.
  const needsYou: MappedAnswer = { value: '', source: 'settings', confidence: 0, needsUser: true, note: 'This asks about your background and has no option to decline. Answer it yourself.' }
  const eeo = (pref: string): MappedAnswer | null => {
    if (pref !== 'decline') return answer(field, pref, 'settings', 0.9)
    if (field.type === 'checkbox') {
      return field.required ? needsYou : { value: 'false', source: 'settings', confidence: 0.95, needsUser: false, note: null }
    }
    if (isChoiceWithOptions(field)) {
      const declined = answer(field, 'decline', 'settings', 0.95)
      if (declined) return declined
    }
    return field.required ? needsYou : { value: '', source: 'settings', confidence: 0, needsUser: false, note: null }
  }
  if (/sexual orientation|\blgbt|\bqueer\b|transgender/.test(label)) return eeo('decline')
  if (/\bgender\b|\bsex\b/.test(label)) return eeo(settings.eeo.gender)
  if (/\brace\b|ethnic|hispanic|latino/.test(label)) return eeo(settings.eeo.race)
  if (/veteran/.test(label)) return eeo(settings.eeo.veteran)
  if (/disabilit/.test(label)) return eeo(settings.eeo.disability)
  if (/pronoun/.test(label)) return settings.eeo.pronouns ? answer(field, settings.eeo.pronouns, 'settings', 0.9) : null

  // Source of the application.
  if (/how did you (hear|find|learn)|where did you (hear|find|see)|referral source|source of application/.test(label)) {
    const own = profile.application.heardAbout.trim()
    const wanted = HEARD_ABOUT[ctx.jobSource] ?? (own || 'Company website')
    if (isChoice(field)) {
      const picked =
        pickOption(field.options, wanted) ??
        (own ? pickOption(field.options, own) : null) ??
        pickOption(field.options, 'Company website') ??
        pickOption(field.options, 'Job board') ??
        pickOption(field.options, 'Other')
      return picked ? answer(field, picked, 'settings', 0.8) : null
    }
    return answer(field, wanted, 'settings', 0.8)
  }

  // Facts the user gave in their profile, such as salary expectations or notice period.
  const fact = matchFact(profile, field.label)
  if (fact) return answer(field, fact, 'profile', 0.85)

  // Things the app must never guess.
  if (/salary|compensation|pay expectation|desired pay|expected pay/.test(label)) {
    return { value: '', source: 'profile', confidence: 0, needsUser: true, note: 'Add your salary expectation to your profile facts to fill this automatically.' }
  }
  if (/start date|notice period|when can you start|earliest (start|availability)/.test(label)) {
    return { value: '', source: 'profile', confidence: 0, needsUser: true, note: 'Add your notice period or start date to your profile facts to fill this automatically.' }
  }
  if (/convicted|criminal|felony|background check/.test(label)) {
    return { value: '', source: 'profile', confidence: 0, needsUser: true, note: 'The app never answers legal history questions for you.' }
  }

  return null
}

/**
 * Answers that are inferred from the wording of the question and the profile: country and
 * residence, city and state, education, and whether the person worked for the employer before.
 * They are less certain than the mappings in mapKnownField, so they run after the person's own
 * facts and saved answers, and before the AI.
 */
export function mapInferredField(field: FormField, ctx: MapContext): MappedAnswer | null {
  const { profile } = ctx
  if (field.type === 'file' || mustAskUser(field)) return null
  const label = field.label.toLowerCase()

  // Country and location questions.
  const plain = label.replace(/\(optional\)|\*|:/g, ' ').replace(/\s+/g, ' ').trim()
  const livesIn = profile.application.address.country.trim()
  const home = livesIn ? (countryOf(livesIn) ?? livesIn) : countryOf(profile.location)
  if (COUNTRY_QUESTION.test(plain) && !COUNTRY_NOT_RESIDENCE.test(plain)) {
    if (!home) return null
    const direct = answer(field, home, 'profile', 0.85)
    if (direct || !isChoice(field) || field.options.length === 0) return direct
    // Lists that say "US", "UK" or "The Netherlands": the one option in the same country.
    const same = field.options.filter((o) => countryOf(o) === home)
    return same.length === 1 ? answer(field, same[0], 'profile', 0.85) : null
  }
  // "If located in the US, in what city and state do you reside?"
  if (/\b(what|which) city\b.*\b(reside|live|located|based)\b/i.test(plain) && !/\b(like|prefer|want|willing|relocat\w*|plan)\b/i.test(plain) && profile.location.trim()) {
    const named = countryOf(field.label.replace(/\bus\b/g, ''))
    if (named && home && named !== home) return null
    return answer(field, profile.location, 'profile', 0.85)
  }
  // "Are you currently located in the US?" Only a plain question about where the person lives.
  // Status questions ("Are you a lawful permanent resident...") never match.
  if (RESIDENCE_SUBJECT.test(plain) && !NOT_PLAIN_RESIDENCE.test(plain)) {
    const placeAsked = plain.match(/\b(?:in|within)\s+(?:the\s+)?([^?.,]+?)\s*[?.]*$/i)?.[1]
    if (placeAsked && isCountryName(placeAsked)) {
      const there = countryOf(placeAsked)
      return home && there ? answer(field, home === there ? 'Yes' : 'No', 'profile', 0.85) : null
    }
  }

  // Education, from the most recent entry on the profile.
  const school = latestEducation(profile)
  if (school) {
    // School and discipline boxes search long lists as you type, so the answer is the plain text.
    const typed = (value: string | undefined): MappedAnswer | null =>
      !value?.trim()
        ? null
        : field.type === 'combobox'
          ? { value: value.trim(), source: 'profile', confidence: 0.85, needsUser: false, note: null }
          : answer(field, value, 'profile', 0.85)
    if (SCHOOL_LABEL.test(plain)) return typed(school.school)
    if (DISCIPLINE_LABEL.test(plain)) return typed(school.field)
    if (DEGREE_LABEL.test(plain)) {
      const degree = /\bhighest\b/.test(plain) ? highestDegree(profile) : school.degree
      if (degree) return answerDegree(field, degree)
    }
  }

  // Whether the person worked for this company, "our organization" or a parent company before, and
  // the "If yes, ..." follow-ups of that question.
  const worked = employmentHistoryAnswer(field, ctx)
  if (worked) return worked
  if (ctx.company.trim() && PREVIOUS_EMPLOYMENT.test(plain) && !NOT_EMPLOYMENT.test(plain) && namesCompanyAsEmployer(plain, ctx.company)) {
    if (profile.experience.some((e) => sameCompany(e.company, ctx.company))) return answer(field, 'Yes', 'profile', 0.85)
    // "Meta" and "Meta Platforms" may be one employer. That is for the person to say.
    if (profile.experience.some((e) => relatedCompany(e.company, ctx.company))) {
      return { value: '', source: 'profile', confidence: 0, needsUser: true, note: 'A past employer has a similar name. Answer this yourself.' }
    }
    return answer(field, 'No', 'profile', 0.85)
  }

  // Family, friend and referral questions the person has not given a fact for.
  return unansweredHistoryAnswer(field, ctx)
}

/** True for questions that need a written answer rather than a short value. */
export function isLongAnswer(field: FormField): boolean {
  if (field.type === 'textarea') return true
  if (field.type !== 'text') return false
  return /\b(why|describe|tell us|explain|what (excites|interests|draws)|share|example|how would you)\b/i.test(field.label)
}

export function isCoverLetterField(field: FormField): boolean {
  return /cover\s*letter/i.test(field.label) || /cover_?letter/i.test(field.key)
}
