import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, Check, ExternalLink, FileEdit, Gauge, RotateCcw, Star, TriangleAlert, X } from 'lucide-react'
import type { Job } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { REMOTE_LABELS, SOURCE_LABELS, formatDate, formatSalary, relativeTime } from '@renderer/lib/format'
import { FitBadge, StageBadge, StatusBadge } from '@renderer/components/badges'
import { DismissDialog } from '@renderer/components/DismissDialog'
import { Badge, Button, Card, CardHeader, Chip, ErrorBlock, Loading, Notice, Page, ProgressBar } from '@renderer/components/ui'

function Meta({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-fg">{children}</dd>
    </div>
  )
}

function PointList({ items, icon, tone, empty }: { items: string[]; icon: React.ReactNode; tone: string; empty: string }): React.JSX.Element {
  if (items.length === 0) return <p className="text-sm text-faint">{empty}</p>
  return (
    <ul className="space-y-1.5">
      {items.map((m) => (
        <li key={m} className="flex items-start gap-2 text-sm text-fg">
          <span className={`mt-0.5 shrink-0 ${tone}`}>{icon}</span>
          {m}
        </li>
      ))}
    </ul>
  )
}

export function JobDetail(): React.JSX.Element {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const job = useAsync(() => api.getJob(id), [id], ['jobs:changed'])
  const app = useAsync(() => api.getApplicationForJob(id), [id], ['applications:changed'])
  const events = useAsync(() => api.listEvents({ limit: 30, jobId: id }), [id], ['event:new'])
  const [busy, setBusy] = useState<'score' | 'prepare' | 'restore' | null>(null)
  const [dismissOpen, setDismissOpen] = useState(false)

  if (job.error) {
    return (
      <Page>
        <ErrorBlock message={job.error} onRetry={job.reload} />
      </Page>
    )
  }
  if (!job.data && job.loading) return <Loading />
  const j: Job | null = job.data
  if (!j) {
    return (
      <Page>
        <p className="mb-3 text-sm text-muted">That job no longer exists.</p>
        <Link to="/jobs" className="text-sm text-accent-strong">
          Back to jobs
        </Link>
      </Page>
    )
  }

  async function run(kind: 'score' | 'prepare' | 'restore', fn: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(kind)
    try {
      await fn()
      toast.success(done)
      job.reload()
      app.reload()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const fit = j.fit
  const inactive = j.stage === 'dismissed' || j.stage === 'applied'

  return (
    <Page>
      <button onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> Back
      </button>

      <div className="mb-5 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{j.title}</h1>
            <button aria-label={j.starred ? 'Remove star' : 'Star'} title={j.starred ? 'Remove star' : 'Star'} onClick={() => void api.starJob(j.id, !j.starred).then(job.reload, toast.error)} className={j.starred ? 'text-warn' : 'text-faint hover:text-fg'}>
              <Star size={16} className={j.starred ? 'fill-current' : ''} />
            </button>
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {j.company}
            {j.location ? `, ${j.location}` : ''}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <FitBadge bucket={j.fitBucket} score={j.fitScore} />
            <StageBadge stage={j.stage} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button icon={<ExternalLink size={14} />} onClick={() => void api.openExternal(j.url).catch(toast.error)}>
            Open posting
          </Button>
          <Button icon={<Gauge size={14} />} loading={busy === 'score'} onClick={() => void run('score', () => api.scoreJob(j.id), 'Scored.')}>
            {j.fit || j.triageFailures >= 3 ? 'Score again' : 'Score now'}
          </Button>
          {app.data ? (
            <Button variant="primary" onClick={() => navigate(app.data?.status === 'submitted' ? '/applications' : `/review/${app.data?.id}`)}>
              {app.data.status === 'submitted' ? 'View application' : 'Open in review queue'}
            </Button>
          ) : (
            !inactive && (
              <Button variant="primary" icon={<FileEdit size={14} />} loading={busy === 'prepare'} onClick={() => void run('prepare', () => api.prepareApplication(j.id), 'Application drafted. It is in the review queue.')}>
                Prepare application
              </Button>
            )
          )}
          {j.stage === 'dismissed' || j.stage === 'scored' || j.stage === 'filtered_out' || j.stage === 'prescored_out' ? (
            <Button icon={<RotateCcw size={14} />} loading={busy === 'restore'} onClick={() => void run('restore', () => api.restoreJob(j.id), 'Restored.')}>
              Restore
            </Button>
          ) : (
            !inactive && (
              <Button variant="danger" icon={<X size={14} />} onClick={() => setDismissOpen(true)}>
                Dismiss
              </Button>
            )
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          <Card>
            <CardHeader title="Fit" hint={fit ? `${fit.seniorityFit === 'match' ? 'Seniority matches.' : fit.seniorityFit === 'over' ? 'The role is above your level.' : fit.seniorityFit === 'under' ? 'The role is below your level.' : 'Seniority is unclear.'}` : undefined} />
            <div className="space-y-4 p-4">
              {j.triageFailures >= 3 && (
                <Notice tone="warn" title="Scoring failed three times">
                  Runs skip this job until it scores. Press Score again to retry it.
                </Notice>
              )}
              {fit ? (
                <>
                  <p className="text-sm leading-relaxed text-fg">{fit.summary}</p>
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">Matches</p>
                      <PointList items={fit.matches} icon={<Check size={14} />} tone="text-good" empty="No clear matches listed." />
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">Gaps</p>
                      <PointList items={fit.gaps} icon={<TriangleAlert size={14} />} tone="text-warn" empty="No gaps found." />
                    </div>
                  </div>
                  {fit.dealbreakers.length > 0 && (
                    <div className="rounded-md border border-bad/40 bg-bad-soft p-3">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-bad">Dealbreakers</p>
                      <PointList items={fit.dealbreakers} icon={<X size={14} />} tone="text-bad" empty="" />
                    </div>
                  )}
                  {fit.keywords.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">Keywords to echo in your application</p>
                      <div className="flex flex-wrap gap-1.5">
                        {fit.keywords.map((k) => (
                          <Chip key={k}>{k}</Chip>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted">This job has not been scored. {j.filterReason ? 'It was stopped by a free filter, so no tokens were spent.' : `Press ${j.triageFailures >= 3 ? 'Score again' : 'Score now'} to have the AI judge the fit.`}</p>
              )}
              {(j.prescore != null || j.filterReason) && (
                <div className="border-t border-line pt-4">
                  <div className="flex items-center gap-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-faint">Keyword prescore</p>
                    {j.prescore != null && <span className="text-sm tabular-nums text-fg">{j.prescore} of 100</span>}
                  </div>
                  {j.prescore != null && (
                    <div className="mt-2 w-48">
                      <ProgressBar value={j.prescore / 100} />
                    </div>
                  )}
                  {j.filterReason && <p className="mt-2 text-sm text-muted">{j.filterReason}</p>}
                </div>
              )}
              {j.stage === 'dismissed' && (
                <div className="border-t border-line pt-4">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">You dismissed this job</p>
                  <div className="flex flex-wrap gap-1.5">
                    {j.dismissTags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                  {j.dismissReason && <p className="mt-2 text-sm text-muted">{j.dismissReason}</p>}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Job description" />
            <div className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap p-4 text-sm leading-relaxed text-muted">{j.description || 'The posting has no description.'}</div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y divide-line px-4 py-1">
              <Meta label="Company">{j.company}</Meta>
              <Meta label="Location">{j.location ?? 'Not listed'}</Meta>
              <Meta label="Work style">{REMOTE_LABELS[j.remote]}</Meta>
              <Meta label="Pay">{formatSalary(j) || 'Not listed'}</Meta>
              <Meta label="Type">{j.employmentType ?? 'Not listed'}</Meta>
              <Meta label="Source">{SOURCE_LABELS[j.source]}</Meta>
              <Meta label="Posted">{formatDate(j.postedAt)}</Meta>
              <Meta label="Found">{relativeTime(j.discoveredAt)}</Meta>
            </dl>
          </Card>

          {app.data && (
            <Card>
              <CardHeader title="Application" />
              <div className="space-y-2 p-4 text-sm">
                <div className="flex items-center gap-2">
                  <StatusBadge status={app.data.status} />
                  {app.data.flaggedCount > 0 && <Badge tone="warn">{app.data.flaggedCount} to fill</Badge>}
                </div>
                <p className="text-muted">{app.data.submittedAt ? `Submitted ${relativeTime(app.data.submittedAt)}.` : `Drafted ${relativeTime(app.data.createdAt)}.`}</p>
                <Button size="sm" onClick={() => navigate(app.data?.status === 'submitted' ? '/applications' : `/review/${app.data?.id}`)}>
                  {app.data.status === 'submitted' ? 'Open tracker' : 'Open in review queue'}
                </Button>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="History" />
            {!events.data || events.data.length === 0 ? (
              <p className="p-4 text-sm text-muted">Nothing has happened with this job yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {events.data.map((e) => (
                  <li key={e.id} className="px-4 py-2">
                    <p className="text-sm text-fg">{e.message}</p>
                    <p className="text-xs text-faint">{relativeTime(e.at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {dismissOpen && (
        <DismissDialog
          subject={j.title}
          onClose={() => setDismissOpen(false)}
          onConfirm={async (reason, tags) => {
            try {
              await api.dismissJob(j.id, reason, tags)
              toast.success('Dismissed.')
              job.reload()
            } catch (e) {
              toast.error(e)
              throw e
            }
          }}
        />
      )}
    </Page>
  )
}
