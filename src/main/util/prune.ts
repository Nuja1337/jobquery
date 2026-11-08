import fs from 'node:fs'
import path from 'node:path'

/** Deletes files in a folder that were last changed more than the given number of days ago. Errors are ignored. */
export function pruneOldFiles(dir: string, days: number, now = Date.now()): void {
  try {
    const cutoff = now - days * 86_400_000
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = path.join(dir, entry.name)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
      } catch {
        // A file in use or already gone stays for the next start.
      }
    }
  } catch {
    // No folder yet, or no access. There is nothing to clean.
  }
}
