import { useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { BarChart3 } from 'lucide-react'
import { BUCKET_LABELS } from '@shared/defaults'
import type { AnalyticsReport } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { SOURCE_LABELS, compact, formatPercent, formatShortDay, formatTokens, formatUsd, plural, ratio } from '@renderer/lib/format'
import { AXIS_TICK, ChartCard, ChartTooltip, GRID, HBarChart, SERIES } from '@renderer/components/charts'
import { Card, EmptyState, ErrorBlock, Loading, Page, PageHeader, Segmented, Stat } from '@renderer/components/ui'

const TASK_LABELS: Record<string, string> = {
  triage: 'Scoring fit',
  cover_letter: 'Cover letters',
  answers: 'Form answers',
  revise: 'Revisions',
  extract_profile: 'Reading resume',
  voice: 'Voice profile',
  form_map: 'Reading forms',
  test: 'Connection tests'
}

export function Analytics(): React.JSX.Element {
  const [range, setRange] = useState(30)
  const report = useAsync(() => api.getAnalytics(range), [range], ['applications:changed'])

  return (
    <Page wide>
      <PageHeader
        title="Analytics"
        intro="What the search found, what it cost, and what worked."
        actions={
          <Segmented
            value={range}
            onChange={setRange}
            items={[
              { id: 7, label: '7 days' },
              { id: 30, label: '30 days' },
              { id: 90, label: '90 days' }
            ]}
          />
        }
      />
      {report.error ? <ErrorBlock message={report.error} onRetry={report.reload} /> : !report.data ? <Loading /> : report.data.funnel.discovered === 0 ? <EmptyState icon={<BarChart3 size={24} />} title="Nothing to chart yet" text="Press Run now to find jobs. Charts fill in as JobPilot works." /> : <Report r={report.data} />}
    </Page>
  )
}

function Report({ r }: { r: AnalyticsReport }): React.JSX.Element {
  const f = r.funnel
  // The tiles count applications sent in the period. The funnel follows the jobs found in the period.
  const sent = r.outcomesBySource.reduce(
    (t, o) => ({ submitted: t.submitted + o.submitted, responses: t.responses + o.responses, interviews: t.interviews + o.interviews }),
    { submitted: 0, responses: 0, interviews: 0 }
  )
  const responseRate = ratio(sent.responses, sent.submitted)
  const interviewRate = ratio(sent.interviews, sent.submitted)

  const funnelRows = [
    { name: 'Discovered', value: f.discovered },
    { name: 'Scored by AI', value: f.scored },
    { name: 'Shortlisted', value: f.shortlisted },
    { name: 'Application drafted', value: f.prepared },
    { name: 'Submitted', value: f.submitted },
    { name: 'Got a reply', value: f.responses },
    { name: 'Interviews', value: f.interviews },
    { name: 'Offers', value: f.offers }
  ]

  const rate = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0)
  const byBucket = r.outcomesByBucket.map((o) => ({ name: BUCKET_LABELS[o.bucket], submitted: o.submitted, responses: o.responses, interviews: o.interviews, response: rate(o.responses, o.submitted), interview: rate(o.interviews, o.submitted) }))
  const bySource = r.outcomesBySource.map((o) => ({ name: SOURCE_LABELS[o.source], submitted: o.submitted, responses: o.responses, interviews: o.interviews, response: rate(o.responses, o.submitted), interview: rate(o.interviews, o.submitted) }))
  const rateLegend = [
    { label: 'Got a reply', color: SERIES[0] },
    { label: 'Interview', color: SERIES[1] }
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-6 gap-3">
        <Stat label="Submitted" value={sent.submitted} />
        <Stat label="Reply rate" value={formatPercent(responseRate)} hint={`${plural(sent.responses, 'reply', 'replies')}`} />
        <Stat label="Interview rate" value={formatPercent(interviewRate)} hint={plural(sent.interviews, 'interview')} />
        <Stat label="AI spend per application" value={formatUsd(r.averages.costPerApplicationUsd)} hint="All AI spend in the period, divided by applications sent" />
        <Stat label="Discovery to apply" value={r.averages.hoursDiscoveryToApply == null ? '-' : `${r.averages.hoursDiscoveryToApply.toFixed(0)} h`} />
        <Stat label="Days to first reply" value={r.averages.daysToFirstResponse == null ? '-' : r.averages.daysToFirstResponse.toFixed(1)} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <ChartCard
          className="col-span-2"
          title="Funnel"
          hint={`Jobs found in this period and how far they got. ${f.filteredOut + f.prescoredOut + f.duplicates} of ${f.discovered} never reached the AI: ${f.filteredOut} filtered, ${f.prescoredOut} low keyword match, ${f.duplicates} duplicates.`}
          table={{ columns: ['Stage', 'Jobs'], rows: funnelRows.map((x) => [x.name, x.value]) }}
        >
          <HBarChart
            data={funnelRows}
            labelWidth={140}
            format={compact}
            tooltipRows={(d) => {
              const i = funnelRows.findIndex((x) => x.name === d.name)
              const prev = i > 0 ? funnelRows[i - 1].value : null
              return [
                { label: 'Jobs', value: String(d.value), color: SERIES[0] },
                ...(prev ? [{ label: `Of ${funnelRows[i - 1].name.toLowerCase()}`, value: formatPercent(d.value / prev) }] : [])
              ]
            }}
          />
        </ChartCard>

        <Card className="p-4">
          <h3 className="text-sm font-medium text-fg">Token savings</h3>
          <p className="mb-3 text-xs text-faint">Work the free filters and the local cache did instead of the AI.</p>
          <dl className="space-y-3">
            <Saving label="Jobs handled by free filters" value={r.tokenSavings.jobsSkippedFree.toLocaleString('en-US')} />
            <Saving label="Estimated tokens saved" value={formatTokens(r.tokenSavings.estimatedTokensSaved)} />
            <Saving label="Estimated money saved" value={formatUsd(r.tokenSavings.estimatedUsdSaved)} />
            <Saving label="Answers served from cache" value={r.tokenSavings.cacheHits.toLocaleString('en-US')} />
          </dl>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <TimeChart title="Jobs found per day" unit="Jobs" data={r.daily} dataKey="discovered" color={SERIES[0]} format={(n) => String(n)} />
        <TimeChart title="Applications submitted per day" unit="Applications" data={r.daily} dataKey="submitted" color={SERIES[2]} format={(n) => String(n)} />
        <TimeChart title="Cost per day" unit="US dollars" data={r.daily} dataKey="costUsd" color={SERIES[1]} format={formatUsd} axisFormat={(n) => `$${n}`} extra={(d) => [{ label: 'Tokens', value: formatTokens(d.tokens) }]} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <RateChart title="Replies by fit" hint="Share of submitted applications that got a reply or an interview." data={byBucket} legend={rateLegend} />
        <RateChart title="Replies by source" hint="Small numbers move a lot. Check the counts in the tooltip." data={bySource} legend={rateLegend} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <ChartCard title="Cost by task" hint="Where the money goes." table={{ columns: ['Task', 'Cost', 'Tokens', 'Calls'], rows: r.costByTask.map((t) => [TASK_LABELS[t.task] ?? t.task, formatUsd(t.costUsd), formatTokens(t.tokens), t.calls]) }}>
          <HBarChart
            data={r.costByTask.map((t) => ({ name: TASK_LABELS[t.task] ?? t.task, value: t.costUsd, tokens: t.tokens, calls: t.calls }))}
            format={formatUsd}
            tooltipRows={(d) => [{ label: 'Cost', value: formatUsd(d.value), color: SERIES[0] }, { label: 'Tokens', value: formatTokens(d.tokens as number) }, { label: 'Calls', value: String(d.calls) }]}
          />
        </ChartCard>
        <ChartCard title="Cost by model" hint="Cheap models do the high-volume work." table={{ columns: ['Model', 'Cost', 'Tokens', 'Calls'], rows: r.costByModel.map((t) => [t.model, formatUsd(t.costUsd), formatTokens(t.tokens), t.calls]) }}>
          <HBarChart
            data={r.costByModel.map((t) => ({ name: t.model, value: t.costUsd, tokens: t.tokens, calls: t.calls }))}
            labelWidth={160}
            format={formatUsd}
            tooltipRows={(d) => [{ label: 'Cost', value: formatUsd(d.value), color: SERIES[0] }, { label: 'Tokens', value: formatTokens(d.tokens as number) }, { label: 'Calls', value: String(d.calls) }]}
          />
        </ChartCard>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <ChartCard title="Fit score distribution" hint="How many scored jobs landed in each score range." table={{ columns: ['Score', 'Jobs'], rows: r.scoreDistribution.map((s) => [s.range, s.count]) }}>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={r.scoreDistribution} margin={{ top: 8, right: 8, bottom: 16, left: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="range" tick={AXIS_TICK} axisLine={false} tickLine={false} label={{ value: 'Fit score', position: 'insideBottom', offset: -10, fill: 'var(--faint)', fontSize: 11 }} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} allowDecimals={false} label={{ value: 'Jobs', angle: -90, position: 'insideLeft', fill: 'var(--faint)', fontSize: 11 }} />
                <Tooltip cursor={{ fill: 'var(--hover)', opacity: 0.5 }} content={<ChartTooltip title={(l) => `Score ${l}`} rows={(d: { count: number }) => [{ label: 'Jobs', value: String(d.count), color: SERIES[0] }]} />} />
                <Bar dataKey="count" fill={SERIES[0]} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Skills to learn" hint="Gaps that show up most often in jobs that otherwise fit you." table={{ columns: ['Skill', 'Jobs'], rows: r.topGaps.map((g) => [g.key, g.count]) }}>
          <HBarChart data={r.topGaps.map((g) => ({ name: g.key, value: g.count }))} color={SERIES[1]} tooltipRows={(d) => [{ label: 'Good-fit jobs asking for it', value: String(d.value), color: SERIES[1] }]} emptyText="No gaps found in good-fit jobs." />
        </ChartCard>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <ChartCard title="Top matches" hint="Your skills that good-fit jobs ask for most." table={{ columns: ['Skill', 'Jobs'], rows: r.topMatches.map((g) => [g.key, g.count]) }}>
          <HBarChart data={r.topMatches.map((g) => ({ name: g.key, value: g.count }))} labelWidth={110} tooltipRows={(d) => [{ label: 'Jobs', value: String(d.value), color: SERIES[0] }]} />
        </ChartCard>
        <ChartCard title="Why you dismissed jobs" table={{ columns: ['Reason', 'Jobs'], rows: r.dismissReasons.map((g) => [g.key, g.count]) }}>
          <HBarChart data={r.dismissReasons.map((g) => ({ name: g.key, value: g.count }))} labelWidth={110} emptyText="You have not dismissed any jobs in this range." tooltipRows={(d) => [{ label: 'Jobs', value: String(d.value), color: SERIES[0] }]} />
        </ChartCard>
        <ChartCard title="Why filters dropped jobs" table={{ columns: ['Reason', 'Jobs'], rows: r.filterReasons.map((g) => [g.key, g.count]) }}>
          <HBarChart data={r.filterReasons.map((g) => ({ name: g.key, value: g.count }))} labelWidth={150} tooltipRows={(d) => [{ label: 'Jobs', value: String(d.value), color: SERIES[0] }]} />
        </ChartCard>
      </div>
    </div>
  )
}

function Saving({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums text-fg">{value}</dd>
    </div>
  )
}

type Daily = AnalyticsReport['daily'][number]

function TimeChart({ title, unit, data, dataKey, color, format, axisFormat, extra }: { title: string; unit: string; data: Daily[]; dataKey: 'discovered' | 'submitted' | 'costUsd'; color: string; format: (n: number) => string; axisFormat?: (n: number) => string; extra?: (d: Daily) => Array<{ label: string; value: string }> }): React.JSX.Element {
  const total = data.reduce((s, d) => s + d[dataKey], 0)
  return (
    <ChartCard title={title} hint={`${format(Math.round(total * 1000) / 1000)} in total`} table={{ columns: ['Day', unit], rows: data.map((d) => [d.date, format(d[dataKey])]) }}>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={formatShortDay} minTickGap={32} />
            <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={dataKey === 'costUsd'} tickFormatter={axisFormat ?? ((n: number) => String(n))} />
            <Tooltip
              cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }}
              content={<ChartTooltip title={(l) => formatShortDay(String(l))} rows={(d: Daily) => [{ label: unit, value: format(d[dataKey]), color }, ...(extra?.(d) ?? [])]} />}
            />
            <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={color} fillOpacity={0.1} dot={false} activeDot={{ r: 4, fill: color, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

interface RateRow {
  name: string
  submitted: number
  responses: number
  interviews: number
  response: number
  interview: number
}

function RateChart({ title, hint, data, legend }: { title: string; hint: string; data: RateRow[]; legend: Array<{ label: string; color: string }> }): React.JSX.Element {
  return (
    <ChartCard title={title} hint={hint} legend={legend} table={{ columns: ['Group', 'Submitted', 'Replies', 'Interviews'], rows: data.map((d) => [d.name, d.submitted, d.responses, d.interviews]) }}>
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barGap={2}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
            <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} domain={[0, 100]} tickFormatter={(n: number) => `${n}%`} label={{ value: 'Of submitted', angle: -90, position: 'insideLeft', fill: 'var(--faint)', fontSize: 11 }} />
            <Tooltip
              cursor={{ fill: 'var(--hover)', opacity: 0.5 }}
              content={
                <ChartTooltip
                  rows={(d: RateRow) => [
                    { label: 'Submitted', value: String(d.submitted) },
                    { label: 'Got a reply', value: `${d.responses} (${d.response}%)`, color: SERIES[0] },
                    { label: 'Interview', value: `${d.interviews} (${d.interview}%)`, color: SERIES[1] }
                  ]}
                />
              }
            />
            <Bar dataKey="response" fill={SERIES[0]} maxBarSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="interview" fill={SERIES[1]} maxBarSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}
