import { describe, expect, it } from 'vitest'
import { answerNeedsUser, isGuess } from './answers'
import type { PreparedAnswer } from './types'

const a = (patch: Partial<PreparedAnswer>): PreparedAnswer => ({
  fieldKey: 'q',
  label: 'Q',
  type: 'text',
  required: true,
  options: [],
  value: 'Something',
  source: 'ai',
  confidence: 0.9,
  needsUser: false,
  note: null,
  lint: null,
  ...patch
})

describe('answerNeedsUser', () => {
  it('flags answers marked for the user and required answers left empty', () => {
    expect(answerNeedsUser(a({ needsUser: true }))).toBe(true)
    expect(answerNeedsUser(a({ value: '  ' }))).toBe(true)
    expect(answerNeedsUser(a({ value: '', required: false }))).toBe(false)
    expect(answerNeedsUser(a({}))).toBe(false)
  })

  it('treats an unticked required box and an empty required multiple choice as empty', () => {
    expect(answerNeedsUser(a({ type: 'checkbox', value: 'false' }))).toBe(true)
    expect(answerNeedsUser(a({ type: 'checkbox', value: 'true' }))).toBe(false)
    expect(answerNeedsUser(a({ type: 'checkboxes', value: '[]' }))).toBe(true)
    expect(answerNeedsUser(a({ type: 'multiselect', value: '["Go"]' }))).toBe(false)
  })

  it('never counts an optional question, even one an older draft flagged', () => {
    expect(answerNeedsUser(a({ required: false, needsUser: true, value: '' }))).toBe(false)
    expect(answerNeedsUser(a({ required: false, needsUser: true, type: 'checkbox', value: 'false' }))).toBe(false)
    expect(answerNeedsUser(a({ required: false, needsUser: true, type: 'file', value: '' }))).toBe(false)
    expect(answerNeedsUser(a({ required: true, needsUser: true, type: 'file', value: '' }))).toBe(true)
  })

  it('leaves files to the upload check', () => {
    expect(answerNeedsUser(a({ type: 'file', value: '' }))).toBe(false)
  })
})

describe('isGuess', () => {
  it('marks filled AI answers below the auto-submit confidence', () => {
    expect(isGuess(a({ confidence: 0.6 }))).toBe(true)
    expect(isGuess(a({ confidence: 0.7 }))).toBe(false)
    expect(isGuess(a({ confidence: 0.6, source: 'profile' }))).toBe(false)
    expect(isGuess(a({ confidence: 0.2, value: '' }))).toBe(false)
  })
})
