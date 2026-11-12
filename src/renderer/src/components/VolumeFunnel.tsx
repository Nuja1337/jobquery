import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowRight, Inbox } from 'lucide-react'
import { STOP_AFTER_FAILURES } from '@shared/sources'
import type { AnalyticsReport, UsageSummary, VolumeCounts } from '@shared/types'
import { formatPercent, formatUsd, plural } from '@renderer/lib/format'
import { Badge, Button, Card, CardHeader, ProgressBar } from './ui'
import { AXIS_TICK, ChartCard, ChartTooltip, SERIES } from './charts'
import { funnelSteps, hourLabel, quotaShare, quotaTone, shareOfFound } from './volumeHelpers'

/** One row of the funnel for a window of time. */
function FunnelRow({ title, counts }: { title: string; counts: VolumeCounts }): React.JSX.Element {
  const steps = funnelSteps(counts)
  return (
    <div className="grid grid-cols-[6.5rem_repeat(6,minmax(0,1fr))] items-center gap-2 px-4 py-3">
      <p className="text-sm font-medium text-fg">{title}</p>
      {steps.map((s, i) => {
        const share = shareOfFound(steps, i)
        return (
          <div key={s.key} className="min-w-0">
            <p className="text-xs text-muted">{s.label}</p>
            <p className="text-xl font-semibold tabular-nums tracking-tight text-fg">{s.value.toLocaleString('en-US')}</p>
            <p className="h-4 text-xs tabular-nums text-faint">{share === null ? '' : `${formatPercent(share)} of found`}</p>
          </div>
        )
      })}
    </div>
  )
}

/** Found, passed filters, scored, shortlisted, prepared and sent, for today and for the last 7 days. */
export function VolumeFunnel({ analytics }: { analytics: AnalyticsReport }): React.JSX.Element {
  return (
    <Card className="mb-4">
      <CardHeader title="Volume" hint={`Today, ${formatUsd(analytics.today.costUsd)} of AI spend. Last 7 days, ${formatUsd(analytics.week.costUsd)}.`} />
      <div className="divide-y divide-line">
        <FunnelRow title="Today" counts={analytics.today} />
        <FunnelRow title="Last 7 days" counts={analytics.week} />
      </div>
    </Card>
  )
}

/** Applications sent in each of the last 24 hours. */
export function SendsPerHour({ sends }: { sends: AnalyticsReport['sendsByHour'] }): React.JSX.Element {
  const data = sends.map((s) => ({ label: hourLabel(s.hour), count: s.count }))
  const total = sends.reduce((n, s) => n + s.count, 0)
  return (
    <ChartCard title="Sends per hour" hint={`${plural(total, 'application')} sent in the last 24 hours.`} table={{ columns: ['Hour', 'Sent'], rows: data.map((d) => [d.label, d.count]) }}>
      <div className="h-28">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={2} />
            <YAxis hide allowDecimals={false} domain={[0, (max: number) => Math.max(1, max)]} />
            <Tooltip cursor={{ fill: 'var(--hover)', opacity: 0.5 }} content={<ChartTooltip title={(l) => `${l} to ${String((Number(String(l).slice(0, 2)) + 1) % 24).padStart(2, '0')}:00`} rows={(d: { count: number }) => [{ label: 'Sent', value: String(d.count), color: SERIES[0] }]} />} />
            <Bar dataKey="count" fill={SERIES[0]} radius={[3, 3, 0, 0]} minPointSize={1} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

/** Applications that need the user, with a way into the review queue. */
export function WaitingOnYou({ totals, onOpen }: { totals: AnalyticsReport['totals']; onOpen: () => void }): React.JSX.Element {
  const waiting = totals.needsAttention + totals.ready
  return (
    <Card className="flex flex-col justify-between p-4">
      <div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Inbox size={14} /> Waiting on you
        </div>
        <p className="mt-1 text-4xl font-semibold tabular-nums tracking-tight text-fg">{waiting.toLocaleString('en-US')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone={totals.needsAttention > 0 ? 'warn' : 'neutral'}>{totals.needsAttention.toLocaleString('en-US')} need attention</Badge>
          <Badge tone={totals.ready > 0 ? 'good' : 'neutral'}>{totals.ready.toLocaleString('en-US')} ready</Badge>
        </div>
        <p className="mt-2 text-sm text-muted">
          {waiting === 0 ? 'Nothing is waiting on you.' : totals.needsAttention > 0 ? 'Some applications need an answer or a fix before they can go out.' : 'These are filled in and wait for you to review and submit.'}
        </p>
      </div>
      <Button variant="primary" className="mt-4 self-start" disabled={waiting === 0} onClick={onOpen} icon={<ArrowRight size={14} />}>
        Open review
      </Button>
    </Card>
  )
}

/** Requests and spend today for each AI provider, with the daily budget. */
export function QuotaCard({ quota, usage }: { quota: AnalyticsReport['quota']; usage: UsageSummary | null }): React.JSX.Element {
  const budget = usage && usage.dailyBudgetUsd > 0 ? usage.dailyBudgetUsd : null
  const hint = usage ? `${formatUsd(usage.todayUsd)} spent today${budget ? ` of a ${formatUsd(budget)} budget` : ', no daily limit'}.` : undefined
  return (
    <Card className="col-span-2">
      <CardHeader title="AI quota and spend" hint={hint} />
      {budget !== null && usage && (
        <div className="px-4 pt-3">
          <ProgressBar value={usage.todayUsd / budget} tone={usage.todayUsd >= budget ? 'bad' : usage.todayUsd >= budget * 0.8 ? 'warn' : 'accent'} />
        </div>
      )}
      {quota.length === 0 ? (
        <p className="p-4 text-sm text-muted">No AI provider is set up yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {quota.map((q) => {
            const share = quotaShare(q)
            return (
              <li key={q.providerId} className="grid grid-cols-[minmax(0,1fr)_14rem_5rem] items-center gap-3 px-4 py-2">
                <span className="truncate text-sm text-fg">{q.label}</span>
                <div>
                  <p className="text-xs tabular-nums text-muted">
                    {q.requestsPerDay ? `${q.requestsToday.toLocaleString('en-US')} of ${q.requestsPerDay.toLocaleString('en-US')} requests` : `${plural(q.requestsToday, 'request')}, no limit`}
                  </p>
                  {share !== null && <ProgressBar value={share} tone={quotaTone(share)} />}
                </div>
                <span className="text-right text-sm tabular-nums text-muted">{formatUsd(q.costToday)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/** Company boards JobQuery watches, with the ones that fail and the ones due for a check. */
export function BoardHealth({ boards, onOpen }: { boards: AnalyticsReport['boards']; onOpen: () => void }): React.JSX.Element {
  const cells: Array<{ label: string; value: number; tone?: 'warn' | 'bad' }> = [
    { label: 'Watched', value: boards.watched },
    { label: 'Failing', value: boards.failing, tone: boards.failing > 0 ? 'warn' : undefined },
    { label: 'Stopped', value: boards.stopped, tone: boards.stopped > 0 ? 'bad' : undefined },
    { label: 'Due now', value: boards.dueNow }
  ]
  return (
    <Card className="p-4">
      <p className="text-xs text-muted">Boards</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {cells.map((c) => (
          <button key={c.label} onClick={onOpen} className="rounded-md px-2 py-1.5 text-left hover:bg-hover">
            <p className={`text-2xl font-semibold tabular-nums ${c.tone === 'bad' ? 'text-bad' : c.tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{c.value.toLocaleString('en-US')}</p>
            <p className="text-xs text-muted">{c.label}</p>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">{`A board that fails ${STOP_AFTER_FAILURES} checks in a row is stopped.`}</p>
    </Card>
  )
}
