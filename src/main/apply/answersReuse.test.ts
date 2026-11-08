import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField } from '@shared/types'
import { makeTestEnv } from '../testing'
import type { LlmService } from '../llm/service'
import { answerFields, type AnswerDeps } from './answers'

// A saved answer to one question must never answer a question that asks the opposite on the same topic.

const field = (label: string, type: FieldType = 'radio', options: string[] = ['Yes', 'No']): FormField => ({
  key: label,
  label,
  type,
  required: true,
  options,
  placeholder: null,
  maxLength: null,
  fileHint: null
})
const llm = { json: () => Promise.reject(new Error('No AI call expected')), text: () => Promise.reject(new Error('No AI call expected')) } as unknown as LlmService
const job = { id: 'j1', company: 'Acme', title: 'Engineer', location: null, description: '', fit: null, source: 'greenhouse' as const }

async function setup() {
  const { ctx } = await makeTestEnv()
  const settings = { ...DEFAULT_SETTINGS, autopilot: { ...DEFAULT_SETTINGS.autopilot, sendSavedUserAnswers: true } }
  const deps: AnswerDeps = {
    llm,
    settings,
    profile: EMPTY_PROFILE,
    samples: [],
    findSavedAnswer: (q, options) => {
      const hit = ctx.answers.findBest(q, options)
      return hit ? { id: hit.id, answer: hit.answer, kind: hit.kind, topic: hit.topic } : null
    },
    markAnswerUsed: () => {},
    resumePath: null
  }
  return { ctx, deps }
}

describe('saved answers on the same topic', () => {
  it('does not answer a background check consent from a saved "No" to a conviction question', async () => {
    const { ctx, deps } = await setup()
    ctx.answers.save({ question: 'Have you ever been convicted of a crime?', answer: 'No', kind: 'fact' })
    const [consent] = (await answerFields(deps, job, [field('Do you consent to a criminal background check?')], null)).answers
    expect(consent).toMatchObject({ value: '', needsUser: true })
    const [same] = (await answerFields(deps, job, [field('Have you ever been convicted of a crime?')], null)).answers
    expect(same).toMatchObject({ value: 'No', source: 'answer_bank', needsUser: false })
  })

  it('does not answer a no-AI certification from a saved "Yes" to an AI-use question', async () => {
    const { ctx, deps } = await setup()
    ctx.answers.save({ question: 'Did you use AI to help with this application?', answer: 'Yes', kind: 'fact' })
    const [certify] = (await answerFields(deps, job, [field('Do you certify that you did not use AI tools to write this application?')], null)).answers
    expect(certify).toMatchObject({ value: '', needsUser: true })
  })

  it('still reuses a saved text answer on a generic topic for another wording', async () => {
    const { ctx, deps } = await setup()
    ctx.answers.save({ question: 'What is your greatest weakness?', answer: 'I over-polish early drafts.', kind: 'fact' })
    const [weakness] = (await answerFields(deps, job, [field('What would you say are your weaknesses?', 'textarea', [])], null)).answers
    expect(weakness).toMatchObject({ value: 'I over-polish early drafts.', source: 'answer_bank' })
  })

  it('does not reuse a saved yes/no answer on the same topic for a differently worded choice field', async () => {
    const { ctx, deps } = await setup()
    ctx.answers.save({ question: 'Are you legally authorized to work in the United States?', answer: 'Yes', kind: 'fact' })
    // The model has nothing to say, so the field is left for the person.
    const quiet = { ...deps, llm: { json: async () => ({ value: { answers: [] }, costUsd: 0 }) } as unknown as LlmService }
    const [auth] = (await answerFields(quiet, job, [field('Are you authorized to work in the US, and do you agree to provide proof on request?')], null)).answers
    expect(auth.source).not.toBe('answer_bank')
  })
})
