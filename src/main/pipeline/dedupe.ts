import { createHash } from 'node:crypto'
import type { RawJob } from '@shared/types'

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

/** The same posting from the same source always produces the same key. */
export function canonicalKey(raw: Pick<RawJob, 'source' | 'company' | 'externalId'>): string {
  return `${raw.source}:${normalizeCompany(raw.company)}:${raw.externalId}`
}

/** Fingerprint of company, title and the start of the description. Identical postings on two boards match. */
export function contentHash(raw: Pick<RawJob, 'company' | 'title' | 'description'>): string {
  const body = normalizeText(raw.description).slice(0, 600)
  return createHash('sha1')
    .update(`${normalizeCompany(raw.company)}\n${normalizeText(raw.title)}\n${body}`)
    .digest('hex')
}

export function normalizeLocation(location: string | null): string {
  return location ? normalizeText(location) : ''
}
