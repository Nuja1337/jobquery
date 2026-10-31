import type { AnswerBankEntry, AnswerKind } from '@shared/types'
import { jaccard, normalizeQuestion } from '../../util/text'
import { type Db, newId, now } from '../database'

interface AnswerRow {
  id: string
  question: string
  question_norm: string
  answer: string
  kind: AnswerKind
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

  save(input: AnswerInput): AnswerBankEntry {
    const id = input.id ?? newId()
    this.db.run(
      `INSERT INTO answer_bank (id, question, question_norm, answer, kind, times_used, updated_at)
       VALUES (:id, :question, :norm, :answer, :kind, 0, :at)
       ON CONFLICT(id) DO UPDATE SET question = :question, question_norm = :norm, answer = :answer, kind = :kind, updated_at = :at`,
      { id, question: input.question.trim(), norm: normalizeQuestion(input.question), answer: input.answer, kind: input.kind, at: now() }
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM answer_bank WHERE id = :id', { id })
  }

  /** Exact match on the normalized question first, then the closest entry with similarity of 0.8 or more. */
  findBest(question: string): AnswerBankEntry | null {
    const norm = normalizeQuestion(question)
    if (!norm) return null
    const exact = this.db.get<AnswerRow>('SELECT * FROM answer_bank WHERE question_norm = :norm LIMIT 1', { norm })
    if (exact) return toEntry(exact)
    let best: AnswerRow | null = null
    let bestScore = 0
    for (const row of this.db.all<AnswerRow>('SELECT * FROM answer_bank')) {
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
