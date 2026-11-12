import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db } from './database'

/** Names of saved-search settings that hold job board credentials. */
const SECRET_PARAM = /key|secret|token|password|app_id/i

function sameFile(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  if (norm(a) === norm(b)) return true
  try {
    const x = fs.statSync(a)
    const y = fs.statSync(b)
    // A hard link or a link through another folder is the same file.
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}

/** True when `target` is the live database or one of the files SQLite keeps next to it. */
export function isLiveDatabaseFile(dbFile: string, target: string): boolean {
  return ['', '-wal', '-shm', '-journal'].some((suffix) => sameFile(`${dbFile}${suffix}`, target))
}

/**
 * Writes a consistent copy of the open database to `target` with VACUUM INTO. The app can keep
 * running meanwhile. The copy is written to a temporary file next to the target, stripped of
 * stored API keys and job board credentials, and then moved into place, so a failure leaves no
 * half file. It refuses the live database file. Returns the path written.
 */
export function exportDatabaseCopy(db: Db, dbFile: string, target: string): string {
  const out = path.resolve(target)
  if (isLiveDatabaseFile(dbFile, out)) throw new Error('That is the file JobQuery is using. Pick a different file name.')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const partial = `${out}.${process.pid}.partial`
  fs.rmSync(partial, { force: true })
  try {
    db.run('VACUUM INTO ?', [partial])
    scrubSecrets(partial)
    fs.renameSync(partial, out)
  } catch (err) {
    fs.rmSync(partial, { force: true })
    throw err
  }
  return out
}

/** Removes the encrypted provider keys and saved-search credentials from a copy, and wipes the freed pages. */
function scrubSecrets(file: string): void {
  const copy = new DatabaseSync(file)
  try {
    copy.exec('PRAGMA secure_delete = ON')
    copy.exec('UPDATE providers SET api_key_enc = NULL')
    const rows = copy.prepare('SELECT id, params FROM searches').all() as Array<{ id: string; params: string | null }>
    const update = copy.prepare('UPDATE searches SET params = ? WHERE id = ?')
    for (const row of rows) {
      let params: unknown
      try {
        params = JSON.parse(row.params ?? '{}')
      } catch {
        // Text that is not JSON can't be checked field by field, so it is dropped.
        update.run('{}', row.id)
        continue
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) continue
      const clean = Object.fromEntries(Object.entries(params as Record<string, unknown>).map(([k, v]) => [k, SECRET_PARAM.test(k) ? '' : v]))
      update.run(JSON.stringify(clean), row.id)
    }
    copy.exec('VACUUM')
  } finally {
    copy.close()
  }
}
