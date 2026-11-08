import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { BrowserManager } from './browser'
import { renderCoverLetterPdf } from './coverLetterPdf'

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
