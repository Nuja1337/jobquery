import fs from 'node:fs'
import path from 'node:path'

/** The app was called jobpls before. Its data folder and database file carry that name. */
const OLD_FOLDER_NAME = 'jobpls'
const OLD_DB = 'jobpls.sqlite'
const NEW_DB = 'jobquery.sqlite'
const DB_SUFFIXES = ['-wal', '-shm', '']

type MoveFs = Pick<typeof fs, 'existsSync' | 'renameSync'>

export interface MoveOptions {
  fs?: MoveFs
  env?: Record<string, string | undefined>
  now?: () => Date
  log?: (message: string) => void
}

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/**
 * Moves the data folder of the app's old name to the new one, once, as a whole folder. Only a whole-folder
 * move keeps Chromium's `Local State` next to the browser profile, and that file holds the key that
 * decrypts the saved API keys. Nothing is ever deleted. An error is logged and the app starts anyway.
 *
 * This must run before `app.requestSingleInstanceLock()`, which creates the new folder.
 * A folder set through JOBQUERY_DATA_DIR is left alone.
 */
export function moveOldDataFolder(newDir: string, options: MoveOptions = {}): void {
  const fsx = options.fs ?? fs
  const env = options.env ?? process.env
  const log = options.log ?? ((message: string) => console.log(message))
  const now = options.now ?? (() => new Date())
  if (env.JOBQUERY_DATA_DIR) return
  try {
    const oldDir = path.join(path.dirname(newDir), OLD_FOLDER_NAME)
    // Windows compares folder names without regard to case, so this is also the guard against moving a folder onto itself.
    const sameFolder = path.resolve(oldDir).toLowerCase() === path.resolve(newDir).toLowerCase()
    if (!sameFolder && fsx.existsSync(oldDir)) {
      if (!fsx.existsSync(newDir)) {
        fsx.renameSync(oldDir, newDir)
        log(`Moved the data folder ${oldDir} to ${newDir}.`)
      } else if (fsx.existsSync(path.join(newDir, NEW_DB))) {
        if (fsx.existsSync(path.join(oldDir, OLD_DB))) {
          log(`Both ${oldDir} and ${newDir} hold a database. Nothing was moved. Keep the folder you want and rename the other.`)
        }
      } else if (fsx.existsSync(path.join(oldDir, OLD_DB))) {
        // Electron made an empty folder on an earlier launch. It is set aside, not deleted.
        const aside = `${newDir}-empty-${stamp(now())}`
        fsx.renameSync(newDir, aside)
        try {
          fsx.renameSync(oldDir, newDir)
        } catch (err) {
          fsx.renameSync(aside, newDir)
          throw err
        }
        log(`Moved the data folder ${oldDir} to ${newDir}. The empty folder that was there is now ${aside}.`)
      }
    }
    renameDatabaseFiles(fsx, newDir, log)
  } catch (err) {
    console.error('Could not move the old data folder.', err)
  }
}

/** The database files carry the app's name. This also finishes a move that stopped halfway. */
function renameDatabaseFiles(fsx: MoveFs, dir: string, log: (message: string) => void): void {
  if (fsx.existsSync(path.join(dir, NEW_DB))) return
  for (const suffix of DB_SUFFIXES) {
    const from = path.join(dir, `${OLD_DB}${suffix}`)
    const to = path.join(dir, `${NEW_DB}${suffix}`)
    if (fsx.existsSync(from) && !fsx.existsSync(to)) {
      fsx.renameSync(from, to)
      log(`Renamed ${from} to ${to}.`)
    }
  }
}
