import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowRight, CheckCheck, Download, FileCheck, Inbox, MousePointerClick, RefreshCw, SkipForward, TriangleAlert } from 'lucide-react'
import { clsx } from 'clsx'
import type { Application, ApplicationSummary, LintReport, PreparedAnswer } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { useAsync, useHotkeys } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { relativeTime } from '@renderer/lib/format'
import { FitBadge, StatusBadge } from '@renderer/components/badges'
import { AnswerField, answerIsMissing } from '@renderer/components/AnswerField'
import { LintPanel } from '@renderer/components/LintPanel'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBlock, Input, Kbd, Loading, Page, PageHeader, Textarea } from '@renderer/components/ui'

export function Review(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const queue = useAsync(() => api.listApplications({ statuses: ['ready', 'needs_attention'], limit: 200 }), [], ['applications:changed'])

  const items = useMemo<ApplicationSummary[]>(() => [...(queue.data?.items ?? [])].sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0) || a.createdAt.localeCompare(b.createdAt)), [queue.data])
  const activeId = id ?? items[0]?.id
  const index = items.findIndex((a) => a.id === activeId)

  const go = useCallback(
    (delta: number) => {
      if (items.length === 0) return
      const next = items[Math.min(items.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))]
      if (next && next.id !== activeId) navigate(`/review/${next.id}`)
    },
    [items, index, activeId, navigate]
  )
  useHotkeys({ j: () => go(1), k: () => go(-1) })

  /** After an application leaves the queue, show the one that took its place. */
  const advance = useCallback(
    (fromId: string) => {
      const rest = items.filter((a) => a.id !== fromId)
      const i = items.findIndex((a) => a.id === fromId)
      const next = rest[Math.min(i, rest.length - 1)]
      navigate(next ? `/review/${next.id}` : '/review', { replace: true })
    },
    [items, navigate]
  )

  if (queue.error) {
    return (
      <Page>
        <PageHeader title="Review queue" />
        <ErrorBlock message={queue.error} onRetry={queue.reload} />
      </Page>
    )
  }
  if (!queue.data) {
    return (
      <Page>
        <PageHeader title="Review queue" />
        <Loading />
      </Page>
    )
  }
  if (items.length === 0 && !id) {
    return (
      <Page>
        <PageHeader title="Review queue" intro="Applications that are drafted and waiting for your click." />
        <EmptyState
          icon={<Inbox size={24} />}
          title="Nothing to review"
          text="When JobPilot drafts an application, it shows up here. Prepare one from your shortlist, or turn on auto-prepare in Settings."
          action={
            <Link to="/jobs">
              <Button variant="primary" icon={<ArrowRight size={14} />}>
                Go to the shortlist
              </Button>
            </Link>
          }
        />
      </Page>
    )
  }

  return (
    <Page wide>
      <PageHeader
        title="Review queue"
        intro="Check each draft, then click Submit."
        actions={
          <span className="flex items-center gap-1.5 text-xs text-faint">
            <Kbd>J</Kbd> next <Kbd>K</Kbd> previous
          </span>
        }
      />
      <div className="grid grid-cols-[17rem_minmax(0,1fr)] items-start gap-5">
        <nav aria-label="Applications to review" className="sticky top-4 max-h-[calc(100vh-8rem)] space-y-1.5 overflow-y-auto">
          {items.map((a) => (
            <button
              key={a.id}
              onClick={() => navigate(`/review/${a.id}`)}
              aria-current={a.id === activeId}
              className={clsx('w-full rounded-lg border p-2.5 text-left transition-colors', a.id === activeId ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface hover:bg-hover')}
            >
              <p className="truncate text-sm font-medium text-fg">{a.title}</p>
              <p className="truncate text-xs text-muted">{a.company}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <FitBadge bucket={a.fitBucket} score={a.fitScore} compact />
                {a.flaggedCount > 0 ? <Badge tone="warn">{a.flaggedCount} to fill</Badge> : <Badge tone="good">Ready</Badge>}
              </div>
            </button>
          ))}
        </nav>
        <div className="min-w-0">{activeId && <ReviewDetail key={activeId} id={activeId} onLeave={advance} />}</div>
      </div>
    </Page>
  )
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved'

function ReviewDetail({ id, onLeave }: { id: string; onLeave: (id: string) => void }): React.JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const { settings } = useApp()
  const minLint = settings?.writing.minLintScore ?? 80

  const [app, setApp] = useState<Application | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [letter, setLetter] = useState('')
  const [lint, setLint] = useState<LintReport | null>(null)
  const [lintBusy, setLintBusy] = useState(false)
  const [answers, setAnswers] = useState<PreparedAnswer[]>([])
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [letterGuidance, setLetterGuidance] = useState('')
  const [guidanceOpen, setGuidanceOpen] = useState(false)
  const [busy, setBusy] = useState<null | 'letter' | 'auto' | 'assist' | 'manual' | 'pdf'>(null)

  const answersRef = useRef<PreparedAnswer[]>([])
  const pending = useRef<{ coverLetter?: string; answers?: PreparedAnswer[] }>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastLinted = useRef('')

  useEffect(() => {
    let live = true
    api.getApplication(id).then(
      (a) => {
        if (!live) return
        if (!a) {
          setError('That application no longer exists.')
          return
        }
        setApp(a)
        setLetter(a.coverLetter ?? '')
        lastLinted.current = a.coverLetter ?? ''
        setLint(a.coverLetterLint)
        setAnswers(a.answers)
        answersRef.current = a.answers
      },
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [id])

  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current)
    const patch = pending.current
    pending.current = {}
    if (patch.coverLetter === undefined && patch.answers === undefined) return
    setSaveState('saving')
    try {
      const next = await api.updateApplication(id, patch)
      setApp((cur) => (cur ? { ...cur, status: next.status, flaggedCount: next.flaggedCount, updatedAt: next.updatedAt } : cur))
      setSaveState('saved')
    } catch (e) {
      pending.current = { ...patch, ...pending.current }
      setSaveState('dirty')
      toast.error(e)
    }
  }, [id, toast])

  // Save what is pending when the person leaves this application.
  useEffect(
    () => () => {
      void flush()
    },
    [flush]
  )

  function schedule(patch: { coverLetter?: string; answers?: PreparedAnswer[] }): void {
    pending.current = { ...pending.current, ...patch }
    setSaveState('dirty')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 800)
  }

  // Re-lint the cover letter shortly after typing stops.
  useEffect(() => {
    if (!app || letter === lastLinted.current) return
    setLintBusy(true)
    const t = setTimeout(() => {
      lastLinted.current = letter
      api.lintText(letter).then(
        (r) => {
          setLint(r)
          setLintBusy(false)
        },
        () => setLintBusy(false)
      )
    }, 500)
    return () => clearTimeout(t)
  }, [letter, app])

  function onLetter(v: string): void {
    setLetter(v)
    schedule({ coverLetter: v })
  }

  function updateAnswer(next: PreparedAnswer): void {
    const list = answersRef.current.map((a) => (a.fieldKey === next.fieldKey ? next : a))
    answersRef.current = list
    setAnswers(list)
    schedule({ answers: list })
  }

  async function regenerateAnswer(fieldKey: string, guidance: string | null): Promise<void> {
    await flush()
    const fresh = await api.regenerateAnswer(id, fieldKey, guidance)
    const list = answersRef.current.map((a) => (a.fieldKey === fieldKey ? fresh : a))
    answersRef.current = list
    setAnswers(list)
    toast.success('Wrote a new answer.')
  }

  async function regenerateLetter(): Promise<void> {
    setBusy('letter')
    try {
      await flush()
      const next = await api.regenerateCoverLetter(id, letterGuidance.trim() || null)
      setLetter(next.coverLetter ?? '')
      lastLinted.current = next.coverLetter ?? ''
      setLint(next.coverLetterLint)
      setLetterGuidance('')
      setGuidanceOpen(false)
      toast.success('Wrote a new cover letter.')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  async function submit(mode: 'auto' | 'assist'): Promise<void> {
    setBusy(mode)
    try {
      await flush()
      const result = await api.submitApplication(id, mode)
      if (!result.ok) throw new Error(result.message)
      toast.success(result.message)
      if (result.status === 'submitted') onLeave(id)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  async function markSubmitted(): Promise<void> {
    setBusy('manual')
    try {
      await flush()
      await api.markSubmitted(id)
      toast.success('Marked as submitted.')
      onLeave(id)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  async function exportPdf(): Promise<void> {
    setBusy('pdf')
    try {
      await flush()
      const path = await api.exportCoverLetterPdf(id)
      toast.success(`Saved the cover letter to ${path}`)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  function jumpToFlagged(): void {
    document.querySelector('[data-flagged]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  if (error) return <ErrorBlock message={error} onRetry={() => navigate(0)} />
  if (!app) return <Loading />

  const fieldFor = (key: string) => app.formFields.find((f) => f.key === key)
  const missingRequired = answers.filter((a) => a.required && answerIsMissing(a))
  const flaggedAll = answers.filter(answerIsMissing)
  const done = app.status === 'submitted'
  const locked = busy !== null

  return (
    <div className="space-y-4">
      <Card className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight text-fg">{app.title}</h2>
            <FitBadge bucket={app.fitBucket} score={app.fitScore} />
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {app.company} <span className="text-faint">, drafted {relativeTime(app.createdAt)}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-faint" aria-live="polite">
            {saveState === 'saving' ? 'Saving' : saveState === 'dirty' ? 'Unsaved changes' : saveState === 'saved' ? 'Saved' : ''}
          </span>
          <StatusBadge status={app.status} />
          <Link to={`/jobs/${app.jobId}`} className="text-sm text-accent-strong hover:underline">
            View job
          </Link>
        </div>
      </Card>

      {app.error && <ErrorBlock message={app.error} />}

      {missingRequired.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warn/50 bg-warn-soft px-4 py-2.5" role="alert">
          <p className="flex items-center gap-2 text-sm text-fg">
            <TriangleAlert size={16} className="text-warn" />
            {missingRequired.length === 1 ? '1 required answer needs you' : `${missingRequired.length} required answers need you`} before you can submit.
          </p>
          <Button size="sm" onClick={jumpToFlagged}>
            Show me
          </Button>
        </div>
      )}

      <Card>
        <CardHeader
          title="Cover letter"
          hint={`${letter.trim() ? letter.trim().split(/\s+/).length : 0} words`}
          actions={
            <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => setGuidanceOpen(!guidanceOpen)} aria-expanded={guidanceOpen}>
              Regenerate
            </Button>
          }
        />
        {guidanceOpen && (
          <form
            className="flex items-center gap-2 border-b border-line bg-raised px-4 py-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              void regenerateLetter()
            }}
          >
            <Input autoFocus value={letterGuidance} onChange={(e) => setLetterGuidance(e.target.value)} placeholder="Guidance, for example: shorter, lead with the dashboard rebuild" aria-label="Guidance for the new cover letter" />
            <Button type="submit" variant="primary" loading={busy === 'letter'}>
              Write it again
            </Button>
          </form>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_20rem] gap-0">
          <div className="p-4">
            <Textarea rows={16} value={letter} onChange={(e) => onLetter(e.target.value)} aria-label="Cover letter" placeholder="No cover letter yet. Press Regenerate to write one." disabled={done} />
          </div>
          <aside className="border-l border-line p-4" aria-label="Writing check">
            <LintPanel report={lint} min={minLint} busy={lintBusy} />
          </aside>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Application answers"
          hint={flaggedAll.length > 0 ? `${flaggedAll.length} to check` : 'All answers are filled in.'}
          actions={flaggedAll.length === 0 ? <Badge tone="good">Complete</Badge> : <Badge tone="warn">{flaggedAll.length} flagged</Badge>}
        />
        <div className="space-y-3 p-4">
          {answers.map((a) => (
            <AnswerField key={a.fieldKey} answer={a} minLint={minLint} maxLength={fieldFor(a.fieldKey)?.maxLength} onChange={updateAnswer} onRegenerate={(g) => regenerateAnswer(a.fieldKey, g)} />
          ))}
          {answers.length === 0 && <p className="text-sm text-muted">The form has no questions beyond the resume.</p>}
        </div>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-surface/95 px-4 py-3 shadow-lg backdrop-blur">
        {done ? (
          <p className="flex items-center gap-2 text-sm text-good">
            <CheckCheck size={16} /> Submitted {relativeTime(app.submittedAt)}.
          </p>
        ) : (
          <>
            <Button variant="primary" icon={<MousePointerClick size={14} />} loading={busy === 'auto'} disabled={missingRequired.length > 0 || (locked && busy !== 'auto')} onClick={() => void submit('auto')} title={missingRequired.length > 0 ? 'Fill in the flagged required answers first' : undefined}>
              Submit
            </Button>
            <Button icon={<FileCheck size={14} />} loading={busy === 'assist'} disabled={locked && busy !== 'assist'} onClick={() => void submit('assist')} title="Fills the form in the browser and leaves the final click to you">
              Fill and let me submit
            </Button>
            <Button variant="ghost" loading={busy === 'manual'} disabled={locked && busy !== 'manual'} onClick={() => void markSubmitted()}>
              I submitted it myself
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" icon={<Download size={14} />} loading={busy === 'pdf'} disabled={!letter.trim() || (locked && busy !== 'pdf')} onClick={() => void exportPdf()}>
            Export cover letter PDF
          </Button>
          <Button variant="ghost" icon={<SkipForward size={14} />} disabled={locked} onClick={() => onLeave(id)}>
            Skip
          </Button>
        </div>
      </div>
    </div>
  )
}
