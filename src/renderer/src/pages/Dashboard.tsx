import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Activity, AlertTriangle, ArrowRight, Check, Inbox, Lightbulb, X } from 'lucide-react'
import { BUCKET_LABELS } from '@shared/defaults'
import type { EventType, FitBucket } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { formatPercent, formatUsd, plural, relativeTime } from '@renderer/lib/format'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBlock, Loading, Notice, Page, PageHeader, Stat, Toggle, type Tone } from '@renderer/components/ui'
import { autopilotConfirmMessage } from '@renderer/lib/autopilot'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'

const WEEK = 7 * 24 * 3600 * 1000
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

export function Dashboard(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const { settings, updateSettings, usage } = useApp()

  const queue = useAsync(() => api.listApplications({ statuses: ['ready', 'needs_attention'], limit: 100 }), [], ['applications:changed'])
  const shortlist = useAsync(() => api.listJobs({ stages: ['shortlisted', 'preparing', 'ready'], limit: 500 }), [], ['jobs:changed'])
  const submitted = useAsync(() => api.listApplications({ statuses: ['submitted'], limit: 500 }), [], ['applications:changed'])
  const runs = useAsync(() => api.listRuns(1), [], ['pipeline:progress'])
  const events = useAsync(() => api.listEvents({ limit: 12 }), [], ['event:new'])
  const suggestions = useAsync(() => api.listSuggestions(), [], ['jobs:changed'])
  const autopilotOn = settings?.autopilot.enabled ?? false
  const intervalHours = settings?.autopilot.intervalHours
  const nextRunAt = useAsync(() => api.getNextRunAt(), [autopilotOn, intervalHours], ['pipeline:progress'])
  const [confirmAutopilot, setConfirmAutopilot] = useState(false)

  const firstError = queue.error ?? shortlist.error ?? submitted.error ?? events.error
  if (firstError) {
    return (
      <Page>
        <PageHeader title="Dashboard" />
        <ErrorBlock message={firstError} onRetry={() => [queue, shortlist, submitted, events].forEach((s) => s.reload())} />
      </Page>
    )
  }
  if (!queue.data || !shortlist.data || !submitted.data || !events.data) {
    return (
      <Page>
        <PageHeader title="Dashboard" />
        <Loading />
      </Page>
    )
  }

  const ready = queue.data.items
  const needAnswer = ready.filter((a) => a.flaggedCount > 0).length
  const needCheck = ready.filter((a) => a.flaggedCount === 0 && a.guessCount > 0).length
  const readyNote =
    ready.length === 0
      ? shortlist.data.total === 0
        ? 'Nothing is waiting yet. Press Run now to look for jobs.'
        : 'Nothing is waiting. Prepare an application from the shortlist.'
      : needAnswer > 0
        ? `${plural(needAnswer, 'application')} still ${needAnswer === 1 ? 'needs' : 'need'} an answer from you${needCheck > 0 ? `, and ${needCheck} ${needCheck === 1 ? 'has' : 'have'} guesses to check` : ''}.`
        : needCheck > 0
          ? `${plural(needCheck, 'application')} ${needCheck === 1 ? 'has' : 'have'} guesses to check before you submit.`
          : 'Everything is filled in. Review and click Submit.'
  const counts: Record<FitBucket, number> = { perfect: 0, great: 0, good: 0, weak: 0 }
  shortlist.data.items.forEach((j) => j.fitBucket && (counts[j.fitBucket] += 1))
  const sentApps = submitted.data.items
  const thisWeek = sentApps.filter((a) => a.submittedAt && Date.now() - new Date(a.submittedAt).getTime() < WEEK).length
  const responded = sentApps.filter((a) => a.outcome !== 'none' && a.outcome !== 'ghosted').length
  const lastRun = runs.data?.[0]
  const lastRunText = lastRun ? `Last run ${relativeTime(lastRun.startedAt)}.` : 'No runs yet.'
  const nextRun = settings?.autopilot.enabled ? nextRunAt.data : null
  const autoSends = !!settings && settings.autopilot.autoSubmit && !settings.autopilot.dryRun

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
    <Page>
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
            Finish the setup guide so JobPilot has an AI provider, your profile and places to look for jobs.
          </Notice>
        </div>
      )}

      <div className="mb-4 grid grid-cols-3 gap-4">
        <Card className="col-span-1 flex flex-col justify-between p-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <Inbox size={14} /> Ready to submit
            </div>
            <p className="mt-1 text-4xl font-semibold tabular-nums tracking-tight text-fg">{ready.length}</p>
            <p className="mt-1 text-sm text-muted">
              {readyNote}
            </p>
          </div>
          <Button variant="primary" className="mt-4 self-start" disabled={ready.length === 0} onClick={() => navigate('/review')} icon={<ArrowRight size={14} />}>
            Open review queue
          </Button>
        </Card>

        <Card className="col-span-1 p-4">
          <p className="text-xs text-muted">Shortlist</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {BUCKETS.map((b) => (
              <button key={b} onClick={() => navigate(`/jobs?fit=${b}`)} className="rounded-md px-2 py-1.5 text-left hover:bg-hover">
                <p className={`text-2xl font-semibold tabular-nums ${BUCKET_COLOR[b]}`}>{counts[b]}</p>
                <p className="text-xs text-muted">{BUCKET_LABELS[b]}</p>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-faint">{plural(shortlist.data.total, 'job')} waiting for you or autopilot.</p>
        </Card>

        <Card className="col-span-1 p-4">
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
              label={settings?.autopilot.enabled ? (settings.autopilot.intervalHours === 1 ? 'Runs every hour' : `Runs every ${settings.autopilot.intervalHours} hours`) : 'Runs only when you press Run now'}
              hint={
                settings?.autopilot.enabled
                  ? nextRun
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

      {lastRun?.stats.stoppedForRateLimit && (
        <div className="mb-4">
          <Notice tone="warn" title="An AI provider's limit was reached">
            The last run paused AI work when the limit was reached. The rest continues on the next run.
          </Notice>
        </div>
      )}

      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Applied this week" value={thisWeek} hint={`${sentApps.length} in total`} />
        <Stat label="Reply rate" value={sentApps.length ? formatPercent(responded / sentApps.length) : '-'} hint={`${plural(responded, 'reply', 'replies')} to ${plural(sentApps.length, 'application')}`} />
        <Stat label="Estimated spend today" value={formatUsd(usage?.todayUsd)} hint={usage ? `${usage.dailyBudgetUsd > 0 ? `Budget ${formatUsd(usage.dailyBudgetUsd)} a day` : 'No daily limit'}${usage.freeCallsToday > 0 ? `. ${plural(usage.freeCallsToday, 'free call')} today` : ''}` : undefined} tone={usage && usage.dailyBudgetUsd > 0 && usage.todayUsd >= usage.dailyBudgetUsd ? 'bad' : undefined} />
        <Stat label="Estimated spend this month" value={formatUsd(usage?.monthUsd)} hint={usage ? (usage.monthlyBudgetUsd > 0 ? `Budget ${formatUsd(usage.monthlyBudgetUsd)} a month` : 'No monthly limit') : undefined} />
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card className="col-span-3">
          <CardHeader title="Recent activity" actions={<Activity size={14} className="text-faint" />} />
          {events.data.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No activity yet" text="Press Run now to look for jobs. What JobPilot does shows up here." />
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
            <p className="p-4 text-sm text-muted">No suggestions yet. Dismiss a few jobs with a reason and JobPilot will suggest filters.</p>
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
