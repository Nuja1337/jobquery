import fs from 'node:fs'
import path from 'node:path'
import mammoth from 'mammoth'
import { convert } from 'html-to-text'
import { extractText, getDocumentProxy } from 'unpdf'

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html'
}

export const SUPPORTED_EXTENSIONS = Object.keys(MIME).map((e) => e.slice(1))

/** Reads the text out of a resume, cover letter or writing sample. */
export async function extractTextFromFile(filePath: string): Promise<{ text: string; mime: string }> {
  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME[ext]
  if (!mime) throw new Error(`Files ending in ${ext || '(none)'} aren't supported. Use PDF, Word (.docx), text or Markdown.`)
  let text: string
  if (ext === '.pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(filePath)))
    text = (await extractText(pdf, { mergePages: true })).text
  } else if (ext === '.docx') {
    text = (await mammoth.extractRawText({ path: filePath })).value
  } else if (ext === '.html' || ext === '.htm') {
    text = convert(fs.readFileSync(filePath, 'utf8'), { wordwrap: false })
  } else {
    text = fs.readFileSync(filePath, 'utf8')
  }
  text = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (ext === '.pdf' && text.length < 50) {
    throw new Error('This PDF has almost no text in it. It may be a scanned image. Export it again as a text PDF or upload a Word file.')
  }
  return { text, mime }
}

/** Keeps a copy inside the app's data folder so moving or deleting the original doesn't break uploads. */
export function copyIntoAppData(filePath: string, documentsDir: string, id: string): string {
  const safeName = path.basename(filePath).replace(/[^\w.\- ]+/g, '_')
  const dest = path.join(documentsDir, `${id}-${safeName}`)
  fs.copyFileSync(filePath, dest)
  return dest
}

/** Fetches a portfolio or personal site and keeps its readable text. */
export async function fetchUrlText(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'JobPilot/0.1 (+https://github.com/ajshaham1337/jobpilot)' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status}).`)
  const html = await res.text()
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || new URL(url).hostname
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      { selector: 'footer', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' }
    ]
  })
  return { title, text: text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 20_000) }
}
