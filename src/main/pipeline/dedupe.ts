import { createHash } from 'node:crypto'
import type { RawJob, SourceKind } from '@shared/types'

/** Sources that come from saved searches on job boards. They have no board of their own. */
export const SEARCH_SOURCES: SourceKind[] = ['remotive', 'remoteok', 'arbeitnow', 'hn_whoishiring', 'adzuna']

const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'gmbh', 'corp', 'corporation', 'co', 'company',
  'plc', 'ag', 'sa', 'bv', 'oy', 'ab', 'pty', 'lp', 'llp'
])

/** Lowercase, no punctuation, no legal suffix. "Acme, Inc." and "ACME" give the same key. */
export function normalizeCompany(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop()
  return words.join(' ')
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The same posting from the same source always produces the same key.
 * A posting on an ATS board is keyed by the board token, not the company name, so renaming a
 * watched company or pasting a link to the same posting gives the same key.
 * Aggregator postings keep the company name in the key, even when their link shows which ATS the
 * employer uses. Their ats and token describe the employer's board, not the source.
 */
export function canonicalKey(raw: Pick<RawJob, 'source' | 'company' | 'externalId'> & Partial<Pick<RawJob, 'ats' | 'atsToken'>>): string {
  const token = raw.atsToken?.trim()
  if (raw.ats && raw.ats !== 'unknown' && token && !SEARCH_SOURCES.includes(raw.source)) return `${raw.source}:${token.toLowerCase()}:${raw.externalId}`
  return `${raw.source}:${normalizeCompany(raw.company)}:${raw.externalId}`
}

/** Fingerprint of company, title and the whole description. Identical postings on two boards match. */
export function contentHash(raw: Pick<RawJob, 'company' | 'title' | 'description'>): string {
  return createHash('sha1')
    .update(`${normalizeCompany(raw.company)}\n${normalizeText(raw.title)}\n${normalizeText(raw.description)}`)
    .digest('hex')
}

export function normalizeLocation(location: string | null): string {
  return location ? normalizeText(location) : ''
}
