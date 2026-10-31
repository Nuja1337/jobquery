import type { AnswerSource, FormField, Profile, Settings, SourceKind } from '@shared/types'
import { countryOf } from '../util/geo'
import { jaccard, normalizeQuestion } from '../util/text'

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

const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** True when every word of `part` appears as a whole word in `whole`. */
const hasAllWords = (whole: string[], part: string[]) => part.length > 0 && part.every((w) => whole.includes(w))

/** The only option that passes the test, or null when none or several do. */
const only = (options: string[], test: (o: string) => boolean): string | null => {
  const hits = options.filter(test)
  return hits.length === 1 ? hits[0] : null
}

/**
 * Picks the option that matches the wanted answer. Words are compared whole, so "Male" never picks
 * "Cisgender female" and "Asian" never picks "White/Caucasian". When two options fit equally well it
 * returns null, so the field is left for the user instead of guessed.
 */
export function pickOption(options: string[], wanted: string): string | null {
  if (options.length === 0) return null
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

const isChoice = (f: FormField) => ['select', 'radio', 'combobox', 'multiselect', 'checkboxes'].includes(f.type)

function answer(field: FormField, wanted: string, source: AnswerSource, confidence: number, note: string | null = null): MappedAnswer | null {
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

/**
 * Questions only the person can answer: how they used AI on the application, legal agreements,
 * attestations and consent. Returns a note for the user, or null. Checked before anything else,
 * including regenerate, and the AI is never asked. A saved answer of the user's own still applies.
 */
export function mustAskUser(field: { label: string; type: string }): string | null {
  const label = field.label
  if (AI_TERMS.test(label) && (APPLICATION_TERMS.test(label) || AI_USE_TERMS.test(label) || field.type === 'checkbox')) {
    return 'This employer asks about AI use in applications. Read their policy and answer this yourself.'
  }
  if (LEGAL_TERMS.test(label)) {
    return field.type === 'checkbox'
      ? 'This box agrees to or confirms something on your behalf. Read it and tick it yourself.'
      : 'This is a legal agreement or attestation. Read it and answer it yourself.'
  }
  return null
}

/** Wording of a question that wants a written answer, not a name, number or link. */
const PROSE = /\b(describe|tell us|explain|share|example|experiences?|skills?|about (a|an|the|your|some)|projects?|built|shipped|worked on|why|how (do|did|would) you)\b/

/** Words of a "how many years of experience" question that don't name a skill. */
const GENERIC_YEARS_WORDS = new Set([
  'how', 'many', 'years', 'year', 'of', 'total', 'overall', 'professional', 'relevant', 'work', 'working',
  'industry', 'full', 'time', 'experience', 'do', 'you', 'have', 'in', 'the', 'your', 'number', 'yrs'
])

const AUTHORIZATION = /authori[sz]ed to work|legally (authori[sz]ed|eligible|permitted)|right to work|eligible to work|work permit/

export interface MapContext {
  profile: Profile
  settings: Settings
  jobSource: SourceKind
  jobLocation: string | null
  company: string
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

  const ask = mustAskUser(field)
  if (ask) return { value: '', source: 'settings', confidence: 0, needsUser: true, note: ask }
  const userOnly = (note: string): MappedAnswer => ({ value: '', source: 'profile', confidence: 0, needsUser: true, note })

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
    if (/linkedin/.test(both)) return answer(field, profile.links.linkedin, 'profile', 0.95)
    if (/github/.test(both)) return answer(field, profile.links.github, 'profile', 0.95)
    if (/portfolio/.test(both)) return answer(field, profile.links.portfolio || profile.links.website, 'profile', 0.9)
    if (/\b(website|personal site|blog|url)\b/.test(both)) return answer(field, profile.links.website || profile.links.portfolio, 'profile', 0.85)
  }
  if (/\b(current|present)\s+(company|employer)\b|^company$|employer name/.test(label)) {
    const job = currentJob(profile)
    return job ? answer(field, job.company, 'profile', 0.9) : null
  }
  if (/\b(current|present)\s+(title|role|position|job title)\b/.test(label)) {
    const job = currentJob(profile)
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
  // Lowercase "us" in "work for us" isn't the country. "US" in capitals is.
  const asked = countryOf(field.label.replace(/\bus\b/g, '')) ?? (ctx.jobLocation ? countryOf(ctx.jobLocation) : null)
  /** True or false when the profile says whether they may work in the country asked about, else null. */
  const authorizedHere = (): boolean | null => {
    if (countries.length === 0 || !asked) return null
    return countries.some((c) => countryOf(c) === asked || c.trim().toLowerCase() === asked.toLowerCase())
  }
  const notSure = "Couldn't tell which country this asks about. Answer it yourself."
  if (/sponsor/.test(label)) {
    // Someone who doesn't need sponsorship at home still needs it in a country they aren't
    // authorized to work in.
    const needs = profile.workAuthorization.needsSponsorship || authorizedHere() === false
    // "Are you authorized to work in the US without sponsorship?" asks the opposite of
    // "Will you require sponsorship?", so Yes there means no sponsorship is needed.
    if (/without\b.{0,40}\bsponsor/.test(label)) {
      if (needs) return answer(field, 'No', 'profile', 0.9)
      if (AUTHORIZATION.test(label) && countries.length > 0 && authorizedHere() === null) return userOnly(notSure)
      return answer(field, 'Yes', 'profile', 0.9)
    }
    if (/\bnot\b|n't\b|\bnever\b|\bno longer\b/.test(label)) {
      return userOnly('This sponsorship question is worded in a way the app could misread. Answer it yourself.')
    }
    return answer(field, needs ? 'Yes' : 'No', 'profile', 0.9)
  }
  if (AUTHORIZATION.test(label)) {
    if (profile.workAuthorization.authorizedCountries.length === 0) return null
    const here = authorizedHere()
    return here === null ? userOnly(notSure) : answer(field, here ? 'Yes' : 'No', 'profile', 0.9)
  }

  // Voluntary self-identification. Defaults to declining.
  const eeo = (pref: string) => {
    if (pref === 'decline') {
      if (!isChoice(field)) return null
      return answer(field, 'decline', 'settings', 0.95)
    }
    return answer(field, pref, 'settings', 0.9)
  }
  if (/\bgender\b|\bsex\b/.test(label)) return eeo(settings.eeo.gender)
  if (/\brace\b|ethnic|hispanic|latino/.test(label)) return eeo(settings.eeo.race)
  if (/veteran/.test(label)) return eeo(settings.eeo.veteran)
  if (/disabilit/.test(label)) return eeo(settings.eeo.disability)
  if (/pronoun/.test(label)) return settings.eeo.pronouns ? answer(field, settings.eeo.pronouns, 'settings', 0.9) : null

  // Source of the application.
  if (/how did you (hear|find|learn)|where did you (hear|find|see)|referral source|source of application/.test(label)) {
    const wanted = HEARD_ABOUT[ctx.jobSource] ?? 'Company website'
    if (isChoice(field)) {
      const picked =
        pickOption(field.options, wanted) ??
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

/** True for questions that need a written answer rather than a short value. */
export function isLongAnswer(field: FormField): boolean {
  if (field.type === 'textarea') return true
  if (field.type !== 'text') return false
  return /\b(why|describe|tell us|explain|what (excites|interests|draws)|share|example|how would you)\b/i.test(field.label)
}

export function isCoverLetterField(field: FormField): boolean {
  return /cover\s*letter/i.test(field.label) || /cover_?letter/i.test(field.key)
}
