import fs from 'node:fs'
import path from 'node:path'
import type { BrowserSettings, Profile } from '@shared/types'
import type { BrowserManager } from './browser'

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Text that is safe in an uploaded file name: letters of any language, digits, spaces and a few marks.
 * The employer sees the name, so everything else is dropped.
 */
export function clean(s: string): string {
  return s.replace(/[^\p{L}\p{M}\p{N} .,'&()_-]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '')
}

// "Company" is left out on purpose, since it is part of names such as "The Walt Disney Company".
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'gmbh', 'corp', 'corporation', 'co', 'plc', 'ag', 'sa', 'bv', 'oy', 'ab', 'pty', 'lp', 'llp'
])

/** "Riot Games, Inc." becomes "Riot Games". A name that is only a suffix is kept as it is. */
export function stripLegalSuffix(company: string): string {
  let name = company.trim()
  for (;;) {
    const m = /^(.*\S)[\s,]+([^\s,]+)$/.exec(name)
    if (!m) return name
    const last = m[2].toLowerCase().replace(/\./g, '')
    if (!LEGAL_SUFFIXES.has(last) && last !== '&') return name
    name = m[1].replace(/[\s,]+$/, '')
  }
}

export function coverLetterFileName(profile: Profile, company: string): string {
  const name = clean(profile.fullName) || 'Cover Letter'
  return `${name} - Cover Letter - ${clean(stripLegalSuffix(company)) || 'Company'}.pdf`
}

/** A web address a person typed, made safe to link. Anything that is not http or https gives null. */
function linkTarget(raw: string): { href: string; label: string } | null {
  const value = raw.trim()
  if (!value) return null
  const href = /^https?:\/\//i.test(value) ? value : /^[a-z][a-z0-9+.-]*:/i.test(value) ? '' : `https://${value}`
  if (!href) return null
  try {
    const url = new URL(href)
    if (!url.hostname.includes('.')) return null
    const label = `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`
    return { href: url.href, label }
  } catch {
    return null
  }
}

export function coverLetterHtml(text: string, profile: Profile, company = ''): string {
  const email = profile.email.trim()
  const details = [
    email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : '',
    escapeHtml(profile.phone.trim()),
    escapeHtml(profile.location.trim())
  ]
    .filter(Boolean)
    .join(' &middot; ')
  // The site shown is the portfolio, or the personal site when there is no portfolio.
  const links = [profile.links.linkedin, profile.links.github, profile.links.portfolio || profile.links.website]
    .map((raw) => linkTarget(raw))
    .filter((l): l is { href: string; label: string } => l !== null)
    .map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
    .join(' &middot; ')
  const contact = [details, links].filter(Boolean).join('<br>')
  const title = coverLetterFileName(profile, company).replace(/\.pdf$/, '')
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    @page { size: Letter; margin: 0.9in 1in; }
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.5; color: #1a1a1a; }
    header { border-bottom: 1px solid #ccc; padding-bottom: 10px; margin-bottom: 22px; }
    h1 { font-size: 20pt; font-weight: normal; margin: 0 0 4px; letter-spacing: 0.3px; }
    .contact { font-size: 9.5pt; color: #555; line-height: 1.6; }
    .contact a { color: #1a4d8f; text-decoration: none; }
    .date { margin-bottom: 18px; color: #333; }
    p { margin: 0 0 12px; }
  </style></head><body>
    <header><h1>${escapeHtml(profile.fullName || '')}</h1><div class="contact">${contact}</div></header>
    <div class="date">${date}</div>
    ${paragraphs}
  </body></html>`
}

/**
 * Renders the cover letter to a PDF with the headless browser and returns the file path. Each
 * application gets its own folder, so two applications to one company never share a file. The
 * file name stays clean because the employer sees it when the letter is uploaded.
 */
export async function renderCoverLetterPdf(
  browser: BrowserManager,
  settings: BrowserSettings,
  args: { text: string; profile: Profile; company: string; outDir: string; applicationId?: string }
): Promise<string> {
  const dir = args.applicationId ? path.join(args.outDir, args.applicationId.replace(/[^A-Za-z0-9_-]+/g, '')) : args.outDir
  fs.mkdirSync(dir, { recursive: true })
  const outPath = path.join(dir, coverLetterFileName(args.profile, args.company))
  const page = await browser.headlessPage(settings)
  try {
    await page.setContent(coverLetterHtml(args.text, args.profile, args.company), { waitUntil: 'load' })
    await page.pdf({ path: outPath, format: 'Letter', printBackground: true, preferCSSPageSize: true })
  } finally {
    await page.close()
  }
  return outPath
}
