import type { AnswerSource, FormField, Profile, Settings, SourceKind } from '@shared/types'
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

/** Picks the option that best matches the wanted answer. Returns null when nothing fits. */
export function pickOption(options: string[], wanted: string): string | null {
  if (options.length === 0) return null
  const w = wanted.trim().toLowerCase()
  const exact = options.find((o) => o.trim().toLowerCase() === w)
  if (exact) return exact
  if (w === 'yes' || w === 'no') {
    const re = w === 'yes' ? /^\s*yes\b/i : /^\s*no\b/i
    return options.find((o) => re.test(o)) ?? null
  }
  if (w === 'decline') return options.find((o) => DECLINE.test(o)) ?? null
  const starts = options.find((o) => o.toLowerCase().startsWith(w) || w.startsWith(o.toLowerCase()))
  if (starts) return starts
  const contains = options.find((o) => o.toLowerCase().includes(w) || w.includes(o.toLowerCase()))
  if (contains) return contains
  const scored = options
    .map((o) => ({ o, s: jaccard(normalizeQuestion(o), normalizeQuestion(wanted)) }))
    .sort((a, b) => b.s - a.s)
  return scored[0] && scored[0].s >= 0.5 ? scored[0].o : null
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

const COUNTRY_ALIASES: Record<string, RegExp> = {
  'United States': /\b(united states|u\.?s\.?a?\.?|america)\b/i,
  'United Kingdom': /\b(united kingdom|u\.?k\.?|britain|england|scotland|wales)\b/i,
  Canada: /\bcanad/i,
  Australia: /\baustralia/i,
  Germany: /\b(germany|deutschland)\b/i,
  'European Union': /\b(european union|e\.?u\.?)\b/i,
  India: /\bindia\b/i,
  Ireland: /\bireland\b/i,
  Netherlands: /\b(netherlands|holland)\b/i,
  France: /\bfrance\b/i,
  Spain: /\bspain\b/i,
  Israel: /\bisrael\b/i,
  Singapore: /\bsingapore\b/i,
  'New Zealand': /\bnew zealand\b/i
}

function countryIn(text: string): string | null {
  for (const [country, re] of Object.entries(COUNTRY_ALIASES)) if (re.test(text)) return country
  return null
}

function sameCountry(a: string, b: string): boolean {
  const ca = countryIn(a) ?? a
  const cb = countryIn(b) ?? b
  return ca.toLowerCase() === cb.toLowerCase()
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

  // Questions only the person can answer. These also block auto-submit, since they're flagged.
  if (/\bai\b[^.?]{0,60}\b(policy|use|used|usage|assist|assistance|generated|tools?|disclos)|artificial intelligence|use of ai|chatgpt|large language model/i.test(field.label)) {
    return { value: '', source: 'settings', confidence: 0, needsUser: true, note: 'This employer asks about AI use in applications. Read their policy and answer this yourself.' }
  }
  if (/arbitrat|non-?compete|non-?solicit|legal agreement|terms of (the )?agreement|waive/i.test(field.label)) {
    return { value: '', source: 'settings', confidence: 0, needsUser: true, note: 'This is a legal agreement. Read it and decide yourself.' }
  }

  // Identity and contact.
  if (/preferred (first )?name/.test(both)) return answer(field, first, 'profile', 0.9)
  if (/\b(first[\s_-]?name|given name|fname)\b/.test(both)) return answer(field, first, 'profile', 0.98)
  if (/\b(last[\s_-]?name|surname|family name|lname)\b/.test(both)) return answer(field, last, 'profile', 0.98)
  if (/^(full |legal |your )?name\*?$|^full[\s_-]?name|legal name/.test(label.trim()) || key === 'name') return answer(field, profile.fullName, 'profile', 0.95)
  if (field.type === 'email' || /\be-?mail\b/.test(both)) return answer(field, profile.email, 'profile', 0.98)
  if (field.type === 'tel' || /\b(phone|mobile|cell)\b/.test(both)) return answer(field, profile.phone, 'profile', 0.95)
  if (/linkedin/.test(both)) return answer(field, profile.links.linkedin, 'profile', 0.95)
  if (/github/.test(both)) return answer(field, profile.links.github, 'profile', 0.95)
  if (/portfolio/.test(both)) return answer(field, profile.links.portfolio || profile.links.website, 'profile', 0.9)
  if (/\b(website|personal site|blog|url)\b/.test(both) && field.type !== 'textarea') {
    return answer(field, profile.links.website || profile.links.portfolio, 'profile', 0.85)
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
  if (/years of (professional |relevant )?experience|how many years/.test(label) && (field.type === 'number' || field.type === 'text') && profile.yearsExperience != null) {
    return answer(field, String(profile.yearsExperience), 'profile', 0.75)
  }

  // Work authorization and sponsorship.
  if (/sponsor/.test(label)) {
    return answer(field, profile.workAuthorization.needsSponsorship ? 'Yes' : 'No', 'profile', 0.9)
  }
  if (/authori[sz]ed to work|legally (authori[sz]ed|eligible|permitted)|right to work|eligible to work|work permit/.test(label)) {
    const countries = profile.workAuthorization.authorizedCountries
    if (countries.length === 0) return null
    const asked = countryIn(label) ?? (ctx.jobLocation ? countryIn(ctx.jobLocation) : null)
    if (asked) {
      const yes = countries.some((c) => sameCountry(c, asked))
      return answer(field, yes ? 'Yes' : 'No', 'profile', 0.9)
    }
    if (countries.length === 1) {
      return answer(field, 'Yes', 'profile', 0.6, `Assumed the question is about ${countries[0]}. Check this one.`)
    }
    return null
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

  // Consent boxes that must be ticked to submit.
  if (field.type === 'checkbox' && /\b(i agree|i acknowledge|i consent|i confirm|i have read|privacy (policy|notice))\b/.test(label)) {
    return answer(field, 'true', 'settings', 0.85, 'Consent box ticked so the form can be submitted.')
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
