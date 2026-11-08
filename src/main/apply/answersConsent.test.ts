import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField, Settings } from '@shared/types'
import type { LlmService } from '../llm/service'
import { answerFields, type AnswerDeps, type SavedAnswer } from './answers'

// Opt-ins, optional consent boxes, demographic questions and required consent, with no model call.

const field = (label: string, type: FieldType = 'text', options: string[] = [], required = true): FormField => ({
  key: label,
  label,
  type,
  required,
  options,
  placeholder: null,
  maxLength: null,
  fileHint: null
})

const llm = { json: () => Promise.reject(new Error('No AI call expected')), text: () => Promise.reject(new Error('No AI call expected')) } as unknown as LlmService
const job = { id: 'j1', company: 'Acme', title: 'Engineer', location: null, description: '', fit: null, source: 'greenhouse' as const }

async function answerOne(f: FormField, settings: Settings = DEFAULT_SETTINGS, saved: SavedAnswer | null = null) {
  const deps: AnswerDeps = { llm, settings, profile: EMPTY_PROFILE, samples: [], findSavedAnswer: () => saved, markAnswerUsed: () => {}, resumePath: null }
  return (await answerFields(deps, job, [f], null)).answers[0]
}

const withAutopilot = (patch: Partial<Settings['autopilot']>): Settings => ({ ...DEFAULT_SETTINGS, autopilot: { ...DEFAULT_SETTINGS.autopilot, ...patch } })

describe('opt-ins', () => {
  it('leaves optional SMS and WhatsApp boxes unticked even though they say "I consent"', async () => {
    for (const label of ['Yes - I consent to receiving SMS text messages', 'Yes - I consent to receiving WhatsApp messages']) {
      expect(await answerOne(field(label, 'checkbox', [], false)), label).toMatchObject({ value: 'false', needsUser: false })
    }
  })

  it('answers a required opt-in dropdown with No', async () => {
    const a = await answerOne(field('Do you opt-in to receive WhatsApp messages from Stripe Recruiting?', 'select', ['Yes', 'No']))
    expect(a).toMatchObject({ value: 'No', needsUser: false })
  })

  it('keeps a required box that opts in flagged', async () => {
    expect(await answerOne(field('I consent to receiving SMS text messages', 'checkbox'))).toMatchObject({ needsUser: true, value: '' })
  })
})

describe('optional questions that only the person answers', () => {
  const palantir = 'As part of our interview process, we may use AI notetakers to record and summarize the conversation. I consent.'

  it('leaves an optional box unticked with a note and no flag', async () => {
    const a = await answerOne(field(palantir, 'checkbox', [], false))
    expect(a).toMatchObject({ value: 'false', needsUser: false, note: 'Optional, so JobPilot leaves it unticked.' })
  })

  it('leaves an optional question blank with a note and no flag', async () => {
    const a = await answerOne(field('Did you use AI tools to write this application?', 'select', ['Yes', 'No'], false))
    expect(a).toMatchObject({ value: '', needsUser: false })
    expect(a.note).toMatch(/Optional/)
  })

  it('still uses the person\'s own saved answer for an optional question', async () => {
    const saved: SavedAnswer = { id: 's1', answer: 'No', kind: 'fact' }
    const a = await answerOne(field('Did you use AI tools to write this application?', 'select', ['Yes', 'No'], false), DEFAULT_SETTINGS, saved)
    expect(a).toMatchObject({ value: 'No', source: 'answer_bank' })
  })

  it('keeps a required one flagged', async () => {
    expect(await answerOne(field(palantir, 'checkbox'))).toMatchObject({ needsUser: true })
    expect(await answerOne(field('Agreement to Arbitrate', 'select', ['I agree', 'I do not agree']))).toMatchObject({ needsUser: true })
  })

  it('words the saved-answer note by the setting', async () => {
    const saved: SavedAnswer = { id: 's1', answer: 'No', kind: 'fact' }
    const q = field('Did you use AI tools to write this application?', 'select', ['Yes', 'No'])
    expect((await answerOne(q, DEFAULT_SETTINGS, saved)).note).toBe("From your saved answers. Autopilot won't send a form with this question unless Settings allows it.")
    expect((await answerOne(q, withAutopilot({ sendSavedUserAnswers: true }), saved)).note).toBe('From your saved answers.')
  })
})

describe('required privacy and truthfulness boxes', () => {
  const discord = 'By checking this box, I consent to Acme collecting, storing, and processing my demographic data for the purpose of reviewing applications.'
  const workable = 'Can you confirm that everything in this application is true, accurate and complete?'

  it('flags them while the setting is off', async () => {
    expect(await answerOne(field(discord, 'checkbox'))).toMatchObject({ needsUser: true, value: '' })
    expect(await answerOne(field(workable, 'select', ['Yes', 'No']))).toMatchObject({ needsUser: true })
  })

  it('agrees to them when the setting is on', async () => {
    const on = withAutopilot({ tickRequiredConsent: true })
    expect(await answerOne(field(discord, 'checkbox'), on)).toMatchObject({ value: 'true', source: 'settings', confidence: 1, needsUser: false, note: 'Agreed because Settings allows it.' })
    expect(await answerOne(field(workable, 'select', ['Yes', 'No']), on)).toMatchObject({ value: 'Yes', source: 'settings', confidence: 1, needsUser: false })
  })

  it('still flags arbitration, terms and AI-use questions with the setting on', async () => {
    const on = withAutopilot({ tickRequiredConsent: true })
    expect(await answerOne(field('I agree to the Terms of Service', 'checkbox'), on)).toMatchObject({ needsUser: true })
    expect(await answerOne(field('Agreement to Arbitrate', 'checkbox'), on)).toMatchObject({ needsUser: true })
    expect(await answerOne(field('I confirm I did not use AI to write this application', 'checkbox'), on)).toMatchObject({ needsUser: true })
  })
})

describe('demographic questions with no decline option', () => {
  it('leaves an optional one blank without asking the AI', async () => {
    expect(await answerOne(field('Gender Identity (optional)', 'select', ['Man', 'Woman'], false))).toMatchObject({ value: '', needsUser: false })
  })

  it('flags a required one', async () => {
    expect(await answerOne(field('Gender', 'select', ['Man', 'Woman']))).toMatchObject({ needsUser: true })
  })
})
