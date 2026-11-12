// Starts the built app in Electron with a throwaway data folder and drives the real backend
// through the same bridge the UI uses. Needs the network (it adds a live Greenhouse posting).
//
//   npm run build && npm run smoke
//
// To check a packaged build instead, point SMOKE_EXE at it:
//
//   npx electron-builder --win --dir
//   SMOKE_EXE=release/win-unpacked/jobquery.exe npm run smoke
//
// It doesn't call any AI provider, so it needs no API key and costs nothing.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquery-smoke-'))
const shotsDir = path.join(root, 'out', 'smoke')
fs.mkdirSync(shotsDir, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const packagedExe = process.env.SMOKE_EXE ? path.resolve(root, process.env.SMOKE_EXE) : null
const app = await electron.launch({
  executablePath: packagedExe ?? electronPath,
  args: packagedExe ? [] : [root],
  env: { ...process.env, JOBQUERY_DATA_DIR: dataDir }
})

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(shotsDir, '1-first-run.png') })

  const call = (method, ...args) => win.evaluate(([m, a]) => window.bridge.call(m, ...a), [method, args])

  const info = await call('getAppInfo')
  check('app starts and the bridge answers', info.dataDir === dataDir, info.dataDir)

  const settings = await call('getSettings')
  check('fresh install starts in onboarding', settings.onboardingDone === false)

  const provider = await call('saveProvider', { kind: 'anthropic', label: 'Claude', apiKey: 'sk-ant-smoke-test' })
  const providers = await call('listProviders')
  check('API key is stored but never returned', provider.hasKey && !JSON.stringify(providers).includes('sk-ant-smoke-test'))

  const profile = await call('getProfile')
  profile.profile.fullName = 'Smoke Test'
  profile.profile.skills = ['TypeScript', 'React', 'SQL']
  const saved = await call('saveProfile', profile.profile)
  check('profile saves', saved.profile.fullName === 'Smoke Test' && saved.version >= 1)

  const doc = await call('importDocument', { kind: 'writing_sample', name: 'Sample', text: 'I like plain sentences. I write them often.' })
  check('a pasted writing sample imports', doc.kind === 'writing_sample')

  const detected = await call('detectAts', 'https://job-boards.greenhouse.io/anthropic')
  check('detects a Greenhouse board from its URL', detected?.ats === 'greenhouse' && detected?.token === 'anthropic')

  // A live posting from a public board, added by URL. Free rules only, no AI.
  const res = await fetch('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs')
  const board = await res.json()
  const posting = board.jobs[0]
  const job = await call('addJobByUrl', posting.absolute_url)
  check('adds a live job by URL', job.title === posting.title && job.ats === 'greenhouse', job.title)

  const list = await call('listJobs', { limit: 10 })
  check('job list includes it', list.items.some((j) => j.id === job.id))

  await call('dismissJob', job.id, 'smoke test', ['other'])
  const dismissed = await call('getJob', job.id)
  check('dismissing a job sticks', dismissed.stage === 'dismissed')

  const lint = await call('lintText', 'I am thrilled to leverage my passion — truly!')
  check('style check flags AI-sounding text', lint.score < 60, `score ${lint.score}`)

  const usage = await call('getUsage')
  check('usage starts at zero', usage.todayUsd === 0)

  const analytics = await call('getAnalytics', 30)
  check('analytics loads', analytics.daily.length >= 30 && analytics.funnel.discovered >= 1)

  const events = await call('listEvents', { limit: 20 })
  check('events are recorded', events.length > 0)

  await call('updateSettings', { onboardingDone: true })
  await win.reload()
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(shotsDir, '2-dashboard.png') })
  await win.evaluate(() => (window.location.hash = '#/jobs'))
  await win.waitForTimeout(1000)
  await win.screenshot({ path: path.join(shotsDir, '3-jobs.png') })
  check('no errors in the window', errors.length === 0, errors.join(' | '))
} finally {
  await app.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots in ${shotsDir}`)
process.exit(failed ? 1 : 0)
