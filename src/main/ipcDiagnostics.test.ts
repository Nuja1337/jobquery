import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null }, dialog: {}, shell: {} }))

import { createServices, recordProcessError } from './ipc'
import { appPaths } from './paths'
import { testVault } from './secrets'

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquery-diag-'))
  const paths = appPaths(dir)
  const s = await createServices({ paths, vault: testVault, emit: () => {}, appVersion: '1.2.3' })
  open.push(async () => {
    await s.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { ...s, dir, paths, logFile: path.join(dir, 'logs', 'jobquery.log') }
}

describe('database export', () => {
  it('writes a copy to the exports folder and leaves the live database in place', async () => {
    const env = await start()
    await env.ctx.providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-live-key-1234567890' })
    const written = await env.api.exportDatabase()
    expect(written).not.toBeNull()
    expect(path.dirname(written!)).toBe(env.paths.exportsDir)
    expect(path.extname(written!)).toBe('.sqlite')

    const copy = new DatabaseSync(written!)
    expect(copy.prepare('SELECT label, api_key_enc FROM providers').get()).toMatchObject({ label: 'Claude', api_key_enc: null })
    copy.close()
    expect(await env.ctx.providers.getApiKey(env.ctx.providers.list()[0].id)).toBe('sk-live-key-1234567890')
    expect(env.ctx.db.get('SELECT COUNT(*) AS n FROM providers')).toEqual({ n: 1 })
  })
})

describe('file log', () => {
  it('records the start and the activity events, without event data', async () => {
    const env = await start()
    env.ctx.events.add('error', 'The scoring worker hit a problem. Request failed with sk-ant-api03-abcdefghijklmnop1234', 'job-1', { prompt: 'My full name and address' })
    env.ctx.events.add('submitted', 'Sent Engineer at Acme.', 'job-2')
    const text = fs.readFileSync(env.logFile, 'utf8')
    expect(text).toMatch(/INFO\s+JobQuery 1\.2\.3 started, database version \d+/)
    expect(text).toMatch(/ERROR error job=job-1 The scoring worker hit a problem\. Request failed with \[removed\]/)
    expect(text).toMatch(/INFO\s+submitted job=job-2 Sent Engineer at Acme\./)
    expect(text).not.toContain('sk-ant')
    expect(text).not.toContain('full name and address')
  })

  it('records errors nobody caught, and keeps the API key out', async () => {
    const env = await start()
    const err = new Error('Network failed. Authorization: Bearer abc123def456')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    recordProcessError('A background task failed.', err)
    const text = fs.readFileSync(env.logFile, 'utf8')
    expect(text).toMatch(/ERROR A background task failed\. Network failed\./)
    expect(text).not.toContain('abc123def456')
  })

  it('logs a failed export', async () => {
    const env = await start()
    const block = path.join(env.paths.exportsDir, `jobquery-backup-${new Date().toISOString().slice(0, 10)}.sqlite`)
    // The default file name is a folder, so the copy can't replace it.
    fs.mkdirSync(block)
    await expect(env.api.exportDatabase()).rejects.toThrow()
    expect(fs.readFileSync(env.logFile, 'utf8')).toMatch(/ERROR Database copy failed\./)
  })
})
