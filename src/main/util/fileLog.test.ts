import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanLine, createFileLog, redact } from './fileLog'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquery-log-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('file log', () => {
  it('writes one line for each message and makes the folder', () => {
    const dir = path.join(tempDir(), 'logs')
    const log = createFileLog(dir, { now: () => new Date('2026-11-08T10:00:00.000Z') })
    log.write('info', 'submitted job=abc')
    log.write('error', 'Could not\nsubmit.')
    const lines = fs.readFileSync(path.join(dir, 'jobquery.log'), 'utf8').trimEnd().split('\n')
    expect(lines).toEqual(['2026-11-08T10:00:00.000Z INFO  submitted job=abc', '2026-11-08T10:00:00.000Z ERROR Could not submit.'])
  })

  it('rotates by size and keeps the set number of files', () => {
    const dir = tempDir()
    const log = createFileLog(dir, { maxBytes: 200, files: 3 })
    for (let i = 0; i < 40; i++) log.write('info', `line number ${i} with some padding text`)
    const names = fs.readdirSync(dir).sort()
    expect(names).toEqual(['jobquery.1.log', 'jobquery.2.log', 'jobquery.log'])
    for (const name of names) expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(200)
    // The newest line is in the current file, and the oldest kept file holds older lines.
    expect(fs.readFileSync(path.join(dir, 'jobquery.log'), 'utf8')).toContain('line number 39')
    expect(fs.readFileSync(path.join(dir, 'jobquery.2.log'), 'utf8')).not.toContain('line number 39')
  })

  it('continues the size of an existing file after a restart', () => {
    const dir = tempDir()
    createFileLog(dir, { maxBytes: 150, files: 2 }).write('info', 'first run '.repeat(8))
    const log = createFileLog(dir, { maxBytes: 150, files: 2 })
    log.write('info', 'second run '.repeat(8))
    expect(fs.readdirSync(dir).sort()).toEqual(['jobquery.1.log', 'jobquery.log'])
  })

  it('does not throw when the folder cannot be written', () => {
    const blocker = path.join(tempDir(), 'file')
    fs.writeFileSync(blocker, 'x')
    const log = createFileLog(path.join(blocker, 'logs'))
    expect(() => log.write('error', 'No place to write.')).not.toThrow()
  })
})

describe('log redaction', () => {
  it('removes keys, tokens, cookies and credentials', () => {
    const samples = [
      'Request failed with sk-ant-api03-abcdefghijklmnop1234',
      'Authorization: Bearer abc.def.ghi',
      'bearer eyJhbGciOi.payload.sig',
      'Cookie: session=abc123; other=1',
      'url?app_key=SECRETVALUE&page=2',
      'apiKey: "SECRETVALUE"',
      'token=SECRETVALUE',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv failed',
      `blob ${'a1b2c3d4'.repeat(8)} end`
    ]
    for (const sample of samples) {
      const out = redact(sample)
      expect(out, sample).not.toMatch(/SECRETVALUE|abc123|abcdefghijklmnop|abc\.def|eyJhbGci|AIzaSy|a1b2c3d4a1b2c3d4/)
      expect(out, sample).toContain('[removed]')
    }
  })

  it('keeps ordinary messages, ids and counts', () => {
    const text = 'submitted job=0f8a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b 12 applications left'
    expect(redact(text)).toBe(text)
  })

  it('cuts long text to one line', () => {
    const out = cleanLine('word '.repeat(300), 50)
    expect(out.length).toBeLessThanOrEqual(53)
    expect(out.endsWith('...')).toBe(true)
    expect(out).not.toContain('\n')
  })
})
