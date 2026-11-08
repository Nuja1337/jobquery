import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { BrowserManager } from './browser'
import { clean, coverLetterFileName, renderCoverLetterPdf } from './coverLetterPdf'

describe('renderCoverLetterPdf', () => {
  it('gives each application its own file, even for the same company', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpls-letters-'))
    const written: string[] = []
    const browser = {
      headlessPage: async () => ({
        setContent: async () => {},
        pdf: async ({ path: file }: { path: string }) => void written.push(file),
        close: async () => {}
      })
    } as unknown as BrowserManager
    const profile = { ...EMPTY_PROFILE, fullName: 'Sam Rivera' }
    const args = { text: 'Hello.', profile, company: 'Acme', outDir }
    const one = await renderCoverLetterPdf(browser, DEFAULT_SETTINGS.browser, { ...args, applicationId: 'app-one' })
    const two = await renderCoverLetterPdf(browser, DEFAULT_SETTINGS.browser, { ...args, applicationId: 'app-two' })
    expect(one).not.toBe(two)
    expect(written).toEqual([one, two])
    // The employer sees the file name, so it stays free of ids.
    expect(path.basename(one)).toBe('Sam Rivera - Cover Letter - Acme.pdf')
    expect(path.basename(one)).toBe(path.basename(two))
    expect(path.dirname(one)).toBe(path.join(outDir, 'app-one'))
    fs.rmSync(outDir, { recursive: true, force: true })
  })
})

describe('clean', () => {
  it('keeps letters of any language and drops what a file name cannot hold', () => {
    expect(clean('José Müller')).toBe('José Müller')
    expect(clean('Zoë <O\'Neil>: A/B?')).toBe("Zoë O'Neil A B")
    expect(clean('山田 太郎')).toBe('山田 太郎')
    expect(clean(' ..Acme, Inc.. ')).toBe('Acme, Inc')
  })

  it('names the letter from the cleaned parts', () => {
    const profile = { ...EMPTY_PROFILE, fullName: 'José Müller' }
    expect(coverLetterFileName(profile, 'Acme/Games: EU')).toBe('José Müller - Cover Letter - Acme Games EU.pdf')
    expect(coverLetterFileName({ ...profile, fullName: '' }, '')).toBe('Cover Letter - Cover Letter - Company.pdf')
  })
})
