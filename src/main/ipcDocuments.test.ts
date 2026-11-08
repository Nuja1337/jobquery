import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FitAssessment, FormField, PreparedAnswer } from '@shared/types'

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null }, dialog: {}, shell: {} }))

const mocks = vi.hoisted(() => ({
  draft: { impl: null as (() => Promise<unknown>) | null },
  draftCalls: { count: 0 }
}))

vi.mock('./apply/prepare', async (importOriginal) => {
  const original = await importOriginal<typeof import('./apply/prepare')>()
  return {
    ...original,
    draftApplication: () => {
      mocks.draftCalls.count += 1
      return mocks.draft.impl!()
    }
  }
})
// Reading a real PDF is not what these tests are about.
vi.mock('./profile/ingest', async (importOriginal) => {
  const original = await importOriginal<typeof import('./profile/ingest')>()
  return { ...original, extractTextFromFile: async () => ({ text: 'Sam Rivera. Software engineer with ten years of experience.', mime: 'application/pdf' }) }
})

import { createServices } from './ipc'
import { appPaths } from './paths'
import { testVault } from './secrets'
import { makeRaw } from './testing'

const FIT: FitAssessment = { score: 95, bucket: 'perfect', summary: '', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match', keywords: [] }
const RESUME_FILE: FormField = { key: 'resume', label: 'Resume', type: 'file', required: true, options: [], placeholder: null, maxLength: null, fileHint: 'resume' }
const resumeAnswer = (value: string): PreparedAnswer => ({
  fieldKey: 'resume', label: 'Resume', type: 'file', required: true, options: [], value, source: 'file', confidence: 1, needsUser: false, note: null, lint: null
})

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
  mocks.draft.impl = null
  mocks.draftCalls.count = 0
})

async function services() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-docs-'))
  const paths = appPaths(dir)
  const s = await createServices({ paths, vault: testVault, emit: () => {}, appVersion: '0.0.0' })
  open.push(async () => {
    await s.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const source = (name: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'x')
    return file
  }
  const addJob = (company = 'Acme') => {
    const { job } = s.ctx.jobs.upsertRaw(makeRaw({ externalId: `x-${company}`, company }), null)
    s.ctx.jobs.saveFit(job.id, FIT, 1, 'shortlisted')
    return job.id
  }
  const draft = (resume: string | null) => async () => ({
    fields: [RESUME_FILE],
    formSource: 'api',
    formError: null,
    resolved: null,
    answers: [resumeAnswer(resume ?? '')],
    coverLetter: null,
    coverLetterLint: null,
    coverLetterNeedsInput: null,
    costUsd: 0
  })
  return { ...s, paths, source, addJob, draft }
}

describe('resume files', () => {
  it('refuses text, Markdown and images with a clear message, and keeps nothing', async () => {
    const env = await services()
    for (const name of ['resume.txt', 'resume.md', 'resume.png', 'resume']) {
      await expect(env.api.importDocument({ kind: 'resume', filePath: env.source(name) })).rejects.toThrow(/PDF or Word \(\.docx\)/)
    }
    await expect(env.api.importDocument({ kind: 'resume', text: 'Pasted resume text that is long enough.' })).rejects.toThrow(/PDF or Word/)
    expect(await env.api.listDocuments('resume')).toEqual([])
    expect(fs.existsSync(env.paths.documentsDir) ? fs.readdirSync(env.paths.documentsDir) : []).toEqual([])
  })

  it('still takes text files for writing samples', async () => {
    const env = await services()
    const doc = await env.api.importDocument({ kind: 'writing_sample', filePath: env.source('post.txt') })
    expect(doc.kind).toBe('writing_sample')
  })

  it('makes the first resume primary and leaves a later one secondary', async () => {
    const env = await services()
    const first = await env.api.importDocument({ kind: 'resume', filePath: env.source('a.pdf') })
    const second = await env.api.importDocument({ kind: 'resume', filePath: env.source('b.docx') })
    expect(first.isPrimary).toBe(true)
    expect(second.isPrimary).toBe(false)
  })
})

describe('the resume recorded on an application', () => {
  it('is the primary resume when the application is prepared', async () => {
    const env = await services()
    const resume = await env.api.importDocument({ kind: 'resume', filePath: env.source('a.pdf') })
    mocks.draft.impl = env.draft(resume.filePath)
    const app = await env.api.prepareApplication(env.addJob())
    expect(app.resumeDocId).toBe(resume.id)
  })

  it('follows a change of primary resume while the application is unsent', async () => {
    const env = await services()
    const a = await env.api.importDocument({ kind: 'resume', filePath: env.source('a.pdf') })
    const b = await env.api.importDocument({ kind: 'resume', filePath: env.source('b.pdf') })
    mocks.draft.impl = env.draft(a.filePath)
    const app = await env.api.prepareApplication(env.addJob())
    await env.api.setPrimaryResume(b.id)
    const after = env.ctx.applications.get(app.id)!
    expect(after.resumeDocId).toBe(b.id)
    expect(after.answers[0].value).toBe(b.filePath)
  })
})

describe('deleting a resume', () => {
  it('removes the file when no application used it', async () => {
    const env = await services()
    const a = await env.api.importDocument({ kind: 'resume', filePath: env.source('a.pdf') })
    await env.api.deleteDocument(a.id)
    expect(fs.existsSync(a.filePath!)).toBe(false)
    expect(await env.api.listDocuments('resume')).toEqual([])
  })

  it('keeps the file when a sent application used it, and drops it from the list', async () => {
    const env = await services()
    const a = await env.api.importDocument({ kind: 'resume', filePath: env.source('a.pdf') })
    const b = await env.api.importDocument({ kind: 'resume', filePath: env.source('b.pdf') })
    mocks.draft.impl = env.draft(a.filePath)
    const app = await env.api.prepareApplication(env.addJob())
    env.ctx.applications.update(app.id, { status: 'submitted' })
    await env.api.deleteDocument(a.id)
    expect(fs.existsSync(a.filePath!)).toBe(true)
    expect(env.ctx.applications.get(app.id)?.resumeDocId).toBe(a.id)
    expect((await env.api.listDocuments('resume')).map((d) => d.id)).toEqual([b.id])
  })

  it('removes the file when only unsent applications used it, and moves them to the new primary', async () => {
    const env = await services()
    const a = await env.api.importDocument({ kind: 'resume', filePath: env.source('a.pdf') })
    const b = await env.api.importDocument({ kind: 'resume', filePath: env.source('b.pdf') })
    mocks.draft.impl = env.draft(a.filePath)
    const app = await env.api.prepareApplication(env.addJob())
    await env.api.deleteDocument(a.id)
    expect(fs.existsSync(a.filePath!)).toBe(false)
    expect(env.ctx.applications.get(app.id)?.resumeDocId).toBe(b.id)
  })
})

describe('portfolio links', () => {
  it('fill an empty portfolio field in the profile, and only that', async () => {
    const env = await services()
    await env.api.importDocument({ kind: 'portfolio', url: 'https://sam.dev', name: 'Portfolio' })
    expect(env.ctx.profile.get().profile.links.portfolio).toBe('https://sam.dev')
    await env.api.importDocument({ kind: 'portfolio', url: 'https://other.dev', name: 'More' })
    expect(env.ctx.profile.get().profile.links.portfolio).toBe('https://sam.dev')
  })

  it('leave a portfolio the person already entered', async () => {
    const env = await services()
    const profile = env.ctx.profile.get().profile
    env.ctx.profile.save({ ...profile, links: { ...profile.links, portfolio: 'https://mine.dev' } })
    await env.api.importDocument({ kind: 'portfolio', url: 'https://sam.dev', name: 'Portfolio' })
    expect(env.ctx.profile.get().profile.links.portfolio).toBe('https://mine.dev')
  })
})

describe('preparing one job twice at once', () => {
  it('writes one draft and one application, and both calls get it', async () => {
    const env = await services()
    mocks.draft.impl = async () => {
      await new Promise((r) => setTimeout(r, 30))
      return env.draft(null)()
    }
    const jobId = env.addJob()
    const [one, two] = await Promise.all([env.api.prepareApplication(jobId), env.api.prepareApplication(jobId)])
    expect(mocks.draftCalls.count).toBe(1)
    expect(two.id).toBe(one.id)
    expect(env.ctx.applications.list({ limit: 50, offset: 0 }).total).toBe(1)
  })

  it('allows a later prepare once the first has finished, also after a failure', async () => {
    const env = await services()
    const jobId = env.addJob()
    mocks.draft.impl = async () => {
      throw new Error('boom')
    }
    await expect(env.api.prepareApplication(jobId)).rejects.toThrow('boom')
    mocks.draft.impl = env.draft(null)
    const app = await env.api.prepareApplication(jobId)
    expect(app.jobId).toBe(jobId)
    expect(mocks.draftCalls.count).toBe(2)
  })
})
