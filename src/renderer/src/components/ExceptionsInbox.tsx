import { useState } from 'react'
import { Link } from 'react-router'
import { ExternalLink, FileImage, RotateCw } from 'lucide-react'
import type { CouldNotSendGroup, NeedsYouGroup } from '@shared/types'
import { TRANSIENT_REASONS } from '@shared/reviewReasons'
import { api } from '@renderer/lib/api'
import { parseMulti, plural, stringifyMulti } from '@renderer/lib/format'
import { useToast } from '@renderer/lib/toast'
import { Badge, Button, Card, Checkbox, EmptyState, Input, Select, Textarea } from './ui'
import { REASON_HEADINGS, REASON_HINTS, answeredMessage, askHeading, defaultSaveToBank, inputKindFor, retryMessage } from './exceptionsHelpers'

/** Rows shown per card or section before "Show all". Hundreds of rows would bury the next card. */
const PREVIEW_ROWS = 8

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

export function NeedsYouList({ groups, onChanged }: { groups: NeedsYouGroup[]; onChanged: () => void }): React.JSX.Element {
  if (groups.length === 0) {
    return <EmptyState title="Nothing is waiting on you" text="Every open question is answered. When autopilot meets a question it cannot answer, it appears here once for all the applications that ask it." />
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <NeedsYouCard key={g.key} group={g} onChanged={onChanged} />
      ))}
    </div>
  )
}

function NeedsYouCard({ group, onChanged }: { group: NeedsYouGroup; onChanged: () => void }): React.JSX.Element {
  const toast = useToast()
  const [value, setValue] = useState('')
  const [saveToBank, setSaveToBank] = useState(defaultSaveToBank(group))
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const kind = inputKindFor(group)
  const ready = kind === 'yesno' ? value === 'true' || value === 'false' : value.trim() !== '' && value !== '[]'
  const companies = [...new Map(group.applications.map((a) => [a.id, a])).values()]
  const shown = showAll ? companies : companies.slice(0, PREVIEW_ROWS)
  const id = `group-${group.key.replace(/\W+/g, '-')}`

  async function answer(): Promise<void> {
    setBusy(true)
    try {
      const result = await api.answerGroup({ key: group.key, value, saveToBank, wordings: group.wordings })
      toast.success(answeredMessage(result))
      onChanged()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  let control: React.ReactNode
  switch (kind) {
    case 'select':
      control = (
        <Select id={id} value={value} onChange={(e) => setValue(e.target.value)} aria-label={group.label}>
          <option value="">Choose one</option>
          {group.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      )
      break
    case 'multi': {
      const picked = parseMulti(value)
      control = (
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {group.options?.map((o) => (
            <Checkbox key={o} label={o} checked={picked.includes(o)} onChange={(on) => setValue(stringifyMulti(on ? [...picked, o] : picked.filter((x) => x !== o)))} />
          ))}
        </div>
      )
      break
    }
    case 'yesno':
      control = (
        <Select id={id} value={value} onChange={(e) => setValue(e.target.value)} aria-label={group.label}>
          <option value="">Choose one</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      )
      break
    case 'date':
      control = <Input id={id} type="date" value={value} onChange={(e) => setValue(e.target.value)} aria-label={group.label} className="w-48" />
      break
    case 'textarea':
      control = <Textarea id={id} rows={5} value={value} onChange={(e) => setValue(e.target.value)} aria-label={group.label} />
      break
    case 'number':
      control = <Input id={id} type="number" value={value} onChange={(e) => setValue(e.target.value)} aria-label={group.label} className="w-48" />
      break
    default:
      control = <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} aria-label={group.label} />
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">{askHeading(group.count, group.label)}</h3>
        {group.userOnly && <Badge tone="warn">Only you can answer</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted">
        {shown.map((a, i) => (
          <span key={a.id}>
            {i > 0 && ', '}
            <Link to={`/review/${a.id}`} className="hover:text-fg hover:underline" title={a.title}>
              {a.company}
            </Link>
          </span>
        ))}
        {companies.length > shown.length && (
          <>
            {' '}
            <button type="button" className="text-accent-strong hover:underline" onClick={() => setShowAll(true)}>
              and {companies.length - shown.length} more
            </button>
          </>
        )}
      </p>
      {group.wordings.length > 1 && (
        <div className="mt-2 text-xs text-muted">
          <p>These applications word the question differently. Your answer goes to all of them, so check that it fits each wording.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {group.wordings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {group.applications[0]?.note && <p className="mt-2 text-xs text-muted">{group.applications[0].note}</p>}
      {group.userOnly && <p className="mt-2 text-xs text-muted">Autopilot sends this answer only when Settings allows it.</p>}
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && !busy) void answer()
        }}
      >
        {control}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Checkbox checked={saveToBank} onChange={setSaveToBank} label="Save as my answer for this question" disabled={busy} />
          <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
            {group.count === 1 ? 'Answer' : `Answer all ${group.count}`}
          </Button>
        </div>
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Couldn't send
// ---------------------------------------------------------------------------

export function CouldNotSendList({ groups, onChanged }: { groups: CouldNotSendGroup[]; onChanged: () => void }): React.JSX.Element {
  if (groups.length === 0) {
    return <EmptyState title="Nothing failed" text="Applications that autopilot could not send are grouped here by the reason." />
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <ReasonSection key={g.reason} group={g} onChanged={onChanged} />
      ))}
    </div>
  )
}

function ReasonSection({ group, onChanged }: { group: CouldNotSendGroup; onChanged: () => void }): React.JSX.Element {
  const toast = useToast()
  const [showAll, setShowAll] = useState(false)
  const [retrying, setRetrying] = useState(false)
  /** The row whose Open is running. Opening a form takes a while, and the browser can only show one at a time. */
  const [opening, setOpening] = useState<string | null>(null)
  const rows = showAll ? group.applications : group.applications.slice(0, PREVIEW_ROWS)
  const retryable = TRANSIENT_REASONS.includes(group.reason) ? group.applications.filter((a) => a.submitClickedAt === null) : []

  async function retry(): Promise<void> {
    setRetrying(true)
    try {
      toast.success(retryMessage(await api.retryLater(retryable.map((a) => a.id))))
      onChanged()
    } catch (e) {
      toast.error(e)
    } finally {
      setRetrying(false)
    }
  }

  async function open(id: string): Promise<void> {
    setOpening(id)
    try {
      const result = await api.submitApplication(id, 'assist')
      if (!result.ok) throw new Error(result.message)
      toast.success(result.message)
    } catch (e) {
      toast.error(e)
    } finally {
      setOpening(null)
      onChanged()
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
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {REASON_HEADINGS[group.reason]}
            <Badge>{group.count}</Badge>
          </h3>
          <p className="mt-0.5 text-xs text-muted">{REASON_HINTS[group.reason]}</p>
        </div>
        {retryable.length > 0 && (
          <Button size="sm" icon={<RotateCw size={13} />} loading={retrying} onClick={() => void retry()}>
            Retry later
          </Button>
        )}
      </div>
      <ul className="divide-y divide-line">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
            <div className="min-w-0 flex-1 basis-64">
              <Link to={`/review/${a.id}`} className="block truncate text-sm font-medium text-fg hover:underline">
                {a.company}
                <span className="font-normal text-muted">, {a.title}</span>
              </Link>
              {a.error && (
                <p className="line-clamp-2 text-xs text-muted" title={a.error}>
                  {a.error}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {a.screenshotPath && (
                <Button size="sm" variant="ghost" icon={<FileImage size={13} />} onClick={() => void screenshot(a.screenshotPath as string)}>
                  Screenshot
                </Button>
              )}
              <Button size="sm" icon={<ExternalLink size={13} />} loading={opening === a.id} disabled={opening !== null && opening !== a.id} onClick={() => void open(a.id)} title="Fills the form in the browser and leaves the final click to you">
                Open
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {group.applications.length > rows.length && (
        <div className="border-t border-line px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            Show all {plural(group.applications.length, 'application')}
          </Button>
        </div>
      )}
      {retryable.length > 0 && retryable.length < group.applications.length && (
        <p className="border-t border-line px-4 py-2 text-xs text-muted">Retry later skips the ones where the app already clicked Submit. Check those by hand.</p>
      )}
    </Card>
  )
}
