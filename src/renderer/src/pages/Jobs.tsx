import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Briefcase, FileEdit, Link as LinkIcon, RotateCcw, Search, Star, X } from 'lucide-react'
import { clsx } from 'clsx'
import { BUCKET_LABELS } from '@shared/defaults'
import type { FitBucket, JobQuery, JobStage, JobSummary, SourceKind } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync, useDebounced } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { SOURCE_LABELS, formatSalary, plural, shortAge } from '@renderer/lib/format'
import { FitBadge, StageBadge } from '@renderer/components/badges'
import { DismissDialog } from '@renderer/components/DismissDialog'
import { Badge, Button, EmptyState, ErrorBlock, Field, IconButton, Input, Loading, Modal, Page, PageHeader, Select, TD, TH, Tabs } from '@renderer/components/ui'

type TabId = 'shortlist' | 'new' | 'notfit' | 'dismissed' | 'applied' | 'all'

const TAB_STAGES: Record<TabId, JobStage[] | undefined> = {
  shortlist: ['shortlisted', 'preparing', 'ready'],
  new: ['new'],
  notfit: ['scored', 'filtered_out', 'prescored_out'],
  dismissed: ['dismissed'],
  applied: ['applied'],
  all: undefined
}

const TAB_LABELS: Array<{ id: TabId; label: string }> = [
  { id: 'shortlist', label: 'Shortlist' },
  { id: 'new', label: 'New' },
  { id: 'notfit', label: 'Not a fit' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'applied', label: 'Applied' },
  { id: 'all', label: 'All' }
]

const EMPTY_TEXT: Record<TabId, { title: string; text: string }> = {
  shortlist: { title: 'Nothing on the shortlist', text: 'Jobs that score as a good, great or perfect fit land here. Press Run now to look for new ones.' },
  new: { title: 'No new jobs', text: 'New jobs wait here until the free filters and the AI have looked at them.' },
  notfit: { title: 'Nothing filtered out yet', text: 'Jobs dropped by your filters or scored below the shortlist line show here with the reason, so you never review them twice.' },
  dismissed: { title: 'No dismissed jobs', text: 'Jobs you dismiss are kept here. Restore one if you change your mind.' },
  applied: { title: 'No applications sent', text: 'Jobs you applied to show here. Prepare one from the shortlist to get started.' },
  all: { title: 'No jobs yet', text: 'Add a company or a saved search in Sources, then press Run now. You can also add a single job by its web address.' }
}

const PAGE = 100
/** The most rows the main process returns for one request. */
const MAX_REQUEST = 500

export function Jobs(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const [tab, setTab] = useState<TabId>('shortlist')
  const [search, setSearch] = useState('')
  const [bucket, setBucket] = useState<FitBucket | ''>('')
  const [source, setSource] = useState<SourceKind | ''>('')
  const [starredOnly, setStarredOnly] = useState(false)
  const [sort, setSort] = useState<NonNullable<JobQuery['sort']>>('score')
  const [limit, setLimit] = useState(PAGE)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [dismissing, setDismissing] = useState<JobSummary[] | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const debouncedSearch = useDebounced(search, 250)

  const query = useMemo<JobQuery>(
    () => ({
      stages: TAB_STAGES[tab],
      buckets: bucket ? [bucket] : undefined,
      sources: source ? [source] : undefined,
      search: debouncedSearch || undefined,
      starredOnly: starredOnly || undefined,
      sort,
      limit
    }),
    [tab, bucket, source, debouncedSearch, starredOnly, sort, limit]
  )

  // Loads `limit` rows in requests of at most MAX_REQUEST, paging with offset and appending.
  const list = useAsync(
    async () => {
      const items: JobSummary[] = []
      const seen = new Set<string>()
      let total = 0
      while (items.length < (query.limit ?? PAGE)) {
        const page = await api.listJobs({ ...query, limit: Math.min(MAX_REQUEST, (query.limit ?? PAGE) - items.length), offset: items.length })
        total = page.total
        for (const j of page.items) {
          if (!seen.has(j.id)) {
            seen.add(j.id)
            items.push(j)
          }
        }
        if (page.items.length === 0 || items.length >= total) break
      }
      return { items, total }
    },
    [query],
    ['jobs:changed']
  )
  const counts = useAsync(
    async () => {
      const entries = await Promise.all(TAB_LABELS.map(async (t) => [t.id, (await api.listJobs({ stages: TAB_STAGES[t.id], limit: 1 })).total] as const))
      return Object.fromEntries(entries) as Record<TabId, number>
    },
    [],
    ['jobs:changed']
  )

  const items = list.data?.items ?? []
  const allSelected = items.length > 0 && items.every((j) => selected.has(j.id))
  /** Selected rows that are still on screen. Rows hidden by a filter or tab don't count. */
  const selectedRows = items.filter((j) => selected.has(j.id))

  function changeTab(next: TabId): void {
    setTab(next)
    setSelected(new Set())
    setLimit(PAGE)
  }

  async function withBusy(id: string, fn: () => Promise<void>): Promise<void> {
    setBusyIds((s) => new Set(s).add(id))
    try {
      await fn()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusyIds((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    }
  }

  const star = (j: JobSummary): Promise<void> => withBusy(j.id, async () => { await api.starJob(j.id, !j.starred) })
  const restore = (j: JobSummary): Promise<void> =>
    withBusy(j.id, async () => {
      await api.restoreJob(j.id)
      toast.success(`Restored ${j.title}.`)
    })
  const prepare = (j: JobSummary): Promise<void> =>
    withBusy(j.id, async () => {
      await api.prepareApplication(j.id)
      toast.success(`Application drafted for ${j.company}. It is in the review queue.`)
    })

  async function dismissMany(jobs: JobSummary[], reason: string | null, tags: string[]): Promise<void> {
    try {
      await Promise.all(jobs.map((j) => api.dismissJob(j.id, reason, tags)))
      toast.success(`Dismissed ${plural(jobs.length, 'job')}.`)
      setSelected(new Set())
    } catch (e) {
      toast.error(e)
      throw e
    }
  }

  return (
    <Page wide>
      <PageHeader
        title="Jobs"
        intro="Everything JobPilot found, with what it decided and why."
        actions={
          <Button icon={<LinkIcon size={14} />} onClick={() => setAddOpen(true)}>
            Add job by URL
          </Button>
        }
      />

      <Tabs items={TAB_LABELS.map((t) => ({ ...t, count: counts.data?.[t.id] }))} value={tab} onChange={changeTab} />

      <div className="my-3 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-faint" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title, company or place" className="pl-8" aria-label="Search jobs" />
        </div>
        <Select value={bucket} onChange={(e) => setBucket(e.target.value as FitBucket | '')} className="w-36" aria-label="Fit">
          <option value="">Any fit</option>
          {(['perfect', 'great', 'good', 'weak'] as FitBucket[]).map((b) => (
            <option key={b} value={b}>
              {BUCKET_LABELS[b]}
            </option>
          ))}
        </Select>
        <Select value={source} onChange={(e) => setSource(e.target.value as SourceKind | '')} className="w-40" aria-label="Source">
          <option value="">Any source</option>
          {(Object.keys(SOURCE_LABELS) as SourceKind[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </Select>
        <Button variant={starredOnly ? 'primary' : 'secondary'} icon={<Star size={13} />} onClick={() => setStarredOnly(!starredOnly)} aria-pressed={starredOnly}>
          Starred
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-faint">Sort by</span>
          <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="w-36" aria-label="Sort">
            <option value="score">Best fit</option>
            <option value="newest">Newest found</option>
            <option value="posted">Newest posted</option>
            <option value="company">Company</option>
          </Select>
        </div>
      </div>

      {selectedRows.length > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
          <span className="text-fg">{selectedRows.length} selected</span>
          <Button size="sm" variant="danger" icon={<X size={13} />} onClick={() => setDismissing(selectedRows)}>
            Dismiss selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {list.error ? (
        <ErrorBlock message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : items.length === 0 ? (
        search || bucket || source || starredOnly ? (
          <EmptyState icon={<Briefcase size={24} />} title="No jobs match these filters" text="Clear the search or a filter to see more." />
        ) : (
          <EmptyState icon={<Briefcase size={24} />} {...EMPTY_TEXT[tab]} />
        )
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={clsx(TH, 'w-8')}>
                  <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((j) => j.id)) : new Set())} />
                </th>
                <th className={clsx(TH, 'w-8')} />
                <th className={clsx(TH, 'w-40')}>Fit</th>
                <th className={TH}>Job</th>
                <th className={TH}>Where</th>
                <th className={TH}>Pay</th>
                <th className={TH}>Source</th>
                <th className={clsx(TH, 'text-right')}>Posted</th>
                <th className={clsx(TH, 'text-right')}>Prescore</th>
                <th className={clsx(TH, 'w-56 text-right')}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((j) => {
                const busy = busyIds.has(j.id)
                const reason = j.filterReason ?? (j.stage === 'scored' ? j.fitSummary : null)
                const canPrepare = (j.stage === 'shortlisted' || j.stage === 'new') && !j.applicationId
                return (
                  <tr key={j.id} className="group cursor-pointer hover:bg-hover/50" onClick={() => navigate(`/jobs/${j.id}`)}>
                    <td className={TD} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${j.title}`}
                        checked={selected.has(j.id)}
                        onChange={(e) =>
                          setSelected((s) => {
                            const n = new Set(s)
                            if (e.target.checked) n.add(j.id)
                            else n.delete(j.id)
                            return n
                          })
                        }
                      />
                    </td>
                    <td className={TD} onClick={(e) => e.stopPropagation()}>
                      <IconButton label={j.starred ? 'Remove star' : 'Star'} active={j.starred} disabled={busy} onClick={() => void star(j)}>
                        <Star size={14} className={j.starred ? 'fill-current' : ''} />
                      </IconButton>
                    </td>
                    <td className={TD}>
                      <div className="flex flex-col items-start gap-1">
                        <FitBadge bucket={j.fitBucket} score={j.fitScore} />
                        {tab === 'all' && <StageBadge stage={j.stage} />}
                      </div>
                    </td>
                    <td className={clsx(TD, 'max-w-md')}>
                      <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/jobs/${j.id}`) }} className="block w-full text-left">
                        <span className="block truncate font-medium text-fg group-hover:text-accent-strong">{j.title}</span>
                        <span className="block truncate text-xs text-muted">{j.company}</span>
                        {reason && tab !== 'shortlist' && <span className="mt-0.5 line-clamp-1 block text-xs text-faint">{reason}</span>}
                      </button>
                    </td>
                    <td className={clsx(TD, 'text-muted')}>
                      <p className="max-w-44 truncate">{j.location ?? 'Not listed'}</p>
                      {j.remote !== 'unknown' && <p className="text-xs capitalize text-faint">{j.remote}</p>}
                    </td>
                    <td className={clsx(TD, 'whitespace-nowrap text-muted')}>{formatSalary(j) || <span className="text-faint">Not listed</span>}</td>
                    <td className={clsx(TD, 'whitespace-nowrap text-muted')}>{SOURCE_LABELS[j.source]}</td>
                    <td className={clsx(TD, 'text-right tabular-nums text-muted')}>{shortAge(j.postedAt ?? j.discoveredAt)}</td>
                    <td className={clsx(TD, 'text-right tabular-nums text-muted')}>{j.prescore ?? '-'}</td>
                    <td className={TD} onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        {j.applicationId && j.stage === 'ready' && (
                          <Button size="sm" variant="primary" onClick={() => navigate(`/review/${j.applicationId}`)}>
                            Review
                          </Button>
                        )}
                        {canPrepare && (
                          <Button size="sm" variant={j.stage === 'shortlisted' ? 'primary' : 'secondary'} loading={busy} icon={<FileEdit size={13} />} onClick={() => void prepare(j)}>
                            Prepare
                          </Button>
                        )}
                        {(j.stage === 'dismissed' || j.stage === 'scored' || j.stage === 'filtered_out' || j.stage === 'prescored_out') && (
                          <Button size="sm" disabled={busy} icon={<RotateCcw size={13} />} onClick={() => void restore(j)}>
                            Restore
                          </Button>
                        )}
                        {j.stage !== 'dismissed' && j.stage !== 'applied' && (
                          <IconButton label="Dismiss" disabled={busy} onClick={() => setDismissing([j])}>
                            <X size={15} />
                          </IconButton>
                        )}
                        {j.stage === 'applied' && <Badge tone="good">Applied</Badge>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-faint">
            <span>
              Showing {items.length} of {list.data.total}
            </span>
            {list.data.total > items.length && (
              <Button size="sm" onClick={() => setLimit(limit + PAGE)}>
                Show more
              </Button>
            )}
          </div>
        </div>
      )}

      {dismissing && (
        <DismissDialog
          subject={dismissing.length === 1 ? dismissing[0].title : plural(dismissing.length, 'job')}
          onClose={() => setDismissing(null)}
          onConfirm={(reason, tags) => dismissMany(dismissing, reason, tags)}
        />
      )}
      {addOpen && <AddJobDialog onClose={() => setAddOpen(false)} onAdded={(id) => navigate(`/jobs/${id}`)} />}
    </Page>
  )
}

function AddJobDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }): React.JSX.Element {
  const toast = useToast()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    setBusy(true)
    try {
      const job = await api.addJobByUrl(url.trim())
      toast.success(`Added ${job.title} at ${job.company}.`)
      onClose()
      onAdded(job.id)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add a job by URL"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-job-form" variant="primary" loading={busy} disabled={!/^https?:\/\//.test(url.trim())}>
            Add job
          </Button>
        </>
      }
    >
      <form
        id="add-job-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && /^https?:\/\//.test(url.trim())) void submit()
        }}
      >
        <Field label="Posting address" hint="Paste the link to a single job posting. JobPilot reads it and runs it through the free filters.">
          <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://boards.greenhouse.io/company/jobs/123456" />
        </Field>
      </form>
    </Modal>
  )
}
