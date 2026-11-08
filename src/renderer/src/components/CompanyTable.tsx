import { useEffect, useState } from 'react'
import { Building2, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import type { BulkCompanyAction, CompanyPage, CompanyStateFilter, CompanyWithBoard } from '@shared/api'
import { STOP_AFTER_FAILURES, boardUrl } from '@shared/sources'
import type { AtsKind, CompanyOrigin } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useDebounced } from '@renderer/lib/hooks'
import { plural, relativeTime } from '@renderer/lib/format'
import { useToast } from '@renderer/lib/toast'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { ATS_FILTER, ORIGIN_LABELS, atsLabel } from '@renderer/components/companyLabels'
import { RowMenu } from '@renderer/components/RowMenu'
import { Badge, Button, EmptyState, ErrorBlock, Input, Loading, Select, TD, TH, Toggle, type Tone } from '@renderer/components/ui'

export const PAGE_SIZE = 50

export interface CompanyFilters {
  search: string
  ats: AtsKind | 'all'
  origin: CompanyOrigin | 'all'
  state: CompanyStateFilter
}

export const NO_FILTERS: CompanyFilters = { search: '', ats: 'all', origin: 'all', state: 'all' }

const STATE_LABELS: Record<CompanyStateFilter, string> = {
  all: 'Any state',
  watched: 'Watched',
  unwatched: 'Not watched',
  blocked: 'Blocked',
  stopped: 'Stopped after failures',
  failing: 'Failing'
}

const n = (v: number): string => v.toLocaleString('en-US')

/** When the board is checked next, for a board the app can read. */
function nextCheck(c: CompanyWithBoard): string {
  if (!c.watch || c.blocked || !c.atsToken || c.ats === 'unknown' || !c.nextCheckAt) return '-'
  return Date.parse(c.nextCheckAt) <= Date.now() ? 'due now' : relativeTime(c.nextCheckAt)
}

function status(c: CompanyWithBoard): { tone: Tone; text: string; title?: string } {
  if (c.blocked) return { tone: 'neutral', text: 'Blocked' }
  if (!c.watch && c.failures >= STOP_AFTER_FAILURES) return { tone: 'bad', text: 'Stopped', title: c.lastError ?? undefined }
  if (c.failures > 0) return { tone: 'warn', text: plural(c.failures, 'failure'), title: c.lastError ?? undefined }
  if (!c.atsToken || c.ats === 'unknown') return { tone: 'neutral', text: 'Manual', title: 'JobPilot cannot read this board, so it is not checked.' }
  if (!c.watch) return { tone: 'neutral', text: 'Off' }
  return c.lastCheckedAt ? { tone: 'good', text: 'OK' } : { tone: 'neutral', text: 'Waiting', title: 'This board has not been checked yet.' }
}

interface Props {
  page: CompanyPage | null
  error: string | null
  pageNumber: number
  filters: CompanyFilters
  onFilters: (filters: CompanyFilters) => void
  onPage: (page: number) => void
  /** Called after a change, so the page can load again. */
  onChanged: () => void
}

export function CompanyTable({ page, error, pageNumber, filters, onFilters, onPage, onChanged }: Props): React.JSX.Element {
  const toast = useToast()
  const [searchText, setSearchText] = useState(filters.search)
  const debouncedSearch = useDebounced(searchText, 250)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<CompanyWithBoard[] | null>(null)

  useEffect(() => {
    if (debouncedSearch.trim() !== filters.search) onFilters({ ...filters, search: debouncedSearch.trim() })
  }, [debouncedSearch]) // eslint-disable-line react-hooks/exhaustive-deps

  // A different page or filter shows different rows, so the selection starts over.
  const filterKey = `${filters.search}|${filters.ats}|${filters.origin}|${filters.state}|${pageNumber}`
  useEffect(() => setSelected(new Set()), [filterKey])

  const items = page?.items ?? []
  const total = page?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const rows = items.filter((c) => selected.has(c.id))
  const allSelected = items.length > 0 && rows.length === items.length
  const filtered = filters.search !== '' || filters.ats !== 'all' || filters.origin !== 'all' || filters.state !== 'all'

  async function run(task: () => Promise<unknown>, done?: string): Promise<void> {
    setBusy(true)
    try {
      await task()
      if (done) toast.success(done)
      onChanged()
    } catch (e) {
      toast.error(e)
      throw e
    } finally {
      setBusy(false)
    }
  }

  const bulk = (action: BulkCompanyAction, people: CompanyWithBoard[]) =>
    run(async () => {
      await api.bulkCompanies({ ids: people.map((c) => c.id), action })
      setSelected(new Set())
    }).catch(() => undefined)

  const one = (c: CompanyWithBoard, change: { watch?: boolean; blocked?: boolean }) =>
    // A blocked company is never watched.
    run(() => api.saveCompany({ id: c.id, ...change, ...(change.blocked ? { watch: false } : {}) })).catch(() => undefined)

  function openCareers(c: CompanyWithBoard): void {
    const url = c.careersUrl ?? boardUrl(c.ats, c.atsToken)
    if (url) void api.openExternal(url).catch(toast.error)
  }

  const set = (patch: Partial<CompanyFilters>): void => onFilters({ ...filters, ...patch })

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="relative min-w-48 flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-faint" />
          <Input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search by company or board name" aria-label="Search companies" className="pl-8" />
        </div>
        <Select value={filters.ats} onChange={(e) => set({ ats: e.target.value as CompanyFilters['ats'] })} className="w-40" aria-label="System">
          <option value="all">Any system</option>
          {ATS_FILTER.map((a) => (
            <option key={a} value={a}>
              {atsLabel(a)}
            </option>
          ))}
        </Select>
        <Select value={filters.origin} onChange={(e) => set({ origin: e.target.value as CompanyFilters['origin'] })} className="w-40" aria-label="Origin">
          <option value="all">Any origin</option>
          {(Object.keys(ORIGIN_LABELS) as CompanyOrigin[]).map((o) => (
            <option key={o} value={o}>
              {ORIGIN_LABELS[o]}
            </option>
          ))}
        </Select>
        <Select value={filters.state} onChange={(e) => set({ state: e.target.value as CompanyStateFilter })} className="w-48" aria-label="State">
          {(Object.keys(STATE_LABELS) as CompanyStateFilter[]).map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
            </option>
          ))}
        </Select>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => {
              setSearchText('')
              onFilters(NO_FILTERS)
            }}>
            Clear filters
          </Button>
        )}
      </div>

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-2" role="toolbar" aria-label="Actions for selected companies">
          <span className="mr-1 text-sm font-medium text-fg">{n(rows.length)} selected</span>
          <Button size="sm" disabled={busy} onClick={() => void bulk('watch', rows)}>
            Watch
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void bulk('unwatch', rows)}>
            Unwatch
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void bulk('block', rows)}>
            Block
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleting(rows)}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {error ? (
        <div className="p-4">
          <ErrorBlock message={error} onRetry={onChanged} />
        </div>
      ) : !page ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="p-4">
          {filtered ? (
            <EmptyState icon={<Search size={22} />} title="No companies match" text="Change the search or the filters to see more." />
          ) : (
            <EmptyState icon={<Building2 size={22} />} title="No boards yet" text="Use Start fast above, paste a list of careers links, or add one careers page. JobPilot checks every watched board on each run." />
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={`${TH} w-8`}>
                  <input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((c) => c.id)) : new Set())} />
                </th>
                <th className={TH}>Name</th>
                <th className={TH}>System</th>
                <th className={TH}>Origin</th>
                <th className={TH}>Watch</th>
                <th className={`${TH} text-right`} title="Open postings on the board">Postings</th>
                <th className={`${TH} text-right`} title="Postings that are shortlisted or further">Fits</th>
                <th className={TH}>Last checked</th>
                <th className={TH}>Next check</th>
                <th className={TH}>Status</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const s = status(c)
                return (
                  <tr key={c.id} className={selected.has(c.id) ? 'bg-accent-soft/40' : undefined}>
                    <td className={TD}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.name}`}
                        checked={selected.has(c.id)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(c.id)
                            else next.delete(c.id)
                            return next
                          })
                        }
                      />
                    </td>
                    <td className={TD}>
                      <p className="max-w-64 truncate font-medium text-fg" title={c.name}>
                        {c.name}
                      </p>
                      {c.lastError && c.failures > 0 && (
                        <p className="max-w-64 truncate text-xs text-bad" title={c.lastError}>
                          {c.lastError}
                        </p>
                      )}
                    </td>
                    <td className={TD}>{c.ats === 'unknown' ? <Badge>Not recognized</Badge> : <Badge tone="info">{atsLabel(c.ats)}</Badge>}</td>
                    <td className={`${TD} whitespace-nowrap text-muted`}>{ORIGIN_LABELS[c.origin]}</td>
                    <td className={TD}>
                      <Toggle ariaLabel={`Watch ${c.name}`} checked={c.watch} disabled={c.blocked || busy} onChange={(v) => void one(c, { watch: v })} />
                    </td>
                    <td className={`${TD} text-right tabular-nums text-muted`}>{c.lastCheckedAt ? n(c.liveJobs) : '-'}</td>
                    <td className={`${TD} text-right tabular-nums text-muted`}>{c.lastCheckedAt ? n(c.relevantJobs) : '-'}</td>
                    <td className={`${TD} whitespace-nowrap text-muted`}>{relativeTime(c.lastCheckedAt)}</td>
                    <td className={`${TD} whitespace-nowrap text-muted`}>{nextCheck(c)}</td>
                    <td className={TD}>
                      <Badge tone={s.tone} title={s.title}>
                        {s.text}
                      </Badge>
                    </td>
                    <td className={`${TD} text-right`}>
                      <RowMenu
                        label={`Actions for ${c.name}`}
                        items={[
                          { label: 'Open careers page', onSelect: () => openCareers(c), disabled: !c.careersUrl && !boardUrl(c.ats, c.atsToken) },
                          c.blocked ? { label: 'Unblock', onSelect: () => void one(c, { blocked: false }) } : { label: 'Block', onSelect: () => void one(c, { blocked: true }) },
                          { label: 'Delete', danger: true, onSelect: () => setDeleting([c]) }
                        ]}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {page && total > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-muted">
          <span>
            {n((pageNumber - 1) * PAGE_SIZE + 1)} to {n(Math.min(pageNumber * PAGE_SIZE, total))} of {n(total)}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" icon={<ChevronLeft size={13} />} disabled={pageNumber <= 1} onClick={() => onPage(pageNumber - 1)}>
              Previous
            </Button>
            <span className="tabular-nums">
              Page {n(pageNumber)} of {n(pages)}
            </span>
            <Button size="sm" disabled={pageNumber >= pages} onClick={() => onPage(pageNumber + 1)}>
              Next
              <ChevronRight size={13} />
            </Button>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="Remove companies"
          message={
            deleting.length === 1
              ? `Remove ${deleting[0].name} from your list? Jobs already found stay where they are.`
              : `Remove ${n(deleting.length)} companies from your list? Jobs already found stay where they are.`
          }
          confirmLabel="Remove"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await run(async () => {
              await api.bulkCompanies({ ids: deleting.map((c) => c.id), action: 'delete' })
              setSelected(new Set())
            })
          }}
        />
      )}
    </>
  )
}
