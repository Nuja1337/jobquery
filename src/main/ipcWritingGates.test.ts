import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FitAssessment, FormField, LintReport, PreparedAnswer } from '@shared/types'
import { COVER_LETTER_PDF } from './apply/answers'
import type { WrittenText } from './writing/generate'
import { lintText } from './writing/lint'

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null }, dialog: {}, shell: {} }))

const mocks = vi.hoisted(() => ({
  draft: { impl: null as (() => Promise<unknown>) | null },
  letter: { impl: null as (() => Promise<unknown>) | null },
  /** The options the last regenerated letter was asked with. */
  letterOptions: { last: null as unknown }
}))

vi.mock('./apply/prepare', async (importOriginal) => {
  const original = await importOriginal<typeof import('./apply/prepare')>()
  return { ...original, draftApplication: () => mocks.draft.impl!() }
})
vi.mock('./writing/generate', async (importOriginal) => {
  const original = await importOriginal<typeof import('./writing/generate')>()
  return { ...original, writeCoverLetter: (_llm: unknown, _inputs: unknown, _job: unknown, options: unknown) => {
    mocks.letterOptions.last = options
    return mocks.letter.impl!()
  } }
})

import { createServices } from './ipc'
import { appPaths } from './paths'
import { testVault } from './secrets'
import { makeRaw } from './testing'

// A letter the style check holds back keeps its application out of the ready state. Only an edit that passes frees it.

const FIT: FitAssessment = { score: 95, bucket: 'perfect', summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }
const PLAIN = 'I rebuilt the billing system at Ledgerly after a weekend of double charges. The retry fix cut failed payments by 40 percent, and I wrote the nightly check that still runs.'
const GOOD_LETTER = `Hi Acme team,\n\n${PLAIN}\n\nThanks,\nSam`
const OPENER_LETTER = `Hi Acme team,\n\nI am writing to express my interest in this role. ${PLAIN}\n\nThanks,\nSam`
const lintOf = (text: string): LintReport => lintText(text)

const field = (key: string, label: string, type: FormField['type'], required: boolean, fileHint: FormField['fileHint'] = null): FormField => ({ key, label, type, required, options: [], placeholder: null, maxLength: null, fileHint })
const NAME_FIELD = field('name', 'Full name', 'text', true)
const LETTER_FILE = field('cover_letter_file', 'Cover letter', 'file', true, 'cover_letter')
const RESUME_FILE = field('resume', 'Resume', 'file', true, 'resume')
const answer = (f: FormField, patch: Partial<PreparedAnswer> = {}): PreparedAnswer => ({
  fieldKey: f.key,
  label: f.label,
  type: f.type,
  required: f.required,
  options: [],
  value: 'x',
  source: 'profile',
  confidence: 1,
  needsUser: false,
  note: null,
  lint: null,
  ...patch
})

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
  mocks.draft.impl = null
  mocks.letter.impl = null
})

async function services() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquery-gates-'))
  const s = await createServices({ paths: appPaths(dir), vault: testVault, emit: () => {}, appVersion: '0.0.0' })
  open.push(async () => {
    await s.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const addJob = (company = 'Acme') => {
    const { job } = s.ctx.jobs.upsertRaw(makeRaw({ externalId: `x-${company}`, company }), null)
    s.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    return job.id
  }
  return { ...s, addJob }
}

/** A prepared draft whose form takes a cover letter as a PDF. */
function draftWith(letter: string, fields: FormField[] = [NAME_FIELD, LETTER_FILE]) {
  return async () => ({
    fields,
    formSource: 'api',
    formError: null,
    resolved: null,
    answers: fields.map((f) => answer(f, f.type === 'file' ? { value: COVER_LETTER_PDF, source: 'file' } : {})),
    coverLetter: letter,
    coverLetterLint: lintOf(letter),
    coverLetterNeedsInput: null,
    costUsd: 0
  })
}

describe('a prepared draft with a letter', () => {
  it('is ready when the letter passes the check', async () => {
    const env = await services()
    mocks.draft.impl = draftWith(GOOD_LETTER)
    const app = await env.api.prepareApplication(env.addJob())
    expect(app.status).toBe('ready')
    expect(app.error).toBeNull()
  })

  it('stays in needs_attention, with a note naming the issue, when the letter has a template opener', async () => {
    const env = await services()
    expect(lintOf(OPENER_LETTER).score).toBeGreaterThanOrEqual(80)
    mocks.draft.impl = draftWith(OPENER_LETTER)
    const app = await env.api.prepareApplication(env.addJob())
    expect(app.status).toBe('needs_attention')
    expect(app.error).toContain('held back by the style check')
    expect(app.error).toContain('I am writing to express my interest')
    expect(app.error).toContain('send this application yourself from Review')
  })

  it('is ready when the form has no place for the letter', async () => {
    const env = await services()
    mocks.draft.impl = draftWith(OPENER_LETTER, [NAME_FIELD])
    const app = await env.api.prepareApplication(env.addJob())
    expect(app.status).toBe('ready')
  })
})

describe('editing a held letter', () => {
  async function held() {
    const env = await services()
    mocks.draft.impl = draftWith(OPENER_LETTER)
    const app = await env.api.prepareApplication(env.addJob())
    expect(app.status).toBe('needs_attention')
    return { env, id: app.id }
  }

  it('releases the application only when the edited letter passes, and checks the text it saved', async () => {
    const { env, id } = await held()
    const still = await env.api.updateApplication(id, { coverLetter: `${OPENER_LETTER} More text.` })
    expect(still.status).toBe('needs_attention')
    expect(still.error).toContain('held back by the style check')
    expect(still.coverLetterLint?.issues.some((i) => i.rule.includes('i am writing to express my interest'))).toBe(true)

    const freed = await env.api.updateApplication(id, { coverLetter: GOOD_LETTER })
    expect(freed.status).toBe('ready')
    expect(freed.error).toBeNull()
    expect(freed.coverLetterLint?.issues.some((i) => i.rule.startsWith('phrase:'))).toBe(false)
  })

  it('moves a ready application back when its letter is edited to fail', async () => {
    const env = await services()
    mocks.draft.impl = draftWith(GOOD_LETTER)
    const app = await env.api.prepareApplication(env.addJob())
    expect(app.status).toBe('ready')
    const edited = await env.api.updateApplication(app.id, { coverLetter: OPENER_LETTER })
    expect(edited.status).toBe('needs_attention')
    expect(edited.error).toContain('I am writing to express my interest')
  })

  it('does not let Retry later release it', async () => {
    const { env, id } = await held()
    expect(await env.api.retryLater([id])).toEqual({ updated: 0, skipped: 1 })
    expect(env.ctx.applications.get(id)?.status).toBe('needs_attention')
  })
})

describe('regenerating the cover letter', () => {
  const written = (text: string): WrittenText => ({ text, lint: lintOf(text), needsInput: null, revisions: 2, costUsd: 0 })

  it('moves the status: a passing letter frees the application and a failing one holds it', async () => {
    const env = await services()
    mocks.draft.impl = draftWith(OPENER_LETTER)
    const app = await env.api.prepareApplication(env.addJob())
    expect(app.status).toBe('needs_attention')

    mocks.letter.impl = async () => written(GOOD_LETTER)
    const freed = await env.api.regenerateCoverLetter(app.id, null)
    expect(freed).toMatchObject({ status: 'ready', error: null, coverLetter: GOOD_LETTER })

    mocks.letter.impl = async () => written(OPENER_LETTER)
    const heldAgain = await env.api.regenerateCoverLetter(app.id, null)
    expect(heldAgain.status).toBe('needs_attention')
    expect(heldAgain.error).toContain('held back by the style check')
  })

  it('updates a letter pasted into a text box with its confidence and check', async () => {
    const env = await services()
    const box = field('cover_letter', 'Cover letter', 'textarea', true)
    mocks.draft.impl = draftWith(GOOD_LETTER, [NAME_FIELD, box])
    const app = await env.api.prepareApplication(env.addJob())
    mocks.letter.impl = async () => written(OPENER_LETTER)
    const next = await env.api.regenerateCoverLetter(app.id, null)
    const pasted = next.answers.find((a) => a.fieldKey === 'cover_letter')!
    expect(pasted).toMatchObject({ value: OPENER_LETTER, confidence: 0.6 })
    expect(pasted.lint).not.toBeNull()
    expect(next.status).toBe('needs_attention')
  })

  it('asks for a letter that fits the smallest text box and puts it in', async () => {
    const env = await services()
    const small = { ...field('cover_letter', 'Cover letter', 'textarea', true), maxLength: 600 }
    const other = { ...field('cover_note', 'Cover letter (optional)', 'text', false), maxLength: 900 }
    mocks.draft.impl = draftWith(GOOD_LETTER, [NAME_FIELD, small, other])
    const app = await env.api.prepareApplication(env.addJob())
    mocks.letter.impl = async () => written(GOOD_LETTER)
    const next = await env.api.regenerateCoverLetter(app.id, null)
    expect(mocks.letterOptions.last).toMatchObject({ maxChars: 600, regenerate: true })
    expect(next.answers.find((a) => a.fieldKey === 'cover_letter')!.value).toBe(GOOD_LETTER)
  })

  it('flags a box the new letter does not fit instead of saving it there', async () => {
    const env = await services()
    const small = { ...field('cover_letter', 'Cover letter', 'textarea', true), maxLength: 100 }
    const other = { ...field('cover_note', 'Cover letter (optional)', 'text', false), maxLength: 5000 }
    mocks.draft.impl = draftWith(GOOD_LETTER, [NAME_FIELD, small, other])
    const app = await env.api.prepareApplication(env.addJob())
    mocks.letter.impl = async () => ({ ...written(GOOD_LETTER), overLimit: true })
    const next = await env.api.regenerateCoverLetter(app.id, null)
    const flagged = next.answers.find((a) => a.fieldKey === 'cover_letter')!
    expect(flagged).toMatchObject({ value: '', needsUser: true })
    expect(flagged.note).toContain('this box takes 100')
    expect(next.answers.find((a) => a.fieldKey === 'cover_note')!.value).toBe(GOOD_LETTER)
    expect(next.status).toBe('needs_attention')
  })
})

describe('changing the resume', () => {
  it('moves the status of an unsent application like any other edit', async () => {
    const env = await services()
    const fields = [NAME_FIELD, RESUME_FILE]
    mocks.draft.impl = async () => ({
      fields,
      formSource: 'api',
      formError: null,
      resolved: null,
      answers: [answer(NAME_FIELD), answer(RESUME_FILE, { value: '', source: 'file', confidence: 0, needsUser: true, note: 'Upload a resume in Profile first.' })],
      coverLetter: null,
      coverLetterLint: null,
      coverLetterNeedsInput: null,
      costUsd: 0
    })
    const app = await env.api.prepareApplication(env.addJob())
    expect(app.status).toBe('needs_attention')

    const doc = env.ctx.documents.insert({ kind: 'resume', name: 'Sam Rivera - Resume.pdf', filePath: path.join(os.tmpdir(), 'sam-resume.pdf'), mime: 'application/pdf', text: 'Sam' })
    await env.api.setPrimaryResume(doc.id)
    const after = env.ctx.applications.get(app.id)!
    expect(after.answers.find((a) => a.fieldKey === 'resume')).toMatchObject({ value: path.join(os.tmpdir(), 'sam-resume.pdf'), needsUser: false })
    expect(after.status).toBe('ready')

    await env.api.deleteDocument(doc.id)
    expect(env.ctx.applications.get(app.id)!.status).toBe('needs_attention')
  })
})
