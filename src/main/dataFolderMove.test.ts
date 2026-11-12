import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { moveOldDataFolder } from './dataFolderMove'

const roots: string[] = []
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquery-move-'))
  roots.push(root)
  const logs: string[] = []
  return {
    root,
    oldDir: path.join(root, 'jobpls'),
    newDir: path.join(root, 'JobQuery'),
    logs,
    options: { env: {}, now: () => new Date(2026, 10, 12, 9, 5, 7), log: (m: string) => logs.push(m) }
  }
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}
function oldInstall(oldDir: string): void {
  write(path.join(oldDir, 'jobpls.sqlite'), 'db')
  write(path.join(oldDir, 'jobpls.sqlite-wal'), 'wal')
  write(path.join(oldDir, 'jobpls.sqlite-shm'), 'shm')
  write(path.join(oldDir, 'Local State'), 'key')
  write(path.join(oldDir, 'browser-profile', 'Default', 'Cookies'), 'login')
  write(path.join(oldDir, 'documents', 'resume.pdf'), 'pdf')
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('moving the old data folder', () => {
  it('does nothing when JOBQUERY_DATA_DIR is set', () => {
    const s = setup()
    oldInstall(s.oldDir)
    moveOldDataFolder(s.newDir, { ...s.options, env: { JOBQUERY_DATA_DIR: s.newDir } })
    expect(fs.existsSync(s.newDir)).toBe(false)
    expect(read(path.join(s.oldDir, 'jobpls.sqlite'))).toBe('db')
  })

  it('does nothing when there is no old folder', () => {
    const s = setup()
    write(path.join(s.newDir, 'jobquery.sqlite'), 'new')
    moveOldDataFolder(s.newDir, s.options)
    expect(fs.readdirSync(s.root)).toEqual(['JobQuery'])
    expect(s.logs).toEqual([])
  })

  it('moves the whole folder when the new one is missing and renames the database files', () => {
    const s = setup()
    oldInstall(s.oldDir)
    moveOldDataFolder(s.newDir, s.options)
    expect(fs.readdirSync(s.root)).toEqual(['JobQuery'])
    expect(fs.readdirSync(s.newDir).sort()).toEqual(['Local State', 'browser-profile', 'documents', 'jobquery.sqlite', 'jobquery.sqlite-shm', 'jobquery.sqlite-wal'])
    expect(read(path.join(s.newDir, 'jobquery.sqlite'))).toBe('db')
    expect(read(path.join(s.newDir, 'jobquery.sqlite-wal'))).toBe('wal')
    expect(read(path.join(s.newDir, 'jobquery.sqlite-shm'))).toBe('shm')
    expect(read(path.join(s.newDir, 'Local State'))).toBe('key')
    expect(read(path.join(s.newDir, 'browser-profile', 'Default', 'Cookies'))).toBe('login')
  })

  it('sets an empty new folder aside, then moves the old one', () => {
    const s = setup()
    oldInstall(s.oldDir)
    write(path.join(s.newDir, 'Local State'), 'empty key')
    write(path.join(s.newDir, 'SingletonLock'), '')
    moveOldDataFolder(s.newDir, s.options)
    const aside = path.join(s.root, 'JobQuery-empty-20261112-090507')
    expect(fs.readdirSync(s.root).sort()).toEqual(['JobQuery', 'JobQuery-empty-20261112-090507'])
    expect(read(path.join(aside, 'Local State'))).toBe('empty key')
    expect(read(path.join(s.newDir, 'Local State'))).toBe('key')
    expect(read(path.join(s.newDir, 'jobquery.sqlite'))).toBe('db')
    expect(fs.existsSync(path.join(s.newDir, 'jobpls.sqlite'))).toBe(false)
  })

  it('changes nothing when both folders have a database, and logs one line', () => {
    const s = setup()
    oldInstall(s.oldDir)
    write(path.join(s.newDir, 'jobquery.sqlite'), 'new db')
    moveOldDataFolder(s.newDir, s.options)
    expect(read(path.join(s.newDir, 'jobquery.sqlite'))).toBe('new db')
    expect(read(path.join(s.oldDir, 'jobpls.sqlite'))).toBe('db')
    expect(fs.readdirSync(s.root).sort()).toEqual(['JobQuery', 'jobpls'])
    expect(s.logs).toHaveLength(1)
    expect(s.logs[0]).toMatch(/Both .* hold a database\. Nothing was moved/)
  })

  it('leaves an existing target database file alone when renaming', () => {
    const s = setup()
    write(path.join(s.newDir, 'jobpls.sqlite'), 'old')
    write(path.join(s.newDir, 'jobpls.sqlite-wal'), 'old wal')
    write(path.join(s.newDir, 'jobquery.sqlite-wal'), 'kept wal')
    moveOldDataFolder(s.newDir, s.options)
    expect(read(path.join(s.newDir, 'jobquery.sqlite'))).toBe('old')
    expect(read(path.join(s.newDir, 'jobquery.sqlite-wal'))).toBe('kept wal')
    expect(read(path.join(s.newDir, 'jobpls.sqlite-wal'))).toBe('old wal')
  })

  it('finishes the file renames of a move that stopped halfway', () => {
    const s = setup()
    write(path.join(s.newDir, 'jobquery.sqlite-wal'), 'wal')
    write(path.join(s.newDir, 'jobpls.sqlite'), 'db')
    moveOldDataFolder(s.newDir, s.options)
    expect(read(path.join(s.newDir, 'jobquery.sqlite'))).toBe('db')
    expect(read(path.join(s.newDir, 'jobquery.sqlite-wal'))).toBe('wal')
  })

  it('logs an error, deletes nothing and does not throw when a rename fails', () => {
    const s = setup()
    oldInstall(s.oldDir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = {
      existsSync: fs.existsSync,
      renameSync: () => {
        throw new Error('EPERM')
      }
    }
    expect(() => moveOldDataFolder(s.newDir, { ...s.options, fs: failing })).not.toThrow()
    expect(error).toHaveBeenCalledOnce()
    expect(read(path.join(s.oldDir, 'jobpls.sqlite'))).toBe('db')
    expect(fs.existsSync(s.newDir)).toBe(false)
    error.mockRestore()
  })

  it('puts the empty folder back when the old one cannot be moved', () => {
    const s = setup()
    oldInstall(s.oldDir)
    write(path.join(s.newDir, 'Local State'), 'empty key')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const flaky = {
      existsSync: fs.existsSync,
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (from === s.oldDir) throw new Error('EBUSY')
        fs.renameSync(from, to)
      }
    }
    moveOldDataFolder(s.newDir, { ...s.options, fs: flaky })
    expect(read(path.join(s.newDir, 'Local State'))).toBe('empty key')
    expect(fs.readdirSync(s.root).sort()).toEqual(['JobQuery', 'jobpls'])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
