// Turns the open applications into the three lists the Review page leads with: questions many
// applications ask (answer once), applications that could not be sent (grouped by reason) and a
// sample of what went out. Pure functions over repo rows, so the rules can be tested without Electron.

import { CHOICE_FIELD_TYPES, USER_ONLY_TOPICS, answerNeedsUser } from '@shared/answers'
import { topicFor } from '@shared/questionTopics'
import { TRANSIENT_REASONS, classifyReason } from '@shared/reviewReasons'
import type { ApplicationStatus, CouldNotSendGroup, ExceptionReason, FieldType, NeedsYouGroup, PreparedAnswer, ReviewExceptions, SubmitMode } from '@shared/types'
import { mustAskUser } from '../apply/fieldMap'
import type { ApplicationsRepo, ReviewRow } from '../db/repos/applications'
import { normalizeQuestion } from '../util/text'

export { TRANSIENT_REASONS, classifyReason }

const DAY_MS = 86_400_000
export const SAMPLE_SIZE = 5

// ---------------------------------------------------------------------------
// Questions that need the person
// ---------------------------------------------------------------------------

/** A label without the required marker, so "Expected salary *" and "Expected salary" read the same. */
export function cleanLabel(label: string): string {
  return label
    .replace(/\(\s*required\s*\)/gi, ' ')
    .replace(/[*\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface GroupKey {
  key: string
  topic: string | null
  scope: string | null
}

/**
 * The group a question belongs to. A text question with a topic groups by topic and scope, so two
 * wordings of the salary question in USD meet and the same question in GBP stays apart. Any other
 * question groups by its label with the case, punctuation and required marker removed. That includes
 * a yes/no or choice field and a question on a topic only the person may answer, because one topic
 * holds opposite questions ("Have you been convicted?" and "Do you consent to a background check?"),
 * and one answer for both would be wrong for one of them. A grouped question keeps its topic and scope
 * for saving the answer.
 */
export function groupKeyFor(label: string, field?: { type: FieldType }): GroupKey {
  const clean = cleanLabel(label)
  const match = topicFor(clean)
  const byLabel = !match || (field !== undefined && CHOICE_FIELD_TYPES.includes(field.type)) || USER_ONLY_TOPICS.includes(match.topic)
  if (!byLabel) return { key: `topic:${match.topic}:${match.scope ?? ''}`, topic: match.topic, scope: match.scope }
  return { key: `label:${normalizeQuestion(clean)}`, topic: match?.topic ?? null, scope: match?.scope ?? null }
}

/** A wording as the group compares it: the label without its required marker, case and punctuation. */
export function wordingKey(label: string): string {
  return normalizeQuestion(cleanLabel(label))
}

const CHOICE_TYPES: FieldType[] = ['select', 'radio', 'multiselect', 'checkboxes', 'combobox']

/** Where the person's answer is stored for an application's field, and what the field accepts. */
export function acceptsValue(answer: Pick<PreparedAnswer, 'type' | 'options'>, value: string): boolean {
  const lower = (s: string) => s.trim().toLowerCase()
  if (answer.type === 'checkbox') return value === 'true' || value === 'false'
  if (answer.options.length === 0) return true
  if (answer.type === 'select' || answer.type === 'radio') return answer.options.some((o) => lower(o) === lower(value))
  if (answer.type === 'multiselect' || answer.type === 'checkboxes') {
    try {
      const picked: unknown = JSON.parse(value)
      return Array.isArray(picked) && picked.every((p) => answer.options.some((o) => lower(o) === lower(String(p))))
    } catch {
      return false
    }
  }
  return true
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = values[0] ?? ''
  for (const [v, n] of counts) if (n > (counts.get(best) ?? 0)) best = v
  return best
}

/** Groups every answer that still needs the person, in applications that are ready or need attention. */
export function groupNeedsYou(rows: ReviewRow[]): NeedsYouGroup[] {
  interface Bucket extends GroupKey {
    answers: Array<{ row: ReviewRow; answer: PreparedAnswer }>
  }
  const buckets = new Map<string, Bucket>()
  for (const row of rows) {
    if (row.status !== 'ready' && row.status !== 'needs_attention') continue
    for (const answer of row.answers) {
      if (!answerNeedsUser(answer)) continue
      const g = groupKeyFor(answer.label, answer)
      const bucket = buckets.get(g.key) ?? { ...g, answers: [] }
      bucket.answers.push({ row, answer })
      buckets.set(g.key, bucket)
    }
  }

  const groups: NeedsYouGroup[] = []
  for (const bucket of buckets.values()) {
    const answers = bucket.answers.map((a) => a.answer)
    const types = new Set(answers.map((a) => a.type))
    const lists = new Set(answers.map((a) => JSON.stringify(a.options)))
    const sameOptions = lists.size === 1 && answers[0].options.length > 0
    const baseType: FieldType = types.size === 1 ? answers[0].type : 'text'
    // A choice field whose choices differ between forms can only take typed text here.
    const type: FieldType = !sameOptions && CHOICE_TYPES.includes(baseType) ? 'text' : baseType
    const label = cleanLabel(mostCommon(answers.map((a) => cleanLabel(a.label))))
    // Every distinct wording, so the person sees what the answer will be used for.
    const wordings = [...new Map(answers.map((a) => [wordingKey(a.label), cleanLabel(a.label)])).values()]
    groups.push({
      key: bucket.key,
      topic: bucket.topic,
      scope: bucket.scope,
      label,
      wordings,
      required: answers.every((a) => a.required),
      type,
      options: sameOptions ? answers[0].options : null,
      userOnly: answers.some((a) => mustAskUser({ label: a.label, type: a.type }) !== null),
      count: new Set(bucket.answers.map((a) => a.row.id)).size,
      applications: bucket.answers.map(({ row, answer }) => ({ id: row.id, company: row.company, title: row.title, fieldKey: answer.fieldKey, note: answer.note }))
    })
  }
  return groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

// ---------------------------------------------------------------------------
// Applications that could not be sent
// ---------------------------------------------------------------------------

/**
 * True when putting the application back in the queue is safe: it needs attention for a passing
 * reason, the app never clicked Submit and no person had the tab. A "no confirmation" with no click means
 * the browser closed on a form the person may have sent by hand, so it never goes back unless autopilot made the attempt.
 */
export function canRetryLater(app: {
  status: ApplicationStatus
  submitClickedAt: string | null
  submitMode: SubmitMode | null
  error: string | null
  /** Who started the last attempt. Null for an application from before the app recorded it. */
  lastAttemptBy?: 'user' | 'autopilot' | null
}): boolean {
  if (app.status !== 'needs_attention' || app.submitClickedAt !== null) return false
  const reason = classifyReason(app.error)
  if (!TRANSIENT_REASONS.includes(reason)) return false
  // A person had the tab, so they may have sent the form by hand.
  if (app.submitMode === 'assist' || app.lastAttemptBy === 'user') return false
  // A "no confirmation" without a recorded click means the person was in the tab. Only an attempt known to be autopilot's is safe.
  if (reason === 'no_confirmation' && app.lastAttemptBy !== 'autopilot') return false
  return true
}

/** Applications that need attention with nothing left for the person to answer, grouped by reason. */
export function groupCouldNotSend(rows: ReviewRow[]): CouldNotSendGroup[] {
  const byReason = new Map<ExceptionReason, CouldNotSendGroup>()
  for (const row of rows) {
    if (row.status !== 'needs_attention' || row.answers.some(answerNeedsUser)) continue
    const reason = classifyReason(row.error)
    const group = byReason.get(reason) ?? { reason, count: 0, applications: [] }
    group.applications.push({ id: row.id, company: row.company, title: row.title, error: row.error, screenshotPath: row.screenshotPath, submitClickedAt: row.submitClickedAt })
    group.count += 1
    byReason.set(reason, group)
  }
  return [...byReason.values()].sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

function startOfDay(now: Date): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

export function buildExceptions(applications: ApplicationsRepo, now: Date = new Date()): ReviewExceptions {
  const rows = applications.reviewRows(['ready', 'needs_attention'])
  const today = startOfDay(now)
  const weekStart = new Date(today.getTime() - 6 * DAY_MS)
  return {
    needsYou: groupNeedsYou(rows),
    couldNotSend: groupCouldNotSend(rows),
    sent: {
      today: applications.countSubmittedSince(today.toISOString()),
      week: applications.countSubmittedSince(weekStart.toISOString()),
      sample: applications.randomSubmittedSince(today.toISOString(), SAMPLE_SIZE)
    },
    totals: {
      ready: rows.filter((r) => r.status === 'ready').length,
      needsAttention: rows.filter((r) => r.status === 'needs_attention').length
    }
  }
}
