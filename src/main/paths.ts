import fs from 'node:fs'
import path from 'node:path'

export interface AppPaths {
  dataDir: string
  dbFile: string
  /** Copies of resumes, samples and other uploaded files. */
  documentsDir: string
  /** Screenshots taken after each submission, as proof. */
  screenshotsDir: string
  /** Browser profile for form filling. Logins to job sites persist here. */
  browserProfileDir: string
  /** Cover letter PDFs and data exports. */
  exportsDir: string
}

export function appPaths(dataDir: string): AppPaths {
  const paths: AppPaths = {
    dataDir,
    dbFile: path.join(dataDir, 'jobpilot.sqlite'),
    documentsDir: path.join(dataDir, 'documents'),
    screenshotsDir: path.join(dataDir, 'screenshots'),
    browserProfileDir: path.join(dataDir, 'browser-profile'),
    exportsDir: path.join(dataDir, 'exports')
  }
  for (const dir of [paths.documentsDir, paths.screenshotsDir, paths.browserProfileDir, paths.exportsDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return paths
}
