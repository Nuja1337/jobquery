import type { DocumentKind, DocumentRecord } from '@shared/types'
import { type Db, newId, now } from '../database'

interface DocumentRow {
  id: string
  kind: DocumentKind
  name: string
  file_path: string | null
  mime: string | null
  url: string | null
  text: string
  is_primary: number
  created_at: string
}

export interface NewDocument {
  kind: DocumentKind
  name: string
  filePath?: string | null
  mime?: string | null
  url?: string | null
  text: string
}

function toRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    filePath: row.file_path,
    mime: row.mime,
    url: row.url,
    textPreview: row.text.slice(0, 300),
    textLength: row.text.length,
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at
  }
}

export class DocumentsRepo {
  constructor(private readonly db: Db) {}

  /** The first resume added becomes the primary one. */
  insert(doc: NewDocument): DocumentRecord {
    const id = newId()
    const isPrimary =
      doc.kind === 'resume' && !this.db.get("SELECT 1 AS x FROM documents WHERE kind = 'resume' AND is_primary = 1")
    this.db.run(
      `INSERT INTO documents (id, kind, name, file_path, mime, url, text, is_primary, created_at)
       VALUES (:id, :kind, :name, :filePath, :mime, :url, :text, :isPrimary, :at)`,
      {
        id,
        kind: doc.kind,
        name: doc.name,
        filePath: doc.filePath ?? null,
        mime: doc.mime ?? null,
        url: doc.url ?? null,
        text: doc.text,
        isPrimary,
        at: now()
      }
    )
    return this.get(id)!
  }

  list(kind?: DocumentKind): DocumentRecord[] {
    const rows = kind
      ? this.db.all<DocumentRow>('SELECT * FROM documents WHERE kind = :kind ORDER BY created_at DESC', { kind })
      : this.db.all<DocumentRow>('SELECT * FROM documents ORDER BY created_at DESC')
    return rows.map(toRecord)
  }

  get(id: string): DocumentRecord | null {
    const row = this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = :id', { id })
    return row ? toRecord(row) : null
  }

  getText(id: string): string {
    return this.db.get<{ text: string }>('SELECT text FROM documents WHERE id = :id', { id })?.text ?? ''
  }

  primaryResume(): DocumentRecord | null {
    const row = this.db.get<DocumentRow>("SELECT * FROM documents WHERE kind = 'resume' AND is_primary = 1")
    return row ? toRecord(row) : null
  }

  /** Removes the record. If it was the primary resume, the newest remaining resume takes over. */
  delete(id: string): void {
    const row = this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = :id', { id })
    if (!row) return
    this.db.transaction(() => {
      this.db.run('DELETE FROM documents WHERE id = :id', { id })
      if (row.kind === 'resume' && row.is_primary === 1) {
        const next = this.db.get<{ id: string }>("SELECT id FROM documents WHERE kind = 'resume' ORDER BY created_at DESC")
        if (next) this.db.run('UPDATE documents SET is_primary = 1 WHERE id = :id', { id: next.id })
      }
    })
  }

  /** Only one resume is primary at a time. */
  setPrimary(id: string): void {
    const row = this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = :id', { id })
    if (!row || row.kind !== 'resume') return
    this.db.transaction(() => {
      this.db.run("UPDATE documents SET is_primary = 0 WHERE kind = 'resume'")
      this.db.run('UPDATE documents SET is_primary = 1 WHERE id = :id', { id })
    })
  }
}
