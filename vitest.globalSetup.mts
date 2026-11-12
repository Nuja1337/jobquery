import fs from 'node:fs'

// Deletes the run's temporary folder that vitest.config.mts made, once every test has finished.
export default function setup(): () => void {
  const dir = process.env.JOBQUERY_TEST_TMP
  // Watch mode can start a new run after an earlier one removed the folder.
  if (dir) fs.mkdirSync(dir, { recursive: true })
  return () => {
    if (!dir) return
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (err) {
      console.warn(`Could not remove the test folder ${dir}.`, err)
    }
  }
}
