import fs from 'node:fs'
import path from 'node:path'
import type { BrowserSettings, Profile } from '@shared/types'
import type { BrowserManager } from './browser'

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function coverLetterFileName(profile: Profile, company: string): string {
  const clean = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').replace(/\s+/g, ' ').trim()
  const name = clean(profile.fullName) || 'Cover Letter'
  return `${name} - Cover Letter - ${clean(company) || 'Company'}.pdf`
}

export function coverLetterHtml(text: string, profile: Profile): string {
  const contact = [profile.email, profile.phone, profile.location, profile.links.linkedin || profile.links.website || profile.links.portfolio]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' &middot; ')
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0.9in 1in; }
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.5; color: #1a1a1a; }
    header { border-bottom: 1px solid #ccc; padding-bottom: 10px; margin-bottom: 22px; }
    h1 { font-size: 20pt; font-weight: normal; margin: 0 0 4px; letter-spacing: 0.3px; }
    .contact { font-size: 9.5pt; color: #555; }
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
    await page.setContent(coverLetterHtml(args.text, args.profile), { waitUntil: 'load' })
    await page.pdf({ path: outPath, format: 'Letter', printBackground: true, preferCSSPageSize: true })
  } finally {
    await page.close()
  }
  return outPath
}
