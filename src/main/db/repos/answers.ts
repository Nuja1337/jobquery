import { CHOICE_FIELD_TYPES, USER_ONLY_TOPICS, sameAttestationWording } from '@shared/answers'
import { COMPANY_SPECIFIC_TOPICS, topicFor } from '@shared/questionTopics'
import type { AnswerBankEntry, AnswerKind, FieldType } from '@shared/types'
import { jaccard, normalizeQuestion } from '../../util/text'
import { type Db, newId, now } from '../database'

interface AnswerRow {
  id: string
  question: string
  question_norm: string
  answer: string
  kind: AnswerKind
  topic: string | null
  scope: string | null
  times_used: number
  updated_at: string
}

export type AnswerInput = Omit<AnswerBankEntry, 'id' | 'timesUsed' | 'updatedAt'> & { id?: string }

const SIMILARITY = 0.8

function toEntry(row: AnswerRow): AnswerBankEntry {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    kind: row.kind,
    topic: row.topic,
    scope: row.scope,
    timesUsed: row.times_used,
    updatedAt: row.updated_at
  }
}

export class AnswerBankRepo {
  constructor(private readonly db: Db) {}

  list(): AnswerBankEntry[] {
    return this.db.all<AnswerRow>('SELECT * FROM answer_bank ORDER BY times_used DESC, updated_at DESC').map(toEntry)
  }

  get(id: string): AnswerBankEntry | null {
    const row = this.db.get<AnswerRow>('SELECT * FROM answer_bank WHERE id = :id', { id })
    return row ? toEntry(row) : null
  }

  /**
   * Saves an answer. The question is classified into a topic and scope unless the caller gives a
   * topic (or null for "no topic"), so every saved answer can be found by what it is about.
   */
  save(input: AnswerInput): AnswerBankEntry {
    const id = input.id ?? newId()
    const found = input.topic === undefined ? topicFor(input.question) : null
    const topic = input.topic === undefined ? (found?.topic ?? null) : input.topic
    const scope = input.topic === undefined ? (found?.scope ?? null) : (input.scope ?? null)
    this.db.run(
      `INSERT INTO answer_bank (id, question, question_norm, answer, kind, topic, scope, times_used, updated_at)
       VALUES (:id, :question, :norm, :answer, :kind, :topic, :scope, 0, :at)
       ON CONFLICT(id) DO UPDATE SET question = :question, question_norm = :norm, answer = :answer, kind = :kind, topic = :topic, scope = :scope, updated_at = :at`,
      { id, question: input.question.trim(), norm: normalizeQuestion(input.question), answer: input.answer, kind: input.kind, topic, scope, at: now() }
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM answer_bank WHERE id = :id', { id })
  }

  /**
   * The saved answer for a question. An exact match on the normalized question comes first. Then an
   * answer on the same topic and scope, however the form words it ("Why do you want to work here?"
   * finds the answer saved for "Why Anthropic?"). Then the closest entry with similarity of 0.8 or more.
   * A fact on a company-specific topic is never reused by topic, since it names the first company.
   *
   * Only an exact match answers a yes/no or choice field, a question on a topic only the person may
   * answer (AI use, criminal history), or any question when `exact` is set. The same topic can ask
   * the opposite question ("Have you been convicted?" and "Do you consent to a background check?"), and a
   * "No" to one is a "Yes" to the other. A topic or similar match is also refused when one question asks
   * for consent, a certification or a background check and the other does not.
   */
  findBest(question: string, options: { fieldType?: FieldType; exact?: boolean } = {}): AnswerBankEntry | null {
    const norm = normalizeQuestion(question)
    if (!norm) return null
    const exact = this.db.get<AnswerRow>('SELECT * FROM answer_bank WHERE question_norm = :norm LIMIT 1', { norm })
    if (exact) return toEntry(exact)

    const match = topicFor(question)
    const exactOnly =
      Boolean(options.exact) || (options.fieldType !== undefined && CHOICE_FIELD_TYPES.includes(options.fieldType)) || (match !== null && USER_ONLY_TOPICS.includes(match.topic))
    if (exactOnly) return null
    const wordingOk = (row: AnswerRow): boolean => sameAttestationWording(question, row.question)

    if (match) {
      const rows = this.db.all<AnswerRow>(
        'SELECT * FROM answer_bank WHERE topic = :topic AND scope IS :scope ORDER BY times_used DESC, updated_at DESC',
        { topic: match.topic, scope: match.scope }
      )
      const byTopic = rows.find((r) => wordingOk(r) && !(r.kind === 'fact' && COMPANY_SPECIFIC_TOPICS.includes(match.topic)))
      if (byTopic) return toEntry(byTopic)
    }

    let best: AnswerRow | null = null
    let bestScore = 0
    for (const row of this.db.all<AnswerRow>('SELECT * FROM answer_bank')) {
      if (!wordingOk(row) || (row.topic !== null && USER_ONLY_TOPICS.includes(row.topic))) continue
      const score = jaccard(norm, row.question_norm)
      if (score >= SIMILARITY && score > bestScore) {
        best = row
        bestScore = score
      }
    }
    return best ? toEntry(best) : null
  }

  markUsed(id: string): void {
    this.db.run('UPDATE answer_bank SET times_used = times_used + 1 WHERE id = :id', { id })
  }
}
