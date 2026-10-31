import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Image, Search, Send } from 'lucide-react'
import { clsx } from 'clsx'
import type { Application, ApplicationOutcome, ApplicationSummary } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync, useDebounced } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { basename, formatDate, formatDateTime, parseMulti, relativeTime } from '@renderer/lib/format'
import { FitBadge, OUTCOME_LABELS, OUTCOME_ORDER, OutcomeBadge, SUBMIT_MODE_LABELS, StatusBadge } from '@renderer/components/badges'
import { Badge, Button, Card, EmptyState, ErrorBlock, Field, Input, Loading, Modal, Page, PageHeader, Segmented, Select, TD, TH, Textarea } from '@renderer/components/ui'

type View = 'table' | 'kanban'

export function Applications(): React.JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const [view, setView] = useState<View>('table')
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const debounced = useDebounced(search, 250)

  const list = useAsync(() => api.listApplications({ statuses: ['submitted', 'submitting', 'failed', 'withdrawn'], search: debounced || undefined, limit: 500 }), [debounced], ['applications:changed'])

  async function setOutcome(a: ApplicationSummary, outcome: ApplicationOutcome): Promise<void> {
    // Update the screen first so the row does not jump back while the request runs.
    list.setData((cur) => (cur ? { ...cur, items: cur.items.map((x) => (x.id === a.id ? { ...x, outcome } : x)) } : cur))
    try {
      await api.updateApplication(a.id, { outcome })
    } catch (e) {
      toast.error(e)
      list.reload()
    }
  }

  const items = list.data?.items ?? []

  return (
    <Page wide>
      <PageHeader
        title="Applications"
        intro="Everything you applied to, and how each one went."
        actions={
          <Segmented
            value={view}
            onChange={setView}
            items={[
              { id: 'table', label: 'Table' },
              { id: 'kanban', label: 'Board' }
            ]}
          />
        }
      />
      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-72">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-faint" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company or title" className="pl-8" aria-label="Search applications" />
        </div>
        <span className="text-xs text-faint">{list.data ? `${list.data.total} applications` : ''}</span>
      </div>

      {list.error ? (
        <ErrorBlock message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Send size={24} />}
          title={debounced ? 'No applications match' : 'No applications yet'}
          text={debounced ? 'Try a different search.' : 'Applications you submit show up here so you can track replies. Check the review queue for drafts that are ready.'}
          action={
            !debounced && (
              <Button variant="primary" onClick={() => navigate('/review')}>
                Open review queue
              </Button>
            )
          }
        />
      ) : view === 'table' ? (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>Job</th>
                <th className={TH}>Fit</th>
                <th className={TH}>Status</th>
                <th className={TH}>Outcome</th>
                <th className={TH}>Submitted</th>
                <th className={TH}>How</th>
                <th className={TH}>Last change</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="cursor-pointer hover:bg-hover/50" onClick={() => setOpenId(a.id)}>
                  <td className={TD}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); setOpenId(a.id) }} className="block w-full text-left">
                      <span className="block font-medium text-fg">{a.title}</span>
                      <span className="block text-xs text-muted">{a.company}</span>
                    </button>
                  </td>
                  <td className={TD}>
                    <FitBadge bucket={a.fitBucket} score={a.fitScore} compact />
                  </td>
                  <td className={TD}>
                    <StatusBadge status={a.status} />
                  </td>
                  <td className={TD} onClick={(e) => e.stopPropagation()}>
                    <OutcomeSelect value={a.outcome} onChange={(o) => void setOutcome(a, o)} />
                  </td>
                  <td className={clsx(TD, 'whitespace-nowrap text-muted')}>{formatDate(a.submittedAt)}</td>
                  <td className={clsx(TD, 'text-muted')}>{a.submitMode ? SUBMIT_MODE_LABELS[a.submitMode] : '-'}</td>
                  <td className={clsx(TD, 'whitespace-nowrap text-muted')}>{relativeTime(a.outcomeAt ?? a.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Board items={items} onMove={(a, o) => void setOutcome(a, o)} onOpen={setOpenId} />
      )}

      {openId && <ApplicationDialog id={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </Page>
  )
}

function OutcomeSelect({ value, onChange, className }: { value: ApplicationOutcome; onChange: (o: ApplicationOutcome) => void; className?: string }): React.JSX.Element {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as ApplicationOutcome)} className={clsx('h-7 text-xs', className ?? 'w-36')} aria-label="Outcome">
      {OUTCOME_ORDER.map((o) => (
        <option key={o} value={o}>
          {OUTCOME_LABELS[o]}
        </option>
      ))}
    </Select>
  )
}

function Board({ items, onMove, onOpen }: { items: ApplicationSummary[]; onMove: (a: ApplicationSummary, o: ApplicationOutcome) => void; onOpen: (id: string) => void }): React.JSX.Element {
  const [over, setOver] = useState<ApplicationOutcome | null>(null)
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {OUTCOME_ORDER.map((o) => {
        const col = items.filter((a) => a.outcome === o)
        return (
          <section
            key={o}
            aria-label={OUTCOME_LABELS[o]}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(o)
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              const a = items.find((x) => x.id === e.dataTransfer.getData('text/plain'))
              if (a && a.outcome !== o) onMove(a, o)
            }}
            className={clsx('min-h-48 w-48 shrink-0 rounded-lg border bg-surface p-2 transition-colors', over === o ? 'border-accent/60 bg-accent-soft' : 'border-line')}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <OutcomeBadge outcome={o} />
              <span className="text-xs tabular-nums text-faint">{col.length}</span>
            </div>
            <div className="space-y-2">
              {col.map((a) => (
                <div key={a.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', a.id)} className="cursor-grab rounded-md border border-line bg-raised p-2 hover:border-line-strong active:cursor-grabbing">
                  <button onClick={() => onOpen(a.id)} className="block w-full text-left">
                    <p className="truncate text-sm font-medium text-fg">{a.title}</p>
                    <p className="truncate text-xs text-muted">{a.company}</p>
                  </button>
                  <p className="mt-1 text-xs text-faint">{formatDate(a.submittedAt)}</p>
                  <OutcomeSelect value={a.outcome} onChange={(x) => onMove(a, x)} className="mt-1.5 w-full" />
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function ApplicationDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const toast = useToast()
  const state = useAsync(() => api.getApplication(id), [id])
  const [notes, setNotes] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const app: Application | null = state.data

  /** Resolves true when the save went through, so callers keep what was typed when it didn't. */
  async function save(patch: Parameters<typeof api.updateApplication>[1]): Promise<boolean> {
    setSaving(true)
    try {
      const next = await api.updateApplication(id, patch)
      state.setData(next)
      onChanged()
      toast.success('Saved.')
      return true
    } catch (e) {
      toast.error(e)
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={app ? `${app.title} at ${app.company}` : 'Application'} onClose={onClose} wide>
      {state.error ? (
        <ErrorBlock message={state.error} onRetry={state.reload} />
      ) : !app ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-4">
            <Field label="Outcome">
              <OutcomeSelect value={app.outcome} onChange={(o) => void save({ outcome: o })} />
            </Field>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Submitted</p>
              <p className="text-sm text-fg">{formatDateTime(app.submittedAt)}</p>
              <p className="text-xs text-faint">{app.submitMode ? SUBMIT_MODE_LABELS[app.submitMode] : 'Not submitted'}</p>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Screenshot</p>
              {app.screenshotPath ? (
                <Button size="sm" icon={<Image size={13} />} onClick={() => void api.openPath(app.screenshotPath as string).catch(toast.error)}>
                  Open screenshot
                </Button>
              ) : (
                <p className="text-sm text-faint">None saved</p>
              )}
            </div>
          </div>

          {app.confirmation && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Confirmation from the site</p>
              <p className="rounded-md border border-line bg-bg p-2.5 text-sm text-muted">{app.confirmation}</p>
            </div>
          )}
          {app.error && <ErrorBlock message={app.error} />}

          <Field label="Notes" hint="Interview dates, names, anything you want to remember.">
            <Textarea rows={3} value={notes ?? app.notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="-mt-3 flex justify-end">
            <Button size="sm" variant="primary" loading={saving} disabled={notes === null || notes === app.notes} onClick={() => void save({ notes: notes ?? '' }).then((ok) => ok && setNotes(null))}>
              Save notes
            </Button>
          </div>

          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-fg">Cover letter</summary>
            <p className="whitespace-pre-wrap border-t border-line p-3 text-sm text-muted">{app.coverLetter ?? 'No cover letter.'}</p>
          </details>

          <Card>
            <div className="border-b border-line px-3 py-2 text-sm font-medium text-fg">Answers sent</div>
            <dl className="divide-y divide-line">
              {app.answers.map((a) => (
                <div key={a.fieldKey} className="grid grid-cols-[14rem_1fr] gap-3 px-3 py-2 text-sm">
                  <dt className="text-muted">{a.label}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words text-fg">
                    {a.type === 'file' ? basename(a.value) : a.type === 'checkboxes' || a.type === 'multiselect' ? parseMulti(a.value).join(', ') : a.type === 'checkbox' ? (a.value === 'true' ? 'Yes' : 'No') : a.value || <Badge>Left empty</Badge>}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      )}
    </Modal>
  )
}
