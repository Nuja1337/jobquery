import type { AnswerKind } from '@shared/types'

// The saved answers the interview asks for. Each has a question that the answer bank files under the
// slot's topic, so it is found whenever a form asks the same thing in other words.

export interface AnswerSlot {
  topic: string
  /** Stored as the question of the saved answer. */
  question: string
  kind: AnswerKind
  label: string
  hint: string
  rows: number
}

/** Questions only the person answers. The answer is sent only when Settings allows it. */
export const STANCE_SLOTS: AnswerSlot[] = [
  {
    topic: 'ai_use_disclosure',
    question: 'Did you use AI to help with this application?',
    kind: 'fact',
    label: 'Your answer about AI use',
    hint: 'Some employers ask whether you used AI on your application, and some limit it.',
    rows: 3
  },
  {
    topic: 'criminal_history',
    question: 'Have you ever been convicted of a crime?',
    kind: 'fact',
    label: 'Your answer about criminal history',
    hint: 'Some forms ask about convictions where the law allows it. Leave this empty to answer each one yourself.',
    rows: 3
  }
]

/** Answers in the person's own words. jobpls adapts them to each company. */
export const TEMPLATE_SLOTS: AnswerSlot[] = [
  { topic: 'why_company', question: 'Why do you want to work here?', kind: 'template', label: 'Why this company', hint: 'What usually draws you to a company.', rows: 4 },
  { topic: 'about_you', question: 'Tell us about yourself', kind: 'template', label: 'About you', hint: 'How you would introduce yourself in a few sentences.', rows: 4 },
  { topic: 'strengths', question: 'What are your greatest strengths?', kind: 'template', label: 'Your strengths', hint: 'The two or three strengths you would want an employer to know.', rows: 4 }
]
