import { decodeEntities } from './normalize'

// A small reader for the two XML feeds JobPilot uses (We Work Remotely and Personio). There is no XML
// library in the project and these feeds are flat and well formed, so this finds tags with indexOf
// and handles CDATA and entities. It does not validate and does not handle namespaces or attributes.

/** True when the character after a tag name ends the name, so `<position>` does not match `<positions>`. */
function endsTagName(ch: string | undefined): boolean {
  return ch === '>' || ch === '/' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'
}

interface Located {
  /** Index of the first character after the opening tag. */
  innerStart: number
  /** Index of the closing tag, or -1 for a self-closing tag. */
  innerEnd: number
  /** Index of the first character after the whole element. */
  next: number
}

function locate(xml: string, tag: string, from: number): Located | null {
  const open = `<${tag}`
  let at = xml.indexOf(open, from)
  while (at !== -1 && !endsTagName(xml[at + open.length])) at = xml.indexOf(open, at + open.length)
  if (at === -1) return null
  const tagEnd = xml.indexOf('>', at)
  if (tagEnd === -1) return null
  if (xml[tagEnd - 1] === '/') return { innerStart: tagEnd + 1, innerEnd: -1, next: tagEnd + 1 }
  const close = `</${tag}>`
  const closeAt = xml.indexOf(close, tagEnd + 1)
  if (closeAt === -1) return null
  return { innerStart: tagEnd + 1, innerEnd: closeAt, next: closeAt + close.length }
}

/** The inner text of every element with this tag name, in document order. Self-closing tags are skipped. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const found = locate(xml, tag, from)
    if (!found) break
    if (found.innerEnd !== -1) blocks.push(xml.slice(found.innerStart, found.innerEnd))
    from = found.next
  }
  return blocks
}

/** Reads CDATA sections as they are and decodes entities in the rest. */
function readValue(raw: string): string {
  const open = '<![CDATA['
  let out = ''
  let pos = 0
  for (;;) {
    const start = raw.indexOf(open, pos)
    if (start === -1) {
      out += decodeEntities(raw.slice(pos))
      break
    }
    out += decodeEntities(raw.slice(pos, start))
    const end = raw.indexOf(']]>', start + open.length)
    if (end === -1) {
      out += raw.slice(start + open.length)
      break
    }
    out += raw.slice(start + open.length, end)
    pos = end + 3
  }
  return out
}

/** The text of the first element with this tag name, or null when it is missing or empty. */
export function xmlText(xml: string, tag: string): string | null {
  const found = locate(xml, tag, 0)
  if (!found || found.innerEnd === -1) return null
  const text = readValue(xml.slice(found.innerStart, found.innerEnd)).trim()
  return text || null
}

/** The text of every element with this tag name. */
export function xmlTexts(xml: string, tag: string): string[] {
  return xmlBlocks(xml, tag)
    .map((b) => readValue(b).trim())
    .filter(Boolean)
}
