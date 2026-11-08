import type { AtsKind } from '@shared/types'
import { fetchAshbyBoard } from './ashby'
import { fetchBreezyBoard } from './breezy'
import { detectAts, prettifyToken, READABLE_ATS } from './detect'
import { fetchJson, HttpError } from './http'
import { fetchLeverBoard } from './lever'
import { fetchPersonioBoard } from './personio'
import { fetchRipplingBoard } from './rippling'
import { starterName } from './starterPack'
import { fetchWorkableBoard } from './workable'

// Reads a pasted list of employers and checks that a board exists before it is saved.

export interface ParsedBoard {
  ats: AtsKind
  token: string
  name: string | null
  /** The line as the person wrote it, trimmed. */
  line: string
}

export interface BoardLineError {
  line: string
  error: string
}

export type ParsedLine = ParsedBoard | BoardLineError

/** "greenhouse:stripe". The token can hold letters, digits, dots, dashes and underscores. */
const PAIR = /^([a-z]+):([A-Za-z0-9._-]+)$/i

function oneLine(line: string): ParsedBoard | BoardLineError {
  const pair = PAIR.exec(line)
  if (pair) {
    const ats = pair[1].toLowerCase() as AtsKind
    if (!READABLE_ATS.includes(ats)) {
      return { line, error: `"${pair[1]}" is not a system JobPilot can read. Use one of ${READABLE_ATS.join(', ')}.` }
    }
    const token = pair[2]
    return { ats, token, name: starterName(ats, token) ?? (prettifyToken(token) || null), line }
  }
  if (/\s/.test(line)) return { line, error: 'Put one address or ats:token on each line.' }
  const found = detectAts(line)
  if (!found?.token) return { line, error: 'JobPilot could not tell which application system this address uses.' }
  if (!READABLE_ATS.includes(found.ats)) {
    return { line, error: `This is a ${found.ats} careers page. JobPilot can detect it but cannot read its jobs yet.` }
  }
  return { ats: found.ats, token: found.token, name: starterName(found.ats, found.token) ?? found.companyName, line }
}

/**
 * One entry per line. A line is a careers or posting address, a bare domain path such as
 * "jobs.lever.co/spotify", or "ats:token" such as "greenhouse:stripe". Blank lines and lines that start
 * with # are skipped. A board listed twice (same system and token) appears once.
 */
export function parseBoardList(text: string): ParsedLine[] {
  const out: ParsedLine[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parsed = oneLine(line)
    if ('error' in parsed) {
      out.push(parsed)
      continue
    }
    const key = `${parsed.ats}:${parsed.token.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(parsed)
  }
  return out
}

export type ProbeResult = { ok: true; name: string | null; jobs: number } | { ok: false; error: string }

const SYSTEM_LABELS: Partial<Record<AtsKind, string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  rippling: 'Rippling',
  breezy: 'Breezy',
  personio: 'Personio'
}

/** Marking every posting as known keeps the Rippling and Breezy readers from fetching descriptions. */
const LIST_ONLY = { isKnown: () => true }

async function probeCount(ats: AtsKind, token: string, signal?: AbortSignal): Promise<{ name: string | null; jobs: number }> {
  switch (ats) {
    case 'greenhouse': {
      // The board endpoint reports the company name. The job list without content is light and gives the count.
      const info = await fetchJson<{ name?: string }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`, { signal })
      const list = await fetchJson<{ jobs?: unknown[]; meta?: { total?: number } }>(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
        { timeoutMs: 40_000, signal }
      )
      return { name: info.name?.trim() || null, jobs: list.meta?.total ?? list.jobs?.length ?? 0 }
    }
    case 'lever':
      return { name: null, jobs: (await fetchLeverBoard(token, null, signal)).length }
    case 'ashby':
      return { name: null, jobs: (await fetchAshbyBoard(token, null, signal)).length }
    case 'workable': {
      const jobs = await fetchWorkableBoard(token, null, signal)
      return { name: jobs[0]?.company ?? null, jobs: jobs.length }
    }
    case 'smartrecruiters': {
      // An unknown company id answers 200 with no postings, so zero is reported as not found.
      const json = await fetchJson<{ totalFound?: number }>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=1`,
        { signal }
      )
      if (!json.totalFound) throw new HttpError('SmartRecruiters has no postings for that company id', 404, token)
      return { name: null, jobs: json.totalFound }
    }
    case 'rippling': {
      const { jobs } = await fetchRipplingBoard(token, null, { ...LIST_ONLY, signal })
      return { name: null, jobs: jobs.length }
    }
    case 'breezy': {
      const { jobs } = await fetchBreezyBoard(token, null, { ...LIST_ONLY, signal })
      return { name: jobs[0]?.company ?? null, jobs: jobs.length }
    }
    case 'personio': {
      const jobs = await fetchPersonioBoard(token, null, signal)
      return { name: null, jobs: jobs.length }
    }
    default:
      throw new Error(`JobPilot cannot read ${ats} boards yet.`)
  }
}

/** Makes the light requests that show whether a board exists and how many jobs it lists. */
export async function probeBoard(ats: AtsKind, token: string, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const { name, jobs } = await probeCount(ats, token, signal)
    return { ok: true, name, jobs }
  } catch (err) {
    if (signal?.aborted) throw err
    if (err instanceof HttpError && err.status === 404) {
      return { ok: false, error: `${SYSTEM_LABELS[ats] ?? ats} has no board named "${token}".` }
    }
    return { ok: false, error: (err as Error).message }
  }
}
