// The demo's version of the Review exceptions. The real grouping runs in the main process
// (src/main/review/exceptions.ts). This one is smaller and only has to look right on sample data.

import { CHOICE_FIELD_TYPES, USER_ONLY_TOPICS, answerNeedsUser } from '@shared/answers'
import { topicFor } from '@shared/questionTopics'
import { classifyReason } from '@shared/reviewReasons'
import type { Application, CouldNotSendGroup, NeedsYouGroup, ReviewExceptions } from '@shared/types'

const DAY = 86_400_000
const USER_ONLY = /\bAI\b|convicted|felony|I agree|consent/i

const clean = (label: string): string => label.replace(/\(\s*required\s*\)/gi, ' ').replace(/[*\s]+$/g, '').replace(/\s+/g, ' ').trim()

/** A wording as the group compares it, so the demo's "answer all" matches the real one. */
export const mockWordingKey = (label: string): string => clean(label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function mockGroupKey(label: string, type?: string): { key: string; topic: string | null; scope: string | null } {
  const text = clean(label)
  const hit = topicFor(text)
  const byLabel = !hit || (type !== undefined && (CHOICE_FIELD_TYPES as readonly string[]).includes(type)) || USER_ONLY_TOPICS.includes(hit.topic)
  if (!byLabel) return { key: `topic:${hit.topic}:${hit.scope ?? ''}`, topic: hit.topic, scope: hit.scope }
  return { key: `label:${mockWordingKey(label)}`, topic: hit?.topic ?? null, scope: hit?.scope ?? null }
}

/** True when the demo form would take the value: a listed choice for select and radio fields. */
export function acceptsMockValue(answer: { type: string; options: string[] }, value: string): boolean {
  if ((answer.type === 'select' || answer.type === 'radio') && answer.options.length > 0) return answer.options.some((o) => o.toLowerCase() === value.trim().toLowerCase())
  return true
}

export function buildMockExceptions(applications: Application[], now = new Date()): ReviewExceptions {
  const open = applications.filter((a) => a.status === 'ready' || a.status === 'needs_attention')
  const groups = new Map<string, NeedsYouGroup>()
  for (const app of open) {
    for (const answer of app.answers.filter(answerNeedsUser)) {
      const g = mockGroupKey(answer.label, answer.type)
      const group = groups.get(g.key) ?? {
        ...g,
        label: clean(answer.label),
        wordings: [] as string[],
        required: true,
        type: answer.options.length === 0 && (answer.type === 'select' || answer.type === 'radio') ? 'text' : answer.type,
        options: answer.options.length > 0 ? answer.options : null,
        userOnly: USER_ONLY.test(answer.label),
        count: 0,
        applications: []
      }
      group.applications.push({ id: app.id, company: app.company, title: app.title, fieldKey: answer.fieldKey, note: answer.note })
      if (!group.wordings.some((w) => mockWordingKey(w) === mockWordingKey(answer.label))) group.wordings.push(clean(answer.label))
      group.count = new Set(group.applications.map((a) => a.id)).size
      groups.set(g.key, group)
    }
  }

  const byReason = new Map<string, CouldNotSendGroup>()
  for (const app of open) {
    if (app.status !== 'needs_attention' || app.answers.some(answerNeedsUser)) continue
    const reason = classifyReason(app.error)
    const group = byReason.get(reason) ?? { reason, count: 0, applications: [] }
    group.applications.push({ id: app.id, company: app.company, title: app.title, error: app.error, screenshotPath: app.screenshotPath, submitClickedAt: app.submitClickedAt })
    group.count += 1
    byReason.set(reason, group)
  }

  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const sentSince = (since: number) => applications.filter((a) => a.status === 'submitted' && a.submittedAt && new Date(a.submittedAt).getTime() >= since)
  const today = sentSince(midnight.getTime())
  const sample = [...today]
    .sort(() => Math.random() - 0.5)
    .slice(0, 5)
    .map((a) => ({ id: a.id, company: a.company, title: a.title, submittedAt: a.submittedAt as string, screenshotPath: a.screenshotPath }))

  return {
    needsYou: [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    couldNotSend: [...byReason.values()].sort((a, b) => b.count - a.count),
    sent: { today: today.length, week: sentSince(midnight.getTime() - 6 * DAY).length, sample },
    totals: { ready: open.filter((a) => a.status === 'ready').length, needsAttention: open.filter((a) => a.status === 'needs_attention').length }
  }
}
