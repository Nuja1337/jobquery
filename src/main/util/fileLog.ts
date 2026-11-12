import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

export interface FileLog {
  /** Appends one line. Never throws. */
  write(level: LogLevel, message: string): void
  /** The file being written now. */
  readonly file: string
}

export interface FileLogOptions {
  /** Size at which the file is rotated. */
  maxBytes?: number
  /** How many files to keep, the current one included. */
  files?: number
  /** Longest message kept, in characters. */
  maxMessage?: number
  now?: () => Date
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_FILES = 4
const DEFAULT_MAX_MESSAGE = 600

/**
 * Takes secrets out of text before it is written to the log: keys, bearer tokens, cookie headers,
 * values after names such as password or token, and any long unbroken token.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:set-)?cookie\s*:[^\n]*/gi, 'cookie: [removed]')
    .replace(/\bauthorization\s*:\s*[^\n]*/gi, 'authorization: [removed]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [removed]')
    .replace(/\b(api[_-]?key|app[_-]?key|app[_-]?id|secret|token|password|passwd)(["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi, '$1$2[removed]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[removed]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[removed]')
    .replace(/\b[A-Za-z0-9_+/-]{40,}\b/g, '[removed]')
}

/** One line of text with secrets removed and a length limit. */
export function cleanLine(text: string, maxLength = DEFAULT_MAX_MESSAGE): string {
  const line = redact(text.replace(/\s+/g, ' ').trim())
  return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line
}

/**
 * A log file in `dir` that rotates by size: jobquery.log, then jobquery.1.log and so on, oldest dropped.
 * It holds ids, counts and error messages the app already shows in its activity log. Callers must
 * not pass prompts, documents, cookies or keys. Redaction is a second guard, not the first.
 */
export function createFileLog(dir: string, options: FileLogOptions = {}): FileLog {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const files = Math.max(1, options.files ?? DEFAULT_FILES)
  const maxMessage = options.maxMessage ?? DEFAULT_MAX_MESSAGE
  const now = options.now ?? (() => new Date())
  const file = path.join(dir, 'jobquery.log')
  const older = (n: number): string => path.join(dir, `jobquery.${n}.log`)
  let size: number | null = null
  let broken = false

  function rotate(): void {
    // jobquery.(files-2).log is the oldest kept file, so the one after it goes.
    fs.rmSync(older(files - 1), { force: true })
    for (let n = files - 2; n >= 1; n--) {
      if (fs.existsSync(older(n))) fs.renameSync(older(n), older(n + 1))
    }
    if (files > 1) fs.renameSync(file, older(1))
    else fs.rmSync(file, { force: true })
    size = 0
  }

  return {
    file,
    write(level, message) {
      if (broken) return
      try {
        const line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${cleanLine(message, maxMessage)}\n`
        const bytes = Buffer.byteLength(line)
        if (size === null) {
          fs.mkdirSync(dir, { recursive: true })
          size = fs.existsSync(file) ? fs.statSync(file).size : 0
        }
        if (size > 0 && size + bytes > maxBytes) rotate()
        fs.appendFileSync(file, line)
        size += bytes
      } catch {
        // A full disk or a locked file must not break the app. Try again on the next line.
        size = null
      }
    }
  }
}
