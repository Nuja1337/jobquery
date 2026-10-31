import { clsx } from 'clsx'
import type { LintReport, LintSeverity } from '@shared/types'
import { Badge, Spinner, type Tone } from './ui'

const SEVERITY_TONE: Record<LintSeverity, Tone> = { high: 'bad', medium: 'warn', low: 'neutral' }

export function lintTone(score: number, min: number): 'good' | 'warn' | 'bad' {
  if (score >= min) return 'good'
  if (score >= min - 15) return 'warn'
  return 'bad'
}

export function LintScore({ score, min }: { score: number; min: number }): React.JSX.Element {
  const tone = lintTone(score, min)
  return (
    <div className="flex items-baseline gap-1.5" title="100 reads as written by a person. Drafts below your minimum are revised.">
      <span className={clsx('text-3xl font-semibold tabular-nums', tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : 'text-bad')}>{score}</span>
      <span className="text-xs text-faint">out of 100 for sounding human. Your minimum is {min}.</span>
    </div>
  )
}

/** The "does this sound AI-written" report that sits beside the cover letter. */
export function LintPanel({ report, min, busy }: { report: LintReport | null; min: number; busy?: boolean }): React.JSX.Element {
  if (!report) return <p className="text-sm text-faint">No report yet.</p>
  return (
    <div>
      <div className="flex items-center justify-between">
        <LintScore score={report.score} min={min} />
        {busy && <Spinner />}
      </div>
      <p className="mt-1 text-xs text-faint">
        {report.stats.words} words, {report.stats.sentences} sentences, {report.stats.avgSentenceWords} words per sentence on average
      </p>
      {report.issues.length === 0 ? (
        <p className="mt-3 text-sm text-good">No AI-sounding patterns found.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {report.issues.map((issue, i) => (
            <li key={`${issue.rule}-${i}`} className="rounded-md border border-line bg-bg p-2.5">
              <div className="flex items-center gap-2">
                <Badge tone={SEVERITY_TONE[issue.severity]}>{issue.severity}</Badge>
                <span className="text-sm text-fg">{issue.message}</span>
              </div>
              {issue.match && <p className="mt-1.5 break-words rounded bg-hover px-1.5 py-0.5 font-mono text-xs text-muted">{issue.match}</p>}
              {issue.suggestion && <p className="mt-1.5 text-xs text-muted">{issue.suggestion}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
