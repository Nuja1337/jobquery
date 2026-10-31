import { useState, type ReactNode } from 'react'
import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Table2 } from 'lucide-react'
import { clsx } from 'clsx'
import { Card, IconButton, TD, TH } from './ui'

/** Categorical series, fixed order. Colors follow the entity, never its rank. */
export const SERIES = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)']

export const AXIS_TICK = { fill: 'var(--chart-axis)', fontSize: 11 }
export const GRID = { stroke: 'var(--chart-grid)', vertical: false } as const

export interface TableView {
  columns: string[]
  rows: Array<Array<string | number>>
}

/** A chart with a title, a one-line description, and a switch to see the same numbers as a table. */
export function ChartCard({ title, hint, children, table, legend, className }: { title: string; hint?: string; children: ReactNode; table: TableView; legend?: Array<{ label: string; color: string }>; className?: string }): React.JSX.Element {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card className={clsx('p-4', className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          {hint && <p className="text-xs text-faint">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {legend && !asTable && (
            <ul className="flex items-center gap-3" aria-label="Legend">
              {legend.map((l) => (
                <li key={l.label} className="flex items-center gap-1.5 text-xs text-muted">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />
                  {l.label}
                </li>
              ))}
            </ul>
          )}
          <IconButton label={asTable ? 'Show chart' : 'Show as table'} active={asTable} onClick={() => setAsTable(!asTable)} className={asTable ? '!text-accent-strong' : ''}>
            <Table2 size={14} />
          </IconButton>
        </div>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-auto rounded-md border border-line">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c} className={TH}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={clsx(TD, 'py-1.5 text-muted', j > 0 && 'tabular-nums')}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </Card>
  )
}

interface TooltipRow {
  label: string
  value: string
  color?: string
}

/** Tooltip body shared by every chart. `rows` builds the lines from the hovered datum. */
export function ChartTooltip({ active, payload, label, title, rows }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }>; label?: string | number; title?: (label: string | number | undefined, datum: never) => string; rows: (datum: never) => TooltipRow[] }): React.JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null
  const datum = payload[0].payload as never
  return (
    <div className="rounded-lg border border-line-strong bg-raised px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-medium text-fg">{title ? title(label, datum) : label}</p>
      {rows(datum).map((r) => (
        <p key={r.label} className="flex items-center gap-2 text-muted">
          {r.color && <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />}
          <span>{r.label}</span>
          <span className="ml-auto pl-4 tabular-nums text-fg">{r.value}</span>
        </p>
      ))}
    </div>
  )
}

interface HBarDatum {
  name: string
  value: number
  [key: string]: unknown
}

/** Horizontal bars, one series, value written at the tip of each bar. */
export function HBarChart({ data, color = SERIES[0], format = (n) => String(n), tooltipRows, labelWidth = 150, emptyText = 'No data in this range.' }: { data: HBarDatum[]; color?: string; format?: (n: number) => string; tooltipRows?: (d: HBarDatum) => TooltipRow[]; labelWidth?: number; emptyText?: string }): React.JSX.Element {
  if (data.length === 0) return <p className="py-8 text-center text-sm text-faint">{emptyText}</p>
  const height = data.length * 30 + 12
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={8}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" width={labelWidth} tick={{ ...AXIS_TICK, fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} interval={0} />
          <Tooltip cursor={{ fill: 'var(--hover)', opacity: 0.5 }} content={<ChartTooltip rows={(d: HBarDatum) => tooltipRows?.(d) ?? [{ label: 'Count', value: format(d.value), color }]} />} />
          <Bar dataKey="value" fill={color} barSize={16} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            <LabelList dataKey="value" position="right" formatter={(v: unknown) => format(Number(v))} fill="var(--muted)" fontSize={11} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
