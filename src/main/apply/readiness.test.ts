import { describe, expect, it } from 'vitest'
import type { FormField, PreparedAnswer } from '@shared/types'
import { COVER_LETTER_PDF } from './answers'
import { lintText } from '../writing/lint'
import { heldLetterNote, letterHeld, letterInUse, statusAfterEdit } from './readiness'

const answer = (patch: Partial<PreparedAnswer> = {}): PreparedAnswer => ({
  fieldKey: 'q',
  label: 'Q',
  type: 'text',
  required: true,
  options: [],
  value: 'Yes',
  source: 'profile',
  confidence: 1,
  needsUser: false,
  note: null,
  lint: null,
  ...patch
})
const form: FormField[] = [{ key: 'q', label: 'Q', type: 'text', required: true, options: [], placeholder: null, maxLength: null, fileHint: null }]
const app = (patch: Partial<Parameters<typeof statusAfterEdit>[0]> = {}) => ({ status: 'needs_attention' as const, submitMode: null, submitClickedAt: null, formFields: form, ...patch })

describe('statusAfterEdit', () => {
  it('moves a fixed draft to ready', () => {
    expect(statusAfterEdit(app(), [answer()], null)).toBe('ready')
  })

  it('moves a ready draft back when an answer needs the person', () => {
    expect(statusAfterEdit(app({ status: 'ready' }), [answer({ value: '' })], null)).toBe('needs_attention')
    expect(statusAfterEdit(app({ status: 'ready' }), [answer({ needsUser: true })], null)).toBe('needs_attention')
  })

  it('leaves the status alone when nothing changes', () => {
    expect(statusAfterEdit(app({ status: 'ready' }), [answer()], null)).toBeNull()
    expect(statusAfterEdit(app(), [answer({ value: '' })], null)).toBeNull()
  })

  it('keeps a draft out of ready while an answer from the live form is unsaved, and frees it once a person saved', () => {
    const live = answer({ value: 'Because...', source: 'ai', liveOnly: true })
    expect(statusAfterEdit(app(), [live], null)).toBeNull()
    expect(statusAfterEdit(app({ status: 'ready' }), [live], null)).toBe('needs_attention')
    expect(statusAfterEdit(app(), [{ ...live, liveOnly: undefined }], null)).toBe('ready')
    // An empty optional answer from the live form says nothing the person could have missed.
    expect(statusAfterEdit(app(), [answer({ value: '', required: false, liveOnly: true })], null)).toBe('ready')
  })

  it('ignores optional questions', () => {
    expect(statusAfterEdit(app(), [answer({ required: false, value: '', needsUser: true })], null)).toBe('ready')
  })

  it('never touches other statuses', () => {
    for (const status of ['draft', 'submitting', 'submitted', 'failed', 'withdrawn'] as const) {
      expect(statusAfterEdit(app({ status }), [answer()], null), status).toBeNull()
    }
  })

  it('never moves an application that was opened for sending', () => {
    expect(statusAfterEdit(app({ submitMode: 'assist' }), [answer()], null)).toBeNull()
    expect(statusAfterEdit(app({ submitMode: 'auto' }), [answer()], null)).toBeNull()
    expect(statusAfterEdit(app({ submitClickedAt: '2026-01-01T00:00:00.000Z' }), [answer()], null)).toBeNull()
  })

  it('never moves a draft whose form was not read', () => {
    expect(statusAfterEdit(app({ formFields: [] }), [answer()], null)).toBeNull()
  })

  it('never moves a draft that attaches a cover letter it does not have', () => {
    const upload = answer({ type: 'file', value: COVER_LETTER_PDF, required: false })
    expect(statusAfterEdit(app(), [answer(), upload], null)).toBeNull()
    expect(statusAfterEdit(app(), [answer(), upload], '   ')).toBeNull()
    expect(statusAfterEdit(app(), [answer(), upload], 'Dear team')).toBe('ready')
  })

  it('moves a ready draft back when its cover letter was cleared but an answer still attaches it', () => {
    const upload = answer({ type: 'file', value: COVER_LETTER_PDF, required: false })
    expect(statusAfterEdit(app({ status: 'ready' }), [answer(), upload], '')).toBe('needs_attention')
    expect(statusAfterEdit(app({ status: 'ready' }), [answer(), upload], null)).toBe('needs_attention')
    expect(statusAfterEdit(app({ status: 'ready' }), [answer(), upload], 'Dear team')).toBeNull()
  })

  it('still moves a ready draft to needs_attention when it lacks the cover letter and an answer needs the person', () => {
    const upload = answer({ type: 'file', value: COVER_LETTER_PDF, required: false })
    expect(statusAfterEdit(app({ status: 'ready' }), [answer({ value: '' }), upload], null)).toBe('needs_attention')
  })
})

describe('a letter the style check holds back', () => {
  const upload = answer({ type: 'file', value: COVER_LETTER_PDF, required: false })
  const clean = lintText('I rebuilt the billing system at Ledgerly after a weekend of double charges. The retry fix cut failed payments by 40 percent, and I wrote the nightly check that still runs.')
  const opener = lintText('I am writing to express my interest in this role. I rebuilt the billing system at Ledgerly after a weekend of double charges. The retry fix cut failed payments by 40 percent, and I wrote the nightly check that still runs.')
  const pass = { lint: clean, minLintScore: 80 }
  const held = { lint: opener, minLintScore: 80 }

  it('has a score that passes on its own, so only the blocking rule holds it', () => {
    expect(opener.score).toBeGreaterThanOrEqual(80)
    expect(letterHeld(held)).toBe(true)
    expect(letterHeld(pass)).toBe(false)
    expect(letterHeld({ lint: { ...clean, score: 70 }, minLintScore: 80 })).toBe(true)
    expect(letterHeld({ lint: null, minLintScore: 80 })).toBe(false)
    expect(letterHeld(null)).toBe(false)
  })

  it('keeps a draft in needs_attention while the letter fails the check', () => {
    expect(statusAfterEdit(app(), [answer(), upload], 'Dear team', held)).toBeNull()
    expect(statusAfterEdit(app({ status: 'ready' }), [answer(), upload], 'Dear team', held)).toBe('needs_attention')
  })

  it('frees the draft once the letter passes', () => {
    expect(statusAfterEdit(app(), [answer(), upload], 'Dear team', pass)).toBe('ready')
    expect(statusAfterEdit(app({ status: 'ready' }), [answer(), upload], 'Dear team', pass)).toBeNull()
  })

  it('holds a letter pasted into a cover letter box too', () => {
    const box = { key: 'cover_letter', label: 'Cover letter', type: 'textarea' as const, required: true, options: [], placeholder: null, maxLength: null, fileHint: null }
    const pasted = answer({ fieldKey: 'cover_letter', label: 'Cover letter', type: 'textarea', value: 'Dear team' })
    expect(statusAfterEdit(app({ formFields: [box] }), [pasted], 'Dear team', held)).toBeNull()
    expect(statusAfterEdit(app({ status: 'ready', formFields: [box] }), [pasted], 'Dear team', held)).toBe('needs_attention')
  })

  it('does not hold a letter the form never takes', () => {
    expect(letterInUse(form, [answer()])).toBe(false)
    expect(statusAfterEdit(app(), [answer()], 'Dear team', held)).toBe('ready')
  })

  it('holds nothing when there is no letter text or no check', () => {
    expect(statusAfterEdit(app(), [answer()], null, held)).toBe('ready')
    expect(statusAfterEdit(app(), [answer(), upload], 'Dear team', { lint: null, minLintScore: 80 })).toBe('ready')
    expect(statusAfterEdit(app(), [answer(), upload], 'Dear team')).toBe('ready')
  })

  it('names the top issue in a note that follows the writing rules', () => {
    const note = heldLetterNote(held)
    expect(note).toContain('I am writing to express my interest')
    expect(note).toContain('send this application yourself from Review')
    expect(note).not.toMatch(/[—–]/)
    expect(heldLetterNote({ lint: { ...clean, score: 70 }, minLintScore: 80 })).toContain('Its score is 70 and the minimum is 80.')
  })
})
