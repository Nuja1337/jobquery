import { useEffect, useState } from 'react'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { CompanyCounts } from '@shared/api'
import type { SavedSearch } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { SOURCE_LABELS, relativeTime } from '@renderer/lib/format'
import { AddBoards } from '@renderer/components/AddBoards'
import { CompanyTable, NO_FILTERS, PAGE_SIZE, type CompanyFilters } from '@renderer/components/CompanyTable'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { StartFast } from '@renderer/components/StartFast'
import { Button, Card, CardHeader, EmptyState, ErrorBlock, Field, IconButton, Input, Loading, Modal, Page, PageHeader, Select, Stat, TD, TH, Toggle } from '@renderer/components/ui'

type SearchSource = SavedSearch['source']

interface ParamSpec {
  key: string
  label: string
  placeholder?: string
  secret?: boolean
}

const SEARCH_SOURCES: Record<SearchSource, { hint: string; params: ParamSpec[] }> = {
  remotive: { hint: 'Remote jobs from Remotive.', params: [{ key: 'category', label: 'Category', placeholder: 'software-dev' }, { key: 'search', label: 'Search text', placeholder: 'frontend' }] },
  remoteok: { hint: 'Remote jobs from RemoteOK.', params: [{ key: 'tag', label: 'Tag', placeholder: 'react' }] },
  arbeitnow: { hint: 'Jobs in Europe from Arbeitnow.', params: [{ key: 'search', label: 'Search text', placeholder: 'typescript' }, { key: 'location', label: 'Location', placeholder: 'Berlin' }] },
  hn_whoishiring: { hint: 'The monthly Who is Hiring thread on Hacker News.', params: [{ key: 'query', label: 'Words to look for', placeholder: 'typescript' }] },
  himalayas: { hint: 'Remote jobs from Himalayas, refreshed daily.', params: [{ key: 'query', label: 'Words to look for', placeholder: 'game engineer' }] },
  jobicy: { hint: 'Remote jobs from Jobicy, the last seven days.', params: [{ key: 'tag', label: 'Search text', placeholder: 'unity' }, { key: 'geo', label: 'Region', placeholder: 'usa' }] },
  themuse: { hint: 'Jobs from The Muse. Each one links to the application on the company site.', params: [{ key: 'category', label: 'Category', placeholder: 'Software Engineering' }, { key: 'level', label: 'Level', placeholder: 'Mid Level' }, { key: 'location', label: 'Location', placeholder: 'Flexible / Remote' }] },
  weworkremotely: { hint: 'Remote jobs from We Work Remotely.', params: [{ key: 'category', label: 'Category', placeholder: 'remote-programming-jobs' }] },
  adzuna: {
    hint: 'Needs a free Adzuna developer account for the app id and key.',
    params: [
      { key: 'app_id', label: 'App id' },
      { key: 'app_key', label: 'App key', secret: true },
      { key: 'country', label: 'Country code', placeholder: 'gb' },
      { key: 'what', label: 'Job title or keywords', placeholder: 'frontend engineer' },
      { key: 'where', label: 'Place', placeholder: 'London' }
    ]
  }
}

export function Sources(): React.JSX.Element {
  return (
    <Page wide>
      <PageHeader title="Sources" intro="Where jobpls looks for jobs." />
      <Companies />
      <Searches />
    </Page>
  )
}

const n = (v: number): string => v.toLocaleString('en-US')

export function Companies(): React.JSX.Element {
  const [filters, setFilters] = useState<CompanyFilters>(NO_FILTERS)
  const [pageNumber, setPageNumber] = useState(1)
  const list = useAsync(
    () => api.listCompanies({ page: pageNumber, pageSize: PAGE_SIZE, search: filters.search || undefined, ats: filters.ats, origin: filters.origin, state: filters.state }),
    [pageNumber, filters.search, filters.ats, filters.origin, filters.state],
    ['pipeline:progress']
  )
  const counts = list.data?.counts

  // The last page can disappear when companies are removed. Go back to the one before it.
  const total = list.data?.total
  useEffect(() => {
    if (total !== undefined && pageNumber > 1 && (pageNumber - 1) * PAGE_SIZE >= total) setPageNumber(Math.max(1, Math.ceil(total / PAGE_SIZE)))
  }, [total, pageNumber])

  return (
    <div className="mb-6">
      {counts && <Summary counts={counts} />}
      <StartFast compact={(counts?.total ?? 0) > 0} onAdded={list.reload} />
      <AddBoards onAdded={list.reload} />
      <Card>
        <CardHeader title="Companies" hint="Every board jobpls knows about. Turn Watch on to check a board on each run." />
        <CompanyTable
          page={list.data}
          error={list.error}
          pageNumber={pageNumber}
          filters={filters}
          onFilters={(next) => {
            setFilters(next)
            setPageNumber(1)
          }}
          onPage={setPageNumber}
          onChanged={list.reload}
        />
      </Card>
    </div>
  )
}

/** When the soonest board is checked, as a short phrase. */
function soonest(iso: string | null): string {
  if (!iso) return 'None'
  return Date.parse(iso) <= Date.now() ? 'Due now' : relativeTime(iso)
}

function Summary({ counts }: { counts: CompanyCounts }): React.JSX.Element {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Watched boards" value={n(counts.watched)} hint={counts.failing > 0 ? `${n(counts.failing)} failing` : undefined} />
      <Stat label="Found from postings" value={n(counts.fromPostings)} />
      <Stat label="Stopped after failures" value={n(counts.stopped)} tone={counts.stopped > 0 ? 'bad' : undefined} />
      <Stat label="Live postings" value={n(counts.liveJobs)} />
      <Stat label="Postings that fit" value={n(counts.relevantJobs)} tone={counts.relevantJobs > 0 ? 'good' : undefined} />
      <Stat label="Next check" value={soonest(counts.nextCheckAt)} />
    </div>
  )
}

function summarize(s: SavedSearch): string {
  const spec = SEARCH_SOURCES[s.source].params
  return spec
    .filter((p) => !p.secret && s.params[p.key])
    .map((p) => `${p.label.toLowerCase()}: ${s.params[p.key]}`)
    .join(', ')
}

export function Searches(): React.JSX.Element {
  const toast = useToast()
  const list = useAsync(() => api.listSearches(), [])
  const [editing, setEditing] = useState<SavedSearch | 'new' | null>(null)
  const [deleting, setDeleting] = useState<SavedSearch | null>(null)

  async function toggle(s: SavedSearch, enabled: boolean): Promise<void> {
    try {
      await api.saveSearch({ id: s.id, source: s.source, label: s.label, params: s.params, enabled })
      list.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Saved searches"
        hint="Job sites that list many companies. Each search runs on every run."
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing('new')}>
            Add search
          </Button>
        }
      />
      {list.error ? (
        <div className="p-4">
          <ErrorBlock message={list.error} onRetry={list.reload} />
        </div>
      ) : !list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={<Search size={22} />} title="No saved searches" text="Add a search for Remotive, RemoteOK, Arbeitnow, Hacker News or Adzuna to find jobs beyond your watched companies." />
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={TH}>Search</th>
              <th className={TH}>Source</th>
              <th className={TH}>Last run</th>
              <th className={TH}>On</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.id}>
                <td className={TD}>
                  <p className="font-medium text-fg">{s.label}</p>
                  <p className="text-xs text-faint">{summarize(s) || 'No parameters'}</p>
                </td>
                <td className={`${TD} text-muted`}>{SOURCE_LABELS[s.source]}</td>
                <td className={`${TD} text-muted`}>{relativeTime(s.lastRunAt)}</td>
                <td className={TD}>
                  <Toggle ariaLabel={`Run ${s.label}`} checked={s.enabled} onChange={(v) => void toggle(s, v)} />
                </td>
                <td className={`${TD} text-right`}>
                  <IconButton label={`Edit ${s.label}`} onClick={() => setEditing(s)}>
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton label={`Delete ${s.label}`} onClick={() => setDeleting(s)}>
                    <Trash2 size={15} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <SearchDialog
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            list.reload()
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete search"
          message={`Delete ${deleting.label}? Jobs already found stay where they are.`}
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteSearch(deleting.id)
              list.reload()
            } catch (e) {
              toast.error(e)
              throw e
            }
          }}
        />
      )}
    </Card>
  )
}

function SearchDialog({ initial, onClose, onSaved }: { initial: SavedSearch | null; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const toast = useToast()
  const [source, setSource] = useState<SearchSource>(initial?.source ?? 'remotive')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [params, setParams] = useState<Record<string, string>>(initial?.params ?? {})
  const [busy, setBusy] = useState(false)
  const spec = SEARCH_SOURCES[source]
  const missingAdzuna = source === 'adzuna' && (!params.app_id || !params.app_key)

  async function save(): Promise<void> {
    setBusy(true)
    try {
      const clean = Object.fromEntries(spec.params.map((p) => [p.key, (params[p.key] ?? '').trim()]).filter(([, v]) => v))
      await api.saveSearch({ id: initial?.id, source, label: label.trim() || SOURCE_LABELS[source], params: clean, enabled: initial?.enabled ?? true })
      toast.success('Saved.')
      onSaved()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={initial ? 'Edit search' : 'Add a search'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={missingAdzuna} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Source" hint={spec.hint}>
          <Select value={source} disabled={!!initial} onChange={(e) => { setSource(e.target.value as SearchSource); setParams({}) }}>
            {(Object.keys(SEARCH_SOURCES) as SearchSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" hint="Optional. Helps you tell searches apart.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={SOURCE_LABELS[source]} />
        </Field>
        {spec.params.map((p) => (
          <Field key={p.key} label={p.label}>
            <Input type={p.secret ? 'password' : 'text'} autoComplete="off" value={params[p.key] ?? ''} placeholder={p.placeholder} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} />
          </Field>
        ))}
      </div>
    </Modal>
  )
}
