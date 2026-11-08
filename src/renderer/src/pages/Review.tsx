import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, ArrowRight, CheckCheck, Download, FileCheck, Inbox, MousePointerClick, RefreshCw, SkipForward, TriangleAlert } from 'lucide-react'
import { clsx } from 'clsx'
import type { Application, ApplicationSummary, LintReport, PreparedAnswer } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { useAsync, useHotkeys } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { formatDateTime, plural, relativeTime } from '@renderer/lib/format'
import { FitBadge, StatusBadge } from '@renderer/components/badges'
import { answerNeedsUser, isGuess } from '@shared/answers'
import { AnswerField } from '@renderer/components/AnswerField'
import { LintPanel } from '@renderer/components/LintPanel'
import { CouldNotSendList, NeedsYouList } from '@renderer/components/ExceptionsInbox'
import { ReviewAll } from '@renderer/components/ReviewAll'
import { SentDigest } from '@renderer/components/SentDigest'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBlock, Input, Kbd, Loading, Notice, Page, PageHeader, Tabs, Textarea } from '@renderer/components/ui'

export function Review(): React.JSX.Element {
  const { id } = useParams()
  return id ? <ReviewWorkspace id={id} /> : <ReviewOverview />
}

type ReviewTab = 'needs' | 'failed' | 'sent' | 'all'
const TABS: ReviewTab[] = ['needs', 'failed', 'sent', 'all']

/** What needs the person across all applications: shared questions, failures by reason, a sample of what went out. */
function ReviewOverview(): React.JSX.Element {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const found = params.get('tab') as ReviewTab | null
  const tab: ReviewTab = found && TABS.includes(found) ? found : 'needs'
  const exceptions = useAsync(() => api.listExceptions(), [], ['applications:changed'])
  const data = exceptions.data

  const setTab = (next: ReviewTab): void => setParams(next === 'needs' ? {} : { tab: next }, { replace: true })

  if (exceptions.error && !data) {
    return (
      <Page>
        <PageHeader title="Review" />
        <ErrorBlock message={exceptions.error} onRetry={exceptions.reload} />
      </Page>
    )
  }
  if (!data) {
    return (
      <Page>
        <PageHeader title="Review" />
        <Loading />
      </Page>
    )
  }

  const openCount = data.totals.ready + data.totals.needsAttention
  if (openCount === 0 && data.sent.today === 0 && data.sent.week === 0) {
    return (
      <Page>
        <PageHeader title="Review" intro="Questions to answer once, applications that could not be sent, and a check of what went out." />
        <EmptyState
          icon={<Inbox size={24} />}
          title="Nothing to review"
          text="When jobpls drafts an application, it shows up here. Prepare one from your shortlist, or turn on auto-prepare in Settings."
          action={
            <Button variant="primary" icon={<ArrowRight size={14} />} onClick={() => navigate('/jobs')}>
              Go to the shortlist
            </Button>
          }
        />
      </Page>
    )
  }

  const failed = data.couldNotSend.reduce((n, g) => n + g.count, 0)
  return (
    <Page wide>
      <PageHeader
        title="Review"
        intro={`${plural(data.totals.ready, 'application')} ready to send. ${plural(data.totals.needsAttention, 'application')} need attention.`}
      />
      <div className="space-y-4">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { id: 'needs', label: 'Needs you', count: data.needsYou.length },
            { id: 'failed', label: "Couldn't send", count: failed },
            { id: 'sent', label: 'Sent', count: data.sent.today },
            { id: 'all', label: 'All', count: openCount }
          ]}
        />
        {tab === 'needs' && <NeedsYouList groups={data.needsYou} onChanged={exceptions.reload} />}
        {tab === 'failed' && <CouldNotSendList groups={data.couldNotSend} onChanged={exceptions.reload} />}
        {tab === 'sent' && <SentDigest sent={data.sent} onChanged={exceptions.reload} />}
        {tab === 'all' && <ReviewAll />}
      </div>
    </Page>
  )
}

function ReviewWorkspace({ id }: { id: string }): React.JSX.Element {
  const navigate = useNavigate()
  const queue = useAsync(() => api.listApplications({ statuses: ['ready', 'needs_attention'], sort: 'fit', limit: 200 }), [], ['applications:changed'])

  const items = useMemo<ApplicationSummary[]>(() => [...(queue.data?.items ?? [])].sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0) || a.createdAt.localeCompare(b.createdAt)), [queue.data])
  const activeId = id
  const index = items.findIndex((a) => a.id === activeId)
  const itemsRef = useRef(items)
  itemsRef.current = items
  /** The queue order as of the last time the open application was in it, so we know its neighbours after it leaves. */
  const lastOrderRef = useRef<string[]>([])
  if (index >= 0) lastOrderRef.current = items.map((a) => a.id)

  /** True while the open application is being submitted. Switching away then would hide the result. */
  const [navLocked, setNavLocked] = useState(false)

  const go = useCallback(
    (delta: number) => {
      if (items.length === 0 || navLocked) return
      const next = items[Math.min(items.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))]
      if (next && next.id !== activeId) navigate(`/review/${next.id}`)
    },
    [items, index, activeId, navigate, navLocked]
  )
  useHotkeys({ j: () => go(1), k: () => go(-1) })

  /** After an application leaves the queue, show the one that took its place. */
  const advance = useCallback(
    (fromId: string) => {
      const rest = itemsRef.current.filter((a) => a.id !== fromId)
      // The application may already be gone from the queue, so its place comes from the last order we saw.
      const order = lastOrderRef.current
      const i = order.indexOf(fromId)
      let next = rest[0]
      if (i >= 0) {
        const remaining = new Set(rest.map((a) => a.id))
        const nextId = order.slice(i + 1).find((x) => remaining.has(x)) ?? order.slice(0, i).reverse().find((x) => remaining.has(x))
        next = rest.find((a) => a.id === nextId) ?? next
      }
      navigate(next ? `/review/${next.id}` : '/review', { replace: true })
    },
    [navigate]
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
  return (
    <Page wide>
      <PageHeader
        title="Review queue"
        intro="Check each draft, then click Submit."
        actions={
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-xs text-faint">
              <Kbd>J</Kbd> next <Kbd>K</Kbd> previous
            </span>
            <Link to="/review" className="flex items-center gap-1.5 text-sm text-accent-strong hover:underline">
              <ArrowLeft size={14} /> All exceptions
            </Link>
          </div>
        }
      />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[17rem_minmax(0,1fr)]">
        <nav aria-label="Applications to review" className="flex gap-1.5 overflow-x-auto pb-1 xl:sticky xl:top-4 xl:block xl:max-h-[calc(100vh-8rem)] xl:space-y-1.5 xl:overflow-y-auto xl:pb-0">
          {items.map((a) => (
            <button
              key={a.id}
              onClick={() => navigate(`/review/${a.id}`)}
              disabled={navLocked && a.id !== activeId}
              aria-current={a.id === activeId}
              className={clsx('w-60 shrink-0 rounded-lg border p-2.5 text-left xl:w-full transition-colors disabled:cursor-not-allowed disabled:opacity-50', a.id === activeId ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface hover:bg-hover')}
            >
              <p className="truncate text-sm font-medium text-fg">{a.title}</p>
              <p className="truncate text-xs text-muted">{a.company}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <FitBadge bucket={a.fitBucket} score={a.fitScore} compact />
                {a.flaggedCount > 0 ? (
                  <Badge tone="warn">{a.flaggedCount} to fill</Badge>
                ) : a.guessCount > 0 ? (
                  <Badge tone="warn">{a.guessCount} to check</Badge>
                ) : (
                  <Badge tone="good">Ready</Badge>
                )}
              </div>
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          <ReviewDetail key={activeId} id={activeId} onLeave={advance} onSubmitting={setNavLocked} />
        </div>
      </div>
    </Page>
  )
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved'

function ReviewDetail({ id, onLeave, onSubmitting }: { id: string; onLeave: (id: string) => void; onSubmitting: (on: boolean) => void }): React.JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const { settings } = useApp()
  const minLint = settings?.writing.minLintScore ?? 80
  const dryRun = settings?.autopilot.dryRun ?? false

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
  /** How many single-answer regenerations are running. */
  const [regenCount, setRegenCount] = useState(0)

  const answersRef = useRef<PreparedAnswer[]>([])
  const pending = useRef<{ coverLetter?: string; answers?: PreparedAnswer[] }>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastLinted = useRef('')
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const sending = busy === 'auto' || busy === 'assist' || busy === 'manual'
  useEffect(() => {
    onSubmitting(sending)
  }, [sending, onSubmitting])
  useEffect(() => () => onSubmitting(false), [onSubmitting])

  useEffect(() => {
    let live = true
    api.getApplication(id).then(
      (a) => {
        if (!live) return
        if (!a) {
          setError('That application no longer exists.')
          return
        }
        adopt(a)
      },
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [id])

  /** Saves pending edits, one save at a time. Resolves false when the save failed and the edits are still pending. */
  const flush = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current)
    const run = saveQueue.current.then(async (): Promise<boolean> => {
      const patch = pending.current
      pending.current = {}
      if (patch.coverLetter === undefined && patch.answers === undefined) return true
      setSaveState('saving')
      try {
        const next = await api.updateApplication(id, patch)
        setApp((cur) => (cur ? { ...cur, status: next.status, flaggedCount: next.flaggedCount, updatedAt: next.updatedAt } : cur))
        setSaveState(pending.current.coverLetter !== undefined || pending.current.answers !== undefined ? 'dirty' : 'saved')
        return true
      } catch (e) {
        pending.current = { ...patch, ...pending.current }
        setSaveState('dirty')
        toast.error(e)
        return false
      }
    })
    saveQueue.current = run
    return run
  }, [id, toast])

  /** Saves pending edits and throws when that fails, so nothing runs against an older copy. */
  const saveFirst = useCallback(async (): Promise<void> => {
    if (!(await flush())) throw new Error('Your latest changes could not be saved, so nothing was changed. Try again.')
  }, [flush])

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

  /**
   * Takes the main process's copy of everything on screen. Pending edits and the save timer are
   * dropped, so a late save can't write an older value over it.
   */
  function adopt(next: Application): void {
    clearTimeout(timer.current)
    pending.current = {}
    setApp(next)
    answersRef.current = next.answers
    setAnswers(next.answers)
    setLetter(next.coverLetter ?? '')
    lastLinted.current = next.coverLetter ?? ''
    setLint(next.coverLetterLint)
    setSaveState('idle')
  }

  async function regenerateAnswer(fieldKey: string, guidance: string | null): Promise<void> {
    setRegenCount((n) => n + 1)
    try {
      await saveFirst()
      const fresh = await api.regenerateAnswer(id, fieldKey, guidance)
      const reloaded = await api.getApplication(id)
      if (reloaded) adopt(reloaded)
      toast.success(fresh.needsUser ? 'This one needs your answer.' : 'Wrote a new answer.')
    } finally {
      setRegenCount((n) => n - 1)
    }
  }

  async function regenerateLetter(): Promise<void> {
    setBusy('letter')
    try {
      await saveFirst()
      const next = await api.regenerateCoverLetter(id, letterGuidance.trim() || null)
      adopt(next)
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
      await saveFirst()
      const result = await api.submitApplication(id, mode)
      // Filling can add answers for fields first seen on the live form.
      const reloaded = await api.getApplication(id).catch(() => null)
      if (reloaded) adopt(reloaded)
      if (!result.ok) throw new Error(result.message)
      toast.success(result.message)
      // Only move on if the person is still looking at this application.
      if (result.status === 'submitted' && alive.current) onLeave(id)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  async function markSubmitted(): Promise<void> {
    setBusy('manual')
    try {
      await saveFirst()
      await api.markSubmitted(id)
      toast.success('Marked as submitted.')
      if (alive.current) onLeave(id)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  async function exportPdf(): Promise<void> {
    setBusy('pdf')
    try {
      await saveFirst()
      const path = await api.exportCoverLetterPdf(id)
      toast.success(`Saved the cover letter to ${path}`)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  function jumpToFlagged(): void {
    document.querySelector('[data-flagged]')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
  }

  if (error) return <ErrorBlock message={error} onRetry={() => navigate(0)} />
  if (!app) return <Loading />

  const fieldFor = (key: string) => app.formFields.find((f) => f.key === key)
  const needYou = answers.filter(answerNeedsUser)
  const guesses = answers.filter(isGuess)
  const done = app.status === 'submitted'
  const locked = busy !== null
  /** Edits wait while something is running that would replace what is on screen. */
  const frozen = locked || regenCount > 0 || done
  /** Main refuses to rewrite anything once the application is going out or finished. */
  const rewriteBlocked = app.status === 'submitting' || app.status === 'submitted' || app.status === 'withdrawn'
  const clickedNoConfirmation = app.submitClickedAt != null && app.status !== 'submitted'

  return (
    <div className="space-y-4">
      <Card className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight text-fg">{app.title}</h2>
            <FitBadge bucket={app.fitBucket} score={app.fitScore} />
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {app.company}<span className="text-faint">, drafted {relativeTime(app.createdAt)}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-faint" aria-live="polite">
            {saveState === 'saving' ? 'Saving' : saveState === 'dirty' ? 'Unsaved changes' : saveState === 'saved' ? 'Saved' : ''}
          </span>
          {app.status === 'ready' && guesses.length > 0 ? <Badge tone="warn">{guesses.length} to check</Badge> : <StatusBadge status={app.status} />}
          <Link to={`/jobs/${app.jobId}`} className="text-sm text-accent-strong hover:underline">
            View job
          </Link>
        </div>
      </Card>

      {app.error && <ErrorBlock message={app.error} />}

      {clickedNoConfirmation && (
        <Notice tone="warn" title="Check whether this one went through">
          The app clicked Submit on {formatDateTime(app.submitClickedAt)} and saw no confirmation. Check your email or the company&apos;s site. If it went through, mark it as submitted. If it didn&apos;t, press Fill and let me submit and send it yourself.
        </Notice>
      )}

      {needYou.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warn/50 bg-warn-soft px-4 py-2.5" role="alert">
          <p className="flex items-center gap-2 text-sm text-fg">
            <TriangleAlert size={16} className="text-warn" />
            {needYou.length === 1 ? '1 answer needs you' : `${needYou.length} answers need you`} before you can submit.
          </p>
          <Button size="sm" onClick={jumpToFlagged}>
            Show me
          </Button>
        </div>
      )}

      <Card>
        <CardHeader
          title="Cover letter"
          hint={plural(letter.trim() ? letter.trim().split(/\s+/).length : 0, 'word')}
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<Download size={13} />} loading={busy === 'pdf'} disabled={!letter.trim() || (locked && busy !== 'pdf')} onClick={() => void exportPdf()}>
                Export PDF
              </Button>
              <Button size="sm" icon={<RefreshCw size={13} />} disabled={frozen || rewriteBlocked} onClick={() => setGuidanceOpen(!guidanceOpen)} aria-expanded={guidanceOpen}>
                Regenerate
              </Button>
            </>
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
            <Button type="submit" variant="primary" loading={busy === 'letter'} disabled={frozen || rewriteBlocked}>
              Write it again
            </Button>
          </form>
        )}
        <div className="grid grid-cols-1 gap-0 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="p-4">
            <Textarea rows={16} value={letter} onChange={(e) => onLetter(e.target.value)} aria-label="Cover letter" placeholder="No cover letter yet. Press Regenerate to write one." readOnly={frozen} />
          </div>
          <aside className="border-t border-line p-4 xl:border-l xl:border-t-0" aria-label="Writing check">
            <LintPanel report={lint} min={minLint} busy={lintBusy} />
          </aside>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Application answers"
          hint={
            needYou.length > 0
              ? `${needYou.length} to fill in${guesses.length > 0 ? `, ${plural(guesses.length, 'guess', 'guesses')} to check` : ''}`
              : guesses.length > 0
                ? `All answers are filled in. ${plural(guesses.length, 'guess', 'guesses')} to check before the Submit button will send it.`
                : 'All answers are filled in.'
          }
          actions={needYou.length > 0 ? <Badge tone="warn">{needYou.length} to fill</Badge> : guesses.length > 0 ? <Badge tone="warn">{guesses.length} to check</Badge> : <Badge tone="good">Complete</Badge>}
        />
        <div className="space-y-3 p-4">
          {answers.map((a) => (
            <AnswerField key={a.fieldKey} answer={a} minLint={minLint} maxLength={fieldFor(a.fieldKey)?.maxLength} readOnly={frozen} canRegenerate={!rewriteBlocked} onChange={updateAnswer} onRegenerate={(g) => regenerateAnswer(a.fieldKey, g)} />
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
            {!clickedNoConfirmation && (
              <Button
                variant="primary"
                icon={<MousePointerClick size={14} />}
                loading={busy === 'auto'}
                disabled={needYou.length > 0 || guesses.length > 0 || (locked && busy !== 'auto') || regenCount > 0}
                onClick={() => void submit('auto')}
                title={
                  needYou.length > 0
                    ? 'Fill in the flagged answers first'
                    : guesses.length > 0
                      ? `Check these answers first: ${guesses.map((g) => g.label).join(', ')}`
                      : dryRun
                        ? 'Dry run is on. This fills the form and stops before the final click.'
                        : undefined
                }
              >
                Submit
              </Button>
            )}
            <Button icon={<FileCheck size={14} />} loading={busy === 'assist'} disabled={(locked && busy !== 'assist') || regenCount > 0} onClick={() => void submit('assist')} title="Fills the form in the browser and leaves the final click to you">
              Fill and let me submit
            </Button>
            <Button variant={clickedNoConfirmation ? 'secondary' : 'ghost'} loading={busy === 'manual'} disabled={(locked && busy !== 'manual') || regenCount > 0} onClick={() => void markSubmitted()}>
              I submitted it myself
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" icon={<SkipForward size={14} />} disabled={locked || regenCount > 0} onClick={() => onLeave(id)}>
            Skip
          </Button>
        </div>
        {!done && !clickedNoConfirmation && (needYou.length > 0 || guesses.length > 0) && (
          <p className="basis-full text-xs text-muted">
            {needYou.length > 1
              ? 'Submit turns on once the flagged answers are filled in.'
              : needYou.length === 1
                ? 'Submit turns on once the flagged answer is filled in.'
                : 'Submit turns on once you check each guess. Edit it or press Looks right.'}
          </p>
        )}
        {dryRun && !done && !clickedNoConfirmation && <p className="basis-full text-xs text-muted">Dry run is on. Submit fills the form and stops before the final click. You can turn it off in Settings.</p>}
      </div>
    </div>
  )
}
