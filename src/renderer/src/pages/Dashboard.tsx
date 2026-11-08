import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Activity, AlertTriangle, Check, Lightbulb, Pause, Play, X } from 'lucide-react'
import { BUCKET_LABELS } from '@shared/defaults'
import type { EventType, FitBucket, JobStage, LoopStatus, WorkerName, WorkerStatus } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { formatPercent, formatUsd, plural, relativeTime } from '@renderer/lib/format'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBlock, Loading, Notice, Page, PageHeader, Stat, Toggle, type Tone } from '@renderer/components/ui'
import { autopilotConfirmMessage } from '@renderer/lib/autopilot'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { BoardHealth, QuotaCard, SendsPerHour, VolumeFunnel, WaitingOnYou } from '@renderer/components/VolumeFunnel'

/** How often the counts refresh while the page is open. In continuous mode events arrive all the time, so waiting for a quiet moment would never refresh. */
const REFRESH_MS = 15_000
const BUCKETS: FitBucket[] = ['perfect', 'great', 'good']
const BUCKET_COLOR: Record<FitBucket, string> = { perfect: 'text-good', great: 'text-info', good: 'text-accent-strong', weak: 'text-muted' }

const EVENT_TONE: Partial<Record<EventType, Tone>> = {
  submitted: 'good',
  shortlisted: 'accent',
  prepared: 'info',
  submit_failed: 'bad',
  error: 'bad',
  budget_stop: 'warn',
  rate_limit_stop: 'warn',
  outcome: 'accent'
}
const EVENT_LABEL: Record<EventType, string> = {
  discovered: 'Found',
  filtered: 'Filtered',
  scored: 'Scored',
  shortlisted: 'Shortlisted',
  dismissed: 'Dismissed',
  restored: 'Restored',
  prepared: 'Prepared',
  submitted: 'Submitted',
  submit_failed: 'Failed',
  outcome: 'Outcome',
  run_started: 'Run',
  run_finished: 'Run',
  budget_stop: 'Budget',
  rate_limit_stop: 'Limit',
  error: 'Error'
}

const WORKER_LABEL: Record<WorkerName, string> = { discover: 'Finding jobs', score: 'Scoring', prepare: 'Preparing', submit: 'Sending' }
const WORKER_ORDER: WorkerName[] = ['discover', 'score', 'prepare', 'submit']
const STATE_LABEL: Record<WorkerStatus['state'], string> = { idle: 'Waiting for work', working: 'Working', paused: 'Paused', off: 'Off' }
const STATE_TONE: Record<WorkerStatus['state'], Tone> = { idle: 'neutral', working: 'accent', paused: 'warn', off: 'neutral' }

/** "09:00" for a time today, "Sun 09:00" for another day. */
function untilLabel(iso: string): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

/** Continuous mode: what each of the four workers is doing, why one waits, and today's counts. */
function WorkingNow({ status, onPause, onResume }: { status: LoopStatus; onPause: (name: WorkerName) => void; onResume: (name: WorkerName) => void }): React.JSX.Element {
  const { today } = status
  return (
    <Card className="mb-4">
      <CardHeader
        title="Working now"
        hint={`Today: ${plural(today.discovered, 'job')} found, ${today.scored.toLocaleString('en-US')} scored, ${plural(today.prepared, 'application')} prepared, ${today.submitted} sent, ${plural(today.errors, 'error')}.`}
        actions={<Badge tone={status.running ? 'good' : 'neutral'}>{status.running ? 'Running continuously' : 'Stopped'}</Badge>}
      />
      <ul className="divide-y divide-line">
        {WORKER_ORDER.map((name) => {
          const w = status.workers[name]
          return (
            <li key={name} className="flex items-center gap-3 px-4 py-2">
              <span className="w-24 shrink-0 text-sm text-fg">{WORKER_LABEL[name]}</span>
              <Badge tone={STATE_TONE[w.state]} className="w-32 shrink-0 justify-center">
                {STATE_LABEL[w.state]}
                {w.state === 'working' && w.active > 0 ? ` (${w.active})` : ''}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-sm text-muted" title={w.reason ?? undefined}>
                {w.reason ?? ''}
                {w.state === 'paused' && w.until ? `${w.reason ? ' ' : ''}Back at ${untilLabel(w.until)}.` : ''}
              </span>
              <span className="w-24 shrink-0 text-right text-xs tabular-nums text-faint">{w.doneToday.toLocaleString('en-US')} today</span>
              {w.state === 'paused' ? (
                <Button size="sm" variant="secondary" className="w-20" icon={<Play size={12} />} onClick={() => onResume(name)}>
                  Resume
                </Button>
              ) : (
                <Button size="sm" variant="ghost" className="w-20" disabled={w.state === 'off' || !status.running} icon={<Pause size={12} />} onClick={() => onPause(name)}>
                  Pause
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

export function Dashboard(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const { settings, updateSettings, usage } = useApp()

  // Every count comes from the database as a number. No list is loaded just to be counted.
  const analytics = useAsync(() => api.getAnalytics(1), [], ['applications:changed', 'jobs:changed'])
  const shortlist = useAsync(
    async () => {
      const stages: JobStage[] = ['shortlisted', 'preparing', 'ready']
      const [all, ...byBucket] = await Promise.all([api.listJobs({ stages, limit: 1 }), ...BUCKETS.map((b) => api.listJobs({ stages, buckets: [b], limit: 1 }))])
      return { total: all.total, byBucket: Object.fromEntries(BUCKETS.map((b, i) => [b, byBucket[i].total])) as Record<FitBucket, number> }
    },
    [],
    ['jobs:changed']
  )
  const runs = useAsync(() => api.listRuns(1), [], ['pipeline:progress'])
  const events = useAsync(() => api.listEvents({ limit: 12 }), [], ['event:new'])
  const suggestions = useAsync(() => api.listSuggestions(), [], ['jobs:changed'])
  const autopilotOn = settings?.autopilot.enabled ?? false
  const intervalHours = settings?.autopilot.intervalHours
  const nextRunAt = useAsync(() => api.getNextRunAt(), [autopilotOn, intervalHours], ['pipeline:progress'])
  const continuous = autopilotOn && settings?.autopilot.mode === 'continuous'
  const loop = useAsync(() => api.getLoopStatus(), [continuous], ['loop:status'])
  const [confirmAutopilot, setConfirmAutopilot] = useState(false)

  const reloadAnalytics = analytics.reload
  const reloadShortlist = shortlist.reload
  useEffect(() => {
    const timer = setInterval(() => {
      reloadAnalytics()
      reloadShortlist()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [reloadAnalytics, reloadShortlist])

  const firstError = analytics.error ?? events.error
  if (firstError) {
    return (
      <Page>
        <PageHeader title="Dashboard" />
        <ErrorBlock message={firstError} onRetry={() => [analytics, shortlist, events].forEach((s) => s.reload())} />
      </Page>
    )
  }
  if (!analytics.data || !events.data) {
    return (
      <Page>
        <PageHeader title="Dashboard" />
        <Loading />
      </Page>
    )
  }

  const report = analytics.data
  const counts = shortlist.data?.byBucket ?? { perfect: 0, great: 0, good: 0, weak: 0 }
  const shortlistTotal = shortlist.data?.total ?? 0
  const lastRun = runs.data?.[0]
  const lastRunText = lastRun ? `Last run ${relativeTime(lastRun.startedAt)}.` : 'No runs yet.'
  const nextRun = settings?.autopilot.enabled ? nextRunAt.data : null
  const autoSends = !!settings && settings.autopilot.autoSubmit && !settings.autopilot.dryRun

  async function setWorker(name: WorkerName, pause: boolean): Promise<void> {
    try {
      await (pause ? api.pauseWorker(name) : api.resumeWorker(name))
      loop.reload()
    } catch (err) {
      toast.error(err)
    }
  }
  async function applySuggestion(id: string, patch: Parameters<typeof updateSettings>[0]): Promise<void> {
    if (await updateSettings(patch)) {
      await api.dismissSuggestion(id).catch(toast.error)
      toast.success('Filter updated. Fewer jobs like that will reach the AI.')
      suggestions.reload()
    }
  }
  async function dismissSuggestion(id: string): Promise<void> {
    try {
      await api.dismissSuggestion(id)
      suggestions.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Page wide>
      <PageHeader title="Dashboard" intro="What needs you today and how the search is going." />

      {settings && !settings.onboardingDone && (
        <div className="mb-4">
          <Notice
            tone="info"
            title="Setup isn't finished"
            action={
              <Button size="sm" onClick={() => navigate('/onboarding')}>
                Open setup guide
              </Button>
            }
          >
            Finish the setup guide so jobpls has an AI provider, your profile and places to look for jobs.
          </Notice>
        </div>
      )}

      {settings?.autopilot.dryRun && (
        <div className="mb-4">
          <Notice
            tone="warn"
            action={
              <Button size="sm" onClick={() => navigate('/settings')}>
                Open Settings
              </Button>
            }
          >
            Dry run is on. Forms are filled and never sent. Turn it off in Settings when the fills look right.
          </Notice>
        </div>
      )}

      {continuous && loop.data && <WorkingNow status={loop.data} onPause={(name) => void setWorker(name, true)} onResume={(name) => void setWorker(name, false)} />}

      <VolumeFunnel analytics={report} />

      <div className="mb-4 grid grid-cols-3 gap-4">
        <WaitingOnYou totals={report.totals} onOpen={() => navigate('/review')} />
        <div className="col-span-2">
          <SendsPerHour sends={report.sendsByHour} />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-4">
        <QuotaCard quota={report.quota} usage={usage} />
        <BoardHealth boards={report.boards} onOpen={() => navigate('/sources')} />
      </div>

      {lastRun?.stats.stoppedForRateLimit && (
        <div className="mb-4">
          <Notice tone="warn" title="An AI provider's limit was reached">
            The last run paused AI work when the limit was reached. The rest continues on the next run.
          </Notice>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-4">
        <Card className="p-4">
          <p className="text-xs text-muted">Shortlist</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {BUCKETS.map((b) => (
              <button key={b} onClick={() => navigate(`/jobs?fit=${b}`)} className="rounded-md px-2 py-1.5 text-left hover:bg-hover">
                <p className={`text-2xl font-semibold tabular-nums ${BUCKET_COLOR[b]}`}>{counts[b].toLocaleString('en-US')}</p>
                <p className="text-xs text-muted">{BUCKET_LABELS[b]}</p>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-faint">{plural(shortlistTotal, 'job')} waiting for you or autopilot.</p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">Autopilot</p>
            <Badge tone={settings?.autopilot.enabled ? 'good' : 'neutral'}>{settings?.autopilot.enabled ? 'On' : 'Off'}</Badge>
          </div>
          <div className="mt-3">
            <Toggle
              checked={settings?.autopilot.enabled ?? false}
              onChange={(enabled) => {
                if (enabled && autoSends) setConfirmAutopilot(true)
                else void updateSettings({ autopilot: { enabled } })
              }}
              label={
                settings?.autopilot.enabled
                  ? settings.autopilot.mode === 'continuous'
                    ? 'Runs continuously'
                    : settings.autopilot.intervalHours === 1
                      ? 'Runs every hour'
                      : `Runs every ${settings.autopilot.intervalHours} hours`
                  : 'Runs only when you press Run now'
              }
              hint={
                settings?.autopilot.enabled
                  ? continuous
                    ? 'Keeps working all day within your limits.'
                    : nextRun
                    ? `${new Date(nextRun).getTime() <= Date.now() ? 'The next run is due now' : `Next run ${relativeTime(nextRun)}`}. ${lastRunText}`
                    : lastRunText
                  : lastRunText
              }
            />
          </div>
          {settings?.autopilot.autoSubmit && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-warn">
              <AlertTriangle size={13} /> Auto-submit is on{settings.autopilot.dryRun ? ' (dry run)' : ''}.
            </p>
          )}
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Applied this week" value={report.week.submitted.toLocaleString('en-US')} hint={`${report.totals.submitted.toLocaleString('en-US')} in total`} />
        <Stat label="Reply rate" value={report.totals.submitted ? formatPercent(report.totals.responses / report.totals.submitted) : '-'} hint={`${plural(report.totals.responses, 'reply', 'replies')} to ${plural(report.totals.submitted, 'application')}`} />
        <Stat label="Estimated spend today" value={formatUsd(usage?.todayUsd)} hint={usage ? `${usage.dailyBudgetUsd > 0 ? `Budget ${formatUsd(usage.dailyBudgetUsd)} a day` : 'No daily limit'}${usage.freeCallsToday > 0 ? `. ${plural(usage.freeCallsToday, 'free call')} today` : ''}` : undefined} tone={usage && usage.dailyBudgetUsd > 0 && usage.todayUsd >= usage.dailyBudgetUsd ? 'bad' : undefined} />
        <Stat label="Estimated spend this month" value={formatUsd(usage?.monthUsd)} hint={usage ? (usage.monthlyBudgetUsd > 0 ? `Budget ${formatUsd(usage.monthlyBudgetUsd)} a month` : 'No monthly limit') : undefined} />
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card className="col-span-3">
          <CardHeader title="Recent activity" actions={<Activity size={14} className="text-faint" />} />
          {events.data.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No activity yet" text="Press Run now to look for jobs. What jobpls does shows up here." />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {events.data.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-4 py-2">
                  <Badge tone={EVENT_TONE[e.type] ?? 'neutral'} className="mt-0.5 w-20 justify-center">
                    {EVENT_LABEL[e.type]}
                  </Badge>
                  <button disabled={!e.jobId} onClick={() => e.jobId && navigate(`/jobs/${e.jobId}`)} className="min-w-0 flex-1 text-left text-sm text-fg enabled:hover:text-accent-strong">
                    {e.message}
                  </button>
                  <span className="shrink-0 text-xs text-faint">{relativeTime(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="col-span-2 self-start">
          <CardHeader title="Suggested filter changes" hint="Learned from the jobs you dismissed." actions={<Lightbulb size={14} className="text-faint" />} />
          {!suggestions.data || suggestions.data.length === 0 ? (
            <p className="p-4 text-sm text-muted">No suggestions yet. Dismiss a few jobs with a reason and jobpls will suggest filters.</p>
          ) : (
            <ul className="divide-y divide-line">
              {suggestions.data.map((s) => (
                <li key={s.id} className="p-4">
                  <p className="text-sm text-fg">{s.message}</p>
                  <p className="mt-1 text-xs text-faint">Based on {plural(s.evidence, 'dismissed job')}.</p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="secondary" icon={<Check size={13} />} onClick={() => void applySuggestion(s.id, s.patch)}>
                      Apply
                    </Button>
                    <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => void dismissSuggestion(s.id)}>
                      Dismiss
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {confirmAutopilot && settings && (
        <ConfirmDialog
          title="Turn on autopilot?"
          confirmLabel="Turn on autopilot"
          message={autopilotConfirmMessage(settings, true)}
          onConfirm={async () => {
            await updateSettings({ autopilot: { enabled: true } })
          }}
          onClose={() => setConfirmAutopilot(false)}
        />
      )}
    </Page>
  )
}
