import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FitAssessment, FormField, PreparedAnswer } from '@shared/types'
import { fileURLToPath } from 'node:url'
import { COVER_LETTER_PDF, HELD_UPLOAD_NOTE } from './apply/answers'
import type { WrittenText } from './writing/generate'
import { groundingIssues, GROUNDING_RULES, lintText } from './writing/lint'
import scopely from './writing/__fixtures__/scopely-client-engineer.posting.json'

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null }, dialog: {}, shell: {} }))

const mocks = vi.hoisted(() => ({
  draft: { impl: null as (() => Promise<unknown>) | null },
  letter: { impl: null as (() => Promise<unknown>) | null }
}))

vi.mock('./apply/prepare', async (importOriginal) => {
  const original = await importOriginal<typeof import('./apply/prepare')>()
  return { ...original, draftApplication: () => mocks.draft.impl!() }
})
vi.mock('./writing/generate', async (importOriginal) => {
  const original = await importOriginal<typeof import('./writing/generate')>()
  return { ...original, writeCoverLetter: () => mocks.letter.impl!() }
})

import { createServices } from './ipc'
import { appPaths } from './paths'
import { testVault } from './secrets'
import { makeRaw } from './testing'

// An edited letter keeps the banned terms its posting uses in a plain sense. A regenerated letter that is less grounded
// goes into a text box below the auto-send confidence.

const FIT: FitAssessment = { score: 95, bucket: 'perfect', summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }
const LETTER =
  'Hi Mossbrook team,\n\nLast year I built a test harness for the combat code of a mobile shooter. It replayed recorded matches overnight and listed every desync in the morning. The first week it found nine bugs that testers had missed.\n\nThanks,\nMara'
const WITH_TERM = 'You will build the test harness for our combat code and own unlock progression. Experience with C++ and Unreal helps.'
const WITHOUT_TERM = 'You will build tooling for our combat code and own the reward economy. Experience with C++ and Unreal helps.'

const field = (key: string, label: string, type: FormField['type'], required: boolean, fileHint: FormField['fileHint'] = null): FormField => ({ key, label, type, required, options: [], placeholder: null, maxLength: null, fileHint })
const LETTER_FILE = field('cover_letter_file', 'Cover letter', 'file', true, 'cover_letter')
const answer = (f: FormField): PreparedAnswer => ({
  fieldKey: f.key,
  label: f.label,
  type: f.type,
  required: f.required,
  options: [],
  value: f.type === 'file' ? COVER_LETTER_PDF : 'x',
  source: f.type === 'file' ? 'file' : 'profile',
  confidence: 1,
  needsUser: false,
  note: null,
  lint: null
})

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
  mocks.draft.impl = null
  mocks.letter.impl = null
})

async function services() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-grounding-'))
  const s = await createServices({ paths: appPaths(dir), vault: testVault, emit: () => {}, appVersion: '0.0.0' })
  open.push(async () => {
    await s.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const addJob = (description: string) => {
    const { job } = s.ctx.jobs.upsertRaw(makeRaw({ externalId: `x-${Math.random()}`, company: 'Mossbrook Games', description }), null)
    s.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    return job.id
  }
  return { ...s, addJob }
}

function draftWith(fields: FormField[]) {
  return async () => ({
    fields,
    formSource: 'api',
    formError: null,
    resolved: null,
    answers: fields.map(answer),
    coverLetter: 'Hi Mossbrook team,\n\nA short letter.\n\nThanks,\nMara',
    coverLetterLint: lintText('A short letter.'),
    coverLetterNeedsInput: null,
    costUsd: 0
  })
}

describe('editing a letter', () => {
  const harness = async (description: string) => {
    const env = await services()
    mocks.draft.impl = draftWith([LETTER_FILE])
    const app = await env.api.prepareApplication(env.addJob(description))
    const edited = await env.api.updateApplication(app.id, { coverLetter: LETTER })
    return edited.coverLetterLint!.issues.map((i) => i.rule).filter((r) => r === 'phrase:harness')
  }

  it('does not flag "test harness" when the job posting uses it', async () => {
    expect(await harness(WITH_TERM)).toEqual([])
  })

  it('flags it when the job posting does not', async () => {
    expect(new Set(await harness(WITHOUT_TERM))).toEqual(new Set(['phrase:harness']))
  })
})

// A letter that is less grounded is held like one the style check rejects. These use a real posting, so the checks run.
describe('a letter that names nothing from the posting', () => {
  const GENERIC = fs.readFileSync(fileURLToPath(new URL('./writing/__fixtures__/letters/scopely-client-engineer.generic.txt', import.meta.url)), 'utf8').trim()
  const GROUNDED = fs
    .readFileSync(fileURLToPath(new URL('./writing/__fixtures__/letters/scopely-client-engineer.grounded.txt', import.meta.url)), 'utf8')
    .trim()
    .replace('about 300 phones', 'many phones')
  const OPTIONAL_FILE = field('cover_letter_file', 'Cover letter', 'file', false, 'cover_letter')
  const NAME_FIELD = field('name', 'Full name', 'text', true)

  async function withPosting() {
    const env = await services()
    const { job } = env.ctx.jobs.upsertRaw(makeRaw({ externalId: 'scopely', company: 'Scopely', title: scopely.title, description: scopely.text }), null)
    env.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    return { env, jobId: job.id }
  }

  it('is dropped from an optional upload, and attached again once an edit grounds it', async () => {
    const { env, jobId } = await withPosting()
    mocks.draft.impl = draftWith([NAME_FIELD, OPTIONAL_FILE])
    const app = await env.api.prepareApplication(jobId)
    expect(app.status).toBe('ready')

    const generic = await env.api.updateApplication(app.id, { coverLetter: GENERIC })
    expect(generic.answers.find((a) => a.fieldKey === 'cover_letter_file')).toMatchObject({ value: '', note: HELD_UPLOAD_NOTE })
    expect(groundingIssues(generic.coverLetterLint!).map((i) => i.rule)).toEqual([GROUNDING_RULES.noDetail])
    // An optional upload does not hold the application.
    expect(generic.status).toBe('ready')

    const fixed = await env.api.updateApplication(app.id, { coverLetter: GROUNDED })
    expect(fixed.coverLetterLint!.issues.filter((i) => i.rule.startsWith('grounding:'))).toEqual([])
    expect(fixed.answers.find((a) => a.fieldKey === 'cover_letter_file')).toMatchObject({ value: COVER_LETTER_PDF })
  })

  it('holds the application with a required upload, and an edit that grounds it releases it', async () => {
    const { env, jobId } = await withPosting()
    mocks.draft.impl = draftWith([NAME_FIELD, LETTER_FILE])
    const app = await env.api.prepareApplication(jobId)
    expect(app.status).toBe('ready')

    const held = await env.api.updateApplication(app.id, { coverLetter: GENERIC })
    expect(held.status).toBe('needs_attention')
    expect(held.error).toContain('held back by the style check')
    expect(held.error).toContain('It names no detail from the posting')
    expect(held.answers.find((a) => a.fieldKey === 'cover_letter_file')?.value).toBe(COVER_LETTER_PDF)

    // Still generic after a small edit, still held.
    const still = await env.api.updateApplication(app.id, { coverLetter: `${GENERIC}\n\nP.S. Thank you.` })
    expect(still.status).toBe('needs_attention')

    const freed = await env.api.updateApplication(app.id, { coverLetter: GROUNDED })
    expect(freed.status).toBe('ready')
    expect(freed.error).toBeNull()
  })

  it('holds a regenerated letter in a text box and frees it when a grounded one is written', async () => {
    const box = field('cover_letter', 'Cover letter', 'textarea', true)
    const { env, jobId } = await withPosting()
    mocks.draft.impl = draftWith([NAME_FIELD, box])
    const app = await env.api.prepareApplication(jobId)
    const written = (text: string): WrittenText => ({ text, lint: lintText(text), needsInput: null, revisions: 2, costUsd: 0 })
    const weak = written(GENERIC)
    weak.lint.issues.push({ rule: GROUNDING_RULES.noDetail, severity: 'medium', message: 'It names no detail from the posting, such as a product, a tool, a team or a responsibility.', match: null, index: null, suggestion: null })

    mocks.letter.impl = async () => weak
    const held = await env.api.regenerateCoverLetter(app.id, null)
    const pasted = held.answers.find((a) => a.fieldKey === 'cover_letter')!
    expect(pasted).toMatchObject({ value: GENERIC, confidence: 0.6 })
    expect(pasted.note).toMatch(/^The cover letter was held back by the style check\. It names no detail/)
    expect(held.status).toBe('needs_attention')

    mocks.letter.impl = async () => written(GROUNDED)
    const freed = await env.api.regenerateCoverLetter(app.id, null)
    expect(freed.answers.find((a) => a.fieldKey === 'cover_letter')).toMatchObject({ confidence: 0.9, note: null })
    expect(freed.status).toBe('ready')
  })
})
