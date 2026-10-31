import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { AnswerBankEntry, AnswerKind } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { Badge, Button, Card, CardHeader, ErrorBlock, Field, Input, Loading, Select, Textarea } from './ui'

type Draft = Pick<AnswerBankEntry, 'question' | 'answer' | 'kind'> & { id?: string }

export function AnswerBank(): React.JSX.Element {
  const toast = useToast()
  const list = useAsync(() => api.listAnswers(), [])
  const [adding, setAdding] = useState(false)

  async function save(d: Draft): Promise<void> {
    try {
      await api.saveAnswer({ id: d.id, question: d.question.trim(), answer: d.answer, kind: d.kind })
      toast.success('Saved.')
      setAdding(false)
      list.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api.deleteAnswer(id)
      list.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Answer bank"
        hint="A fact is reused word for word. A template is a starting point the AI adapts to each company."
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setAdding(true)} disabled={adding}>
            Add answer
          </Button>
        }
      />
      <div className="space-y-3 p-4">
        {list.error && <ErrorBlock message={list.error} onRetry={list.reload} />}
        {!list.data && !list.error && <Loading />}
        {adding && <Row draft={{ question: '', answer: '', kind: 'fact' }} isNew onSave={save} onCancel={() => setAdding(false)} />}
        {list.data?.length === 0 && !adding && <p className="text-sm text-muted">No saved answers yet. Add one here, or choose Save answer to bank while you review an application.</p>}
        {list.data?.map((e) => (
          <Row key={`${e.id}-${e.updatedAt}`} draft={e} timesUsed={e.timesUsed} onSave={save} onDelete={() => void remove(e.id)} />
        ))}
      </div>
    </Card>
  )
}

function Row({ draft, isNew, timesUsed, onSave, onDelete, onCancel }: { draft: Draft; isNew?: boolean; timesUsed?: number; onSave: (d: Draft) => Promise<void>; onDelete?: () => void; onCancel?: () => void }): React.JSX.Element {
  const [d, setD] = useState<Draft>(draft)
  const [busy, setBusy] = useState(false)
  const dirty = isNew || d.question !== draft.question || d.answer !== draft.answer || d.kind !== draft.kind
  return (
    <div className="rounded-lg border border-line bg-bg p-3">
      <div className="grid grid-cols-[1fr_9rem] gap-3">
        <Field label="Question">
          <Input value={d.question} onChange={(e) => setD({ ...d, question: e.target.value })} placeholder="Are you willing to relocate?" />
        </Field>
        <Field label="Type">
          <Select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as AnswerKind })}>
            <option value="fact">Fact</option>
            <option value="template">Template</option>
          </Select>
        </Field>
      </div>
      <Field label="Answer" className="mt-3">
        <Textarea rows={3} value={d.answer} onChange={(e) => setD({ ...d, answer: e.target.value })} />
      </Field>
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={!dirty || !d.question.trim() || !d.answer.trim()}
          onClick={async () => {
            setBusy(true)
            await onSave(d)
            setBusy(false)
          }}
        >
          Save
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {timesUsed != null && <Badge>{timesUsed === 0 ? 'Not used yet' : `Used ${timesUsed} times`}</Badge>}
        {onDelete && (
          <Button size="sm" variant="ghost" className="ml-auto" icon={<Trash2 size={13} />} onClick={onDelete}>
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}
