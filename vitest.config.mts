import fs from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Tests make temporary folders (data folders, documents, browser profiles) and most don't remove
// them. They all go into one folder per run instead, and vitest.globalSetup.mts deletes it when the
// run ends. The folder is made here because the workers need it before any test starts.
const runTmp = process.env.JOBQUERY_TEST_TMP ?? fs.mkdtempSync(join(os.tmpdir(), 'jobquery-vitest-'))
process.env.JOBQUERY_TEST_TMP = runTmp

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: { TEMP: runTmp, TMP: runTmp, TMPDIR: runTmp },
    globalSetup: ['./vitest.globalSetup.mts']
  }
})
