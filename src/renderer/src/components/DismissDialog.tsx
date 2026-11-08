import { useState } from 'react'
import { DISMISS_TAGS } from '@shared/types'
import { Button, Chip, Field, Modal, Textarea } from './ui'

interface Props {
  /** What is being dismissed, for the heading: a job title or "3 jobs". */
  subject: string
  onConfirm: (reason: string | null, tags: string[]) => Promise<void> | void
  onClose: () => void
}

export function DismissDialog({ subject, onConfirm, onClose }: Props): React.JSX.Element {
  const [tags, setTags] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    setBusy(true)
    try {
      await onConfirm(reason.trim() || null, tags)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Dismiss ${subject}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Dismiss
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">Pick the reasons that apply. jobpls uses them to suggest filter changes, so fewer jobs like this reach the AI.</p>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {DISMISS_TAGS.map((t) => (
          <Chip key={t} selected={tags.includes(t)} onClick={() => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}>
            {t}
          </Chip>
        ))}
      </div>
      <Field label="Reason (optional)">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Anything else worth remembering" />
      </Field>
    </Modal>
  )
}
