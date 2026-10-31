import type { LintIssue, LintReport, LintSeverity } from '@shared/types'
import { BANNED_PHRASES, BANNED_SENTENCE_STARTS, PATTERN_RULES } from './rules'

export interface LintOptions {
  /** Extra phrases from the user's settings. */
  extraBanned?: string[]
  /** Expected length in words. Outside the range is flagged. */
  targetWords?: { min: number; max: number }
}

const WEIGHT: Record<LintSeverity, number> = { high: 12, medium: 5, low: 2 }
/** Repeats of one rule stop costing points after this many, so one habit can't zero the score alone. */
const MAX_COUNTED_PER_RULE = 3

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalize(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
}

/** Splits prose into sentences. Good enough for scoring, not for grammar. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => /[a-zA-Z]/.test(s))
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length
}

/** Paragraphs that are only a greeting, sign-off or name don't count toward sentence stats. */
function bodyParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && wordCount(p) > 4)
}

export function lintText(input: string, options: LintOptions = {}): LintReport {
  const text = normalize(input)
  const lower = text.toLowerCase()
  const issues: LintIssue[] = []

  const add = (rule: string, severity: LintSeverity, message: string, match: string | null, index: number | null, suggestion: string | null) =>
    issues.push({ rule, severity, message, match, index, suggestion })

  // Banned phrases, matched on word boundaries.
  const phrases = [
    ...BANNED_PHRASES,
    ...(options.extraBanned ?? []).filter((s) => s.trim()).map((phrase) => ({ phrase: phrase.trim().toLowerCase(), severity: 'medium' as const, suggestion: null }))
  ]
  for (const rule of phrases) {
    const re = new RegExp(`(?<![a-z])${escapeRegex(rule.phrase.toLowerCase())}(?![a-z])`, 'g')
    for (const m of lower.matchAll(re)) {
      add(`phrase:${rule.phrase}`, rule.severity, `"${text.slice(m.index, m.index + m[0].length)}" reads as stock or AI phrasing.`, text.slice(m.index, m.index + m[0].length), m.index, rule.suggestion)
    }
  }

  // Structural patterns.
  for (const rule of PATTERN_RULES) {
    rule.pattern.lastIndex = 0
    for (const m of text.matchAll(rule.pattern)) {
      add(rule.id, rule.severity, rule.message, m[0].trim() || m[0], m.index ?? null, rule.suggestion)
    }
  }

  const paragraphs = bodyParagraphs(text)
  const sentences = paragraphs.flatMap(splitSentences)
  const lengths = sentences.map(wordCount)
  const words = wordCount(text)
  const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0
  const std = lengths.length ? Math.sqrt(lengths.reduce((a, b) => a + (b - avg) ** 2, 0) / lengths.length) : 0

  // Essay connectors at the start of a sentence.
  for (const s of sentences) {
    const first = s.toLowerCase().match(/^[a-z]+/)?.[0]
    if (first && BANNED_SENTENCE_STARTS.includes(first)) {
      add('sentence-start', 'medium', `Starting a sentence with "${first}" reads as essay filler.`, s.slice(0, first.length), text.indexOf(s), 'Drop it or join the sentences.')
    }
  }

  // People vary sentence length a lot. Models tend to keep every sentence about the same.
  if (sentences.length >= 6 && std < 4.5) {
    add('uniform-sentences', 'medium', `Sentences are all about the same length (spread ${std.toFixed(1)} words).`, null, null, 'Mix in a few short sentences and one longer one.')
  }

  // Short fragments used for effect ("No fluff. Just results.").
  const fragments = sentences.filter((s) => wordCount(s) <= 3 && !/^(thanks|thank you|best|cheers|sincerely|regards)/i.test(s))
  if (fragments.length >= 2) {
    add('fragments', 'medium', 'Several short fragments in a row read as slogan writing.', fragments.slice(0, 3).join(' '), null, 'Fold them into full sentences.')
  }

  // Lists of three, the classic rhythm of generated text.
  const triplets = [...text.matchAll(/\b[\w'-]+(?: [\w'-]+){0,2}, [\w'-]+(?: [\w'-]+){0,2},? and [\w'-]+/g)]
  if (triplets.length >= 2) {
    for (const m of triplets.slice(1)) {
      add('triplets', 'medium', 'Another list of three. One or two items usually say it better.', m[0], m.index ?? null, 'Keep the one or two items that matter most.')
    }
  }

  // Every sentence starting with "I".
  const iStarts = sentences.filter((s) => /^I\b/.test(s)).length
  if (sentences.length >= 5 && iStarts / sentences.length > 0.5) {
    add('i-starts', 'low', `${iStarts} of ${sentences.length} sentences start with "I".`, null, null, 'Lead some sentences with the work or the result.')
  }

  for (const para of paragraphs) {
    const n = wordCount(para)
    if (n > 140) add('long-paragraph', 'low', `A ${n}-word paragraph is hard to scan.`, para.slice(0, 60), text.indexOf(para), 'Split it.')
  }

  if (options.targetWords) {
    const { min, max } = options.targetWords
    if (words < min) add('too-short', 'medium', `${words} words, aim for at least ${min}.`, null, null, null)
    if (words > max) add('too-long', 'medium', `${words} words, aim for at most ${max}.`, null, null, 'Cut the least specific sentences first.')
  }

  // Score: start at 100, take points off per issue, counting each rule at most three times.
  const counted = new Map<string, number>()
  let penalty = 0
  for (const issue of issues) {
    const seen = counted.get(issue.rule) ?? 0
    if (seen >= MAX_COUNTED_PER_RULE) continue
    counted.set(issue.rule, seen + 1)
    penalty += WEIGHT[issue.severity]
  }

  issues.sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity] || (a.index ?? 0) - (b.index ?? 0))

  return {
    score: Math.max(0, Math.min(100, 100 - penalty)),
    issues,
    stats: {
      words,
      sentences: sentences.length,
      avgSentenceWords: Math.round(avg * 10) / 10,
      sentenceLengthStdDev: Math.round(std * 10) / 10,
      paragraphs: paragraphs.length
    }
  }
}

/** Turns a lint report into instructions for a revision pass. */
export function issuesToInstructions(report: LintReport, limit = 12): string {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const issue of report.issues) {
    const key = `${issue.rule}|${issue.match ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const where = issue.match ? ` Text: "${issue.match}".` : ''
    const fix = issue.suggestion ? ` Fix: ${issue.suggestion}` : ''
    lines.push(`- ${issue.message}${where}${fix}`)
    if (lines.length >= limit) break
  }
  return lines.join('\n')
}
