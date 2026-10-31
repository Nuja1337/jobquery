import { useState } from 'react'
import { Ban, Building2, ExternalLink, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { AtsDetection, Company, SavedSearch } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { SOURCE_LABELS, relativeTime } from '@renderer/lib/format'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBlock, Field, IconButton, Input, Loading, Modal, Page, PageHeader, Select, TD, TH, Toggle } from '@renderer/components/ui'

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
    <Page>
      <PageHeader title="Sources" intro="Where JobPilot looks for jobs." />
      <Companies />
      <Searches />
    </Page>
  )
}

export function Companies(): React.JSX.Element {
  const toast = useToast()
  const list = useAsync(() => api.listCompanies(), [])
  const [url, setUrl] = useState('')
  const [checking, setChecking] = useState(false)
  const [detected, setDetected] = useState<(AtsDetection & { url: string; name: string }) | null>(null)
  const [saving, setSaving] = useState(false)
  const [blockName, setBlockName] = useState('')
  const [deleting, setDeleting] = useState<Company | null>(null)

  async function check(): Promise<void> {
    setChecking(true)
    setDetected(null)
    try {
      const d = await api.detectAts(url.trim())
      if (!d) toast.error(new Error('That does not look like a web address.'))
      else setDetected({ ...d, url: url.trim(), name: d.companyName ?? '' })
    } catch (e) {
      toast.error(e)
    } finally {
      setChecking(false)
    }
  }

  async function saveDetected(): Promise<void> {
    if (!detected) return
    setSaving(true)
    try {
      await api.saveCompany({ name: detected.name.trim() || undefined, careersUrl: detected.url, ats: detected.ats, atsToken: detected.token ?? undefined, watch: true })
      toast.success(`Watching ${detected.name || 'the company'}.`)
      setDetected(null)
      setUrl('')
      list.reload()
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }

  async function patch(c: Company, change: { watch?: boolean; blocked?: boolean }): Promise<void> {
    try {
      // A blocked company is never watched.
      await api.saveCompany({ id: c.id, ...change, ...(change.blocked ? { watch: false } : {}) })
      list.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  async function block(): Promise<void> {
    try {
      await api.saveCompany({ name: blockName.trim(), blocked: true, watch: false })
      toast.success(`Blocked ${blockName.trim()}.`)
      setBlockName('')
      list.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader title="Companies" hint="Watched companies have their job boards checked on every run. Blocked ones are never shown." />
      <div className="space-y-3 border-b border-line p-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (url.trim()) void check()
          }}
        >
          <Field label="Careers page address" className="flex-1" hint="Paste a link to a company job board. Greenhouse, Lever, Ashby and others are recognised.">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://boards.greenhouse.io/company" />
          </Field>
          <Button type="submit" loading={checking} disabled={!url.trim()} icon={<Search size={14} />} className="mb-[1.35rem]">
            Check
          </Button>
        </form>
        {detected && (
          <div className="rounded-lg border border-line bg-bg p-3">
            {detected.ats === 'unknown' ? (
              <p className="mb-3 text-sm text-warn">JobPilot could not recognise this job board. You can still save it, but it will not be checked automatically.</p>
            ) : (
              <p className="mb-3 text-sm text-good">
                Recognised a {SOURCE_LABELS[detected.ats as keyof typeof SOURCE_LABELS] ?? detected.ats} job board{detected.token ? ` (${detected.token})` : ''}.
              </p>
            )}
            <div className="flex items-end gap-2">
              <Field label="Company name" className="flex-1">
                <Input value={detected.name} onChange={(e) => setDetected({ ...detected, name: e.target.value })} />
              </Field>
              <Button variant="primary" loading={saving} disabled={!detected.name.trim()} onClick={() => void saveDetected()} icon={<Plus size={14} />}>
                Watch this company
              </Button>
              <Button variant="ghost" onClick={() => setDetected(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (blockName.trim()) void block()
          }}
        >
          <Input value={blockName} onChange={(e) => setBlockName(e.target.value)} placeholder="Block a company by name" aria-label="Company to block" className="max-w-xs" />
          <Button type="submit" icon={<Ban size={14} />} disabled={!blockName.trim()}>
            Block
          </Button>
        </form>
      </div>

      {list.error ? (
        <div className="p-4">
          <ErrorBlock message={list.error} onRetry={list.reload} />
        </div>
      ) : !list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={<Building2 size={22} />} title="No companies yet" text="Paste the careers page of a company you would like to work for. JobPilot checks it on every run." />
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={TH}>Company</th>
              <th className={TH}>Job board</th>
              <th className={TH}>Watch</th>
              <th className={TH}>Blocked</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id}>
                <td className={TD}>
                  <p className="font-medium text-fg">{c.name}</p>
                  {c.careersUrl && (
                    <button onClick={() => void api.openExternal(c.careersUrl as string).catch(toast.error)} className="flex items-center gap-1 text-xs text-faint hover:text-accent-strong">
                      <span className="max-w-72 truncate">{c.careersUrl}</span> <ExternalLink size={11} />
                    </button>
                  )}
                </td>
                <td className={TD}>{c.ats === 'unknown' ? <Badge>Not recognised</Badge> : <Badge tone="info">{SOURCE_LABELS[c.ats as keyof typeof SOURCE_LABELS] ?? c.ats}</Badge>}</td>
                <td className={TD}>
                  <Toggle checked={c.watch} disabled={c.blocked} onChange={(v) => void patch(c, { watch: v })} />
                </td>
                <td className={TD}>
                  <Toggle checked={c.blocked} onChange={(v) => void patch(c, { blocked: v })} />
                </td>
                <td className={`${TD} text-right`}>
                  <IconButton label={`Remove ${c.name}`} onClick={() => setDeleting(c)}>
                    <Trash2 size={15} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deleting && (
        <ConfirmDialog
          title="Remove company"
          message={`Remove ${deleting.name} from your list? Jobs already found stay where they are.`}
          confirmLabel="Remove"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteCompany(deleting.id)
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
                  <Toggle checked={s.enabled} onChange={(v) => void toggle(s, v)} />
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
