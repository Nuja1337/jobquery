import { useState } from 'react'
import { ClipboardPaste, Eye, FileText, Link as LinkIcon, Star, Trash2, Upload } from 'lucide-react'
import type { DocumentKind, DocumentRecord } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { formatDate } from '@renderer/lib/format'
import { ConfirmDialog } from './ConfirmDialog'
import { Badge, Button, Card, CardHeader, ErrorBlock, Field, IconButton, Input, Loading, Modal, Textarea } from './ui'

const EXTENSIONS = ['pdf', 'docx', 'txt', 'md']

interface Props {
  kind: DocumentKind
  title: string
  hint?: string
  /** Also allow adding a web address (portfolio pages). */
  allowLink?: boolean
  /** Also allow pasting text (writing samples). */
  allowPaste?: boolean
  emptyText: string
  onChange?: (docs: DocumentRecord[]) => void
  /** Called when the person picks or sets a resume, so a parent can offer to read it. */
  compact?: boolean
}

export function DocumentSection({ kind, title, hint, allowLink, allowPaste, emptyText, onChange, compact }: Props): React.JSX.Element {
  const toast = useToast()
  const docs = useAsync(
    async () => {
      const list = await api.listDocuments(kind)
      onChange?.(list)
      return list
    },
    [kind]
  )
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<DocumentRecord | null>(null)
  const [deleting, setDeleting] = useState<DocumentRecord | null>(null)
  const [adding, setAdding] = useState<'link' | 'paste' | null>(null)

  async function upload(): Promise<void> {
    setBusy(true)
    try {
      const paths = await api.pickFiles({ title: `Choose ${title.toLowerCase()}`, extensions: EXTENSIONS, multiple: kind !== 'resume' })
      for (const filePath of paths) await api.importDocument({ kind, filePath })
      if (paths.length) {
        toast.success(paths.length === 1 ? 'Added the file.' : `Added ${paths.length} files.`)
        docs.reload()
      }
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const list = docs.data ?? []
  return (
    <Card className={compact ? '' : 'mb-4'}>
      <CardHeader
        title={title}
        hint={hint}
        actions={
          <>
            {allowLink && (
              <Button size="sm" icon={<LinkIcon size={13} />} onClick={() => setAdding('link')}>
                Add link
              </Button>
            )}
            {allowPaste && (
              <Button size="sm" icon={<ClipboardPaste size={13} />} onClick={() => setAdding('paste')}>
                Paste text
              </Button>
            )}
            <Button size="sm" variant="secondary" icon={<Upload size={13} />} loading={busy} onClick={() => void upload()}>
              Upload
            </Button>
          </>
        }
      />
      {docs.error ? (
        <div className="p-4">
          <ErrorBlock message={docs.error} onRetry={docs.reload} />
        </div>
      ) : !docs.data ? (
        <Loading />
      ) : list.length === 0 ? (
        <p className="p-4 text-sm text-muted">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
              {d.url ? <LinkIcon size={16} className="shrink-0 text-faint" /> : <FileText size={16} className="shrink-0 text-faint" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg">{d.name}</p>
                <p className="text-xs text-faint">
                  Added {formatDate(d.createdAt)}, {d.textLength.toLocaleString('en-US')} characters read
                </p>
              </div>
              {d.isPrimary && <Badge tone="good">Primary resume</Badge>}
              {kind === 'resume' && !d.isPrimary && (
                <Button
                  size="sm"
                  icon={<Star size={13} />}
                  onClick={() =>
                    void api.setPrimaryResume(d.id).then(() => {
                      toast.success('Primary resume changed. Applications that are not sent yet will use it.')
                      docs.reload()
                    }, toast.error)
                  }
                >
                  Make primary
                </Button>
              )}
              <IconButton label="View text" onClick={() => setViewing(d)}>
                <Eye size={15} />
              </IconButton>
              <IconButton label="Delete" onClick={() => setDeleting(d)}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {viewing && <TextViewer doc={viewing} onClose={() => setViewing(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete document"
          message={
            kind === 'resume'
              ? `Delete ${deleting.name}? Applications that are not sent yet switch to your primary resume. Applications you already sent are not changed.`
              : `Delete ${deleting.name}? JobPilot will stop using it for new applications. Applications already written are not changed.`
          }
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteDocument(deleting.id)
              docs.reload()
            } catch (e) {
              toast.error(e)
              throw e
            }
          }}
        />
      )}
      {adding && (
        <AddDialog
          mode={adding}
          kind={kind}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setAdding(null)
            docs.reload()
          }}
        />
      )}
    </Card>
  )
}

function TextViewer({ doc, onClose }: { doc: DocumentRecord; onClose: () => void }): React.JSX.Element {
  const text = useAsync(() => api.getDocumentText(doc.id), [doc.id])
  return (
    <Modal title={doc.name} onClose={onClose} wide>
      {text.error ? <ErrorBlock message={text.error} onRetry={text.reload} /> : text.data == null ? <Loading /> : <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">{text.data || 'No text could be read from this file.'}</pre>}
    </Modal>
  )
}

function AddDialog({ mode, kind, onClose, onAdded }: { mode: 'link' | 'paste'; kind: DocumentKind; onClose: () => void; onAdded: () => void }): React.JSX.Element {
  const toast = useToast()
  const [value, setValue] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = mode === 'link' ? /^https?:\/\//.test(value.trim()) : value.trim().length > 20

  async function save(): Promise<void> {
    setBusy(true)
    try {
      await api.importDocument(mode === 'link' ? { kind, url: value.trim(), name: name.trim() || undefined } : { kind, text: value, name: name.trim() || 'Pasted text' })
      toast.success('Added.')
      onAdded()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={mode === 'link' ? 'Add a link' : 'Paste text'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === 'link' ? 'My portfolio' : 'Blog post about migrations'} />
        </Field>
        {mode === 'link' ? (
          <Field label="Web address" hint="JobPilot reads the page and keeps the text.">
            <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://" />
          </Field>
        ) : (
          <Field label="Text" hint="Paste something you wrote yourself. Longer samples teach your voice better.">
            <Textarea autoFocus rows={10} value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
