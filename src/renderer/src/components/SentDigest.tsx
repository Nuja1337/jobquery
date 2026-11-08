import { useState } from 'react'
import { Link } from 'react-router'
import { FileImage, ShieldAlert } from 'lucide-react'
import type { ReviewExceptions, SentSample } from '@shared/types'
import { api } from '@renderer/lib/api'
import { formatDateTime } from '@renderer/lib/format'
import { useToast } from '@renderer/lib/toast'
import { Button, Card, CardHeader, EmptyState, Input, Notice, Stat } from './ui'

export function SentDigest({ sent, onChanged }: { sent: ReviewExceptions['sent']; onChanged: () => void }): React.JSX.Element {
  /** Set after a report, so the pause notice stays visible until the person leaves the tab. */
  const [paused, setPaused] = useState<string | null>(null)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <Stat label="Sent today" value={sent.today} />
        <Stat label="Sent this week" value={sent.week} />
      </div>
      {paused && (
        <Notice tone="warn" title="Auto-submit is paused">
          You reported a wrong submission to {paused}. Nothing more is sent automatically until you turn auto-submit back on in Settings.
        </Notice>
      )}
      {sent.sample.length === 0 ? (
        <EmptyState title="Nothing to check yet" text="When autopilot sends applications today, a few random ones show up here so you can spot problems early." />
      ) : (
        <Card>
          <CardHeader title={sent.sample.length === 5 ? 'Check these five' : `Check these ${sent.sample.length}`} hint="Picked at random from what was sent today." />
          <ul className="divide-y divide-line">
            {sent.sample.map((s) => (
              <SampleRow key={s.id} sample={s} onReported={(company) => setPaused(company)} onChanged={onChanged} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function SampleRow({ sample, onReported, onChanged }: { sample: SentSample; onReported: (company: string) => void; onChanged: () => void }): React.JSX.Element {
  const toast = useToast()
  const [reporting, setReporting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function report(): Promise<void> {
    setBusy(true)
    try {
      await api.reportWrongSubmission(sample.id, note)
      setReporting(false)
      setNote('')
      onReported(sample.company)
      onChanged()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  async function screenshot(path: string): Promise<void> {
    try {
      await api.openPath(path)
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <Link to={`/review/${sample.id}`} className="block truncate text-sm font-medium text-fg hover:underline">
            {sample.company}
            <span className="font-normal text-muted">, {sample.title}</span>
          </Link>
          <p className="text-xs text-faint">Sent {formatDateTime(sample.submittedAt)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {sample.screenshotPath ? (
            <Button size="sm" variant="ghost" icon={<FileImage size={13} />} onClick={() => void screenshot(sample.screenshotPath as string)}>
              Screenshot
            </Button>
          ) : (
            <span className="text-xs text-faint">No screenshot</span>
          )}
          <Button size="sm" icon={<ShieldAlert size={13} />} aria-expanded={reporting} onClick={() => setReporting(!reporting)}>
            This was wrong
          </Button>
        </div>
      </div>
      {reporting && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (note.trim() && !busy) void report()
          }}
        >
          <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="What was wrong, in one line" aria-label="What was wrong with this application" className="min-w-64 flex-1" />
          <Button type="submit" variant="danger" loading={busy} disabled={!note.trim()}>
            Pause auto-submit
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setReporting(false)}>
            Cancel
          </Button>
          <p className="basis-full text-xs text-muted">This turns auto-submit off and keeps your note on the application.</p>
        </form>
      )}
    </li>
  )
}
