import { useEffect, useRef, useState } from 'react'
import { Check, ListChecks, Plus, X } from 'lucide-react'
import type { BoardImportLine, BoardProbe } from '@shared/api'
import { onPush, api } from '@renderer/lib/api'
import { plural } from '@renderer/lib/format'
import { useToast } from '@renderer/lib/toast'
import { addedMessage } from '@renderer/components/StartFast'
import { atsLabel } from '@renderer/components/companyLabels'
import { Button, Field, Textarea } from '@renderer/components/ui'

type Phase = 'idle' | 'checking' | 'checked'
type ReadableLine = Extract<BoardImportLine, { ats: unknown }>

/** Boards sent to the main process per call. A small step keeps Stop responsive. */
const STEP = 25
/** Result rows drawn at once. The counts above the list cover the rest. */
const MAX_ROWS = 300
const MAX_UNREADABLE = 50

const isReadable = (l: BoardImportLine): l is ReadableLine => 'ats' in l
const keyOf = (b: { ats: string; token: string }): string => `${b.ats}:${b.token.toLowerCase()}`
const count = (n: number): string => n.toLocaleString('en-US')

/** Paste a list of careers links, check each board with live progress, then add the ones that answer. */
export function BoardImport({ onAdded }: { onAdded: () => void }): React.JSX.Element {
  const toast = useToast()
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [lines, setLines] = useState<BoardImportLine[]>([])
  const [probes, setProbes] = useState<BoardProbe[]>([])
  const [total, setTotal] = useState(0)
  const [adding, setAdding] = useState(false)
  const stopped = useRef(false)
  const buffer = useRef<BoardProbe[]>([])
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      stopped.current = true
      if (flushTimer.current) clearTimeout(flushTimer.current)
    },
    []
  )

  /** Results arrive one by one. They are drawn in batches so a long list stays smooth. */
  function flush(): void {
    flushTimer.current = null
    if (buffer.current.length === 0) return
    const batch = buffer.current.splice(0)
    setProbes((prev) => [...prev, ...batch])
  }

  async function check(): Promise<void> {
    setProbes([])
    setLines([])
    setTotal(0)
    stopped.current = false
    setPhase('checking')
    let off: (() => void) | null = null
    try {
      const parsed = await api.parseBoardImport(text)
      setLines(parsed)
      const boards = parsed.filter(isReadable)
      setTotal(boards.length)
      const runToken = Math.random().toString(36).slice(2)
      off = onPush('boards:probe', (e) => {
        if (e.token !== runToken) return
        buffer.current.push(e.result)
        flushTimer.current ??= setTimeout(flush, 120)
      })
      for (let i = 0; i < boards.length && !stopped.current; i += STEP) {
        await api.probeBoards(
          boards.slice(i, i + STEP).map((b) => ({ ats: b.ats, token: b.token })),
          runToken
        )
      }
    } catch (e) {
      toast.error(e)
    } finally {
      off?.()
      if (flushTimer.current) clearTimeout(flushTimer.current)
      flush()
      setPhase('checked')
    }
  }

  function clear(): void {
    stopped.current = true
    setText('')
    setLines([])
    setProbes([])
    setTotal(0)
    setPhase('idle')
  }

  const names = new Map(lines.filter(isReadable).map((l) => [keyOf(l), l.name]))
  const answered = probes.filter((p): p is Extract<BoardProbe, { ok: true }> => p.ok)
  const failed = probes.length - answered.length
  const unreadable = lines.filter((l): l is Extract<BoardImportLine, { error: string }> => !isReadable(l))
  const checking = phase === 'checking'

  async function add(): Promise<void> {
    setAdding(true)
    try {
      const result = await api.importBoards(answered.map((p) => ({ ats: p.ats, token: p.token, name: p.name ?? names.get(keyOf(p)) ?? null })))
      toast.success(addedMessage(result))
      clear()
      onAdded()
    } catch (e) {
      toast.error(e)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Paste careers links, posting links or ats:token lines, one per line" hint="Examples are https://boards.greenhouse.io/stripe and lever:spotify. Lines that start with # are skipped.">
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'greenhouse:stripe\nhttps://jobs.lever.co/spotify\nhttps://jobs.ashbyhq.com/linear'} spellCheck={false} className="font-mono text-xs" disabled={checking} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button icon={<ListChecks size={14} />} loading={checking} disabled={!text.trim() || adding} onClick={() => void check()}>
          Check
        </Button>
        {checking && (
          <Button variant="ghost" onClick={() => (stopped.current = true)}>
            Stop
          </Button>
        )}
        {phase !== 'idle' && !checking && (
          <Button variant="ghost" onClick={clear}>
            Clear
          </Button>
        )}
        {phase !== 'idle' && (
          <p className="text-xs text-muted" aria-live="polite">
            {checking ? `Checked ${count(probes.length)} of ${count(total)}. ` : ''}
            {count(answered.length)} can be added{failed > 0 ? `, ${count(failed)} did not answer` : ''}
            {unreadable.length > 0 ? `, ${count(unreadable.length)} cannot be read` : ''}.
          </p>
        )}
        <div className="flex-1" />
        {phase === 'checked' && answered.length > 0 && (
          <Button variant="primary" icon={<Plus size={14} />} loading={adding} onClick={() => void add()}>
            Add {plural(answered.length, 'board')}
          </Button>
        )}
      </div>

      {probes.length > 0 && (
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-bg text-sm">
          {probes.slice(0, MAX_ROWS).map((p) => (
            <li key={keyOf(p)} className="flex items-start gap-2 px-3 py-1.5">
              {p.ok ? <Check size={14} className="mt-0.5 shrink-0 text-good" aria-label="Answered" /> : <X size={14} className="mt-0.5 shrink-0 text-bad" aria-label="Did not answer" />}
              <span className="min-w-0 flex-1">
                <span className="font-medium text-fg">{p.ok ? (p.name ?? names.get(keyOf(p)) ?? p.token) : `${p.ats}:${p.token}`}</span>
                <span className="ml-2 text-xs text-faint">{atsLabel(p.ats)}</span>
                {!p.ok && <span className="block text-xs text-bad">{p.error}</span>}
              </span>
              {p.ok && <span className="shrink-0 text-xs tabular-nums text-muted">{plural(p.jobs, 'job')}</span>}
            </li>
          ))}
          {probes.length > MAX_ROWS && <li className="px-3 py-1.5 text-xs text-faint">And {count(probes.length - MAX_ROWS)} more are not shown. They are still added.</li>}
        </ul>
      )}

      {unreadable.length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
          <p className="font-medium text-warn">
            {plural(unreadable.length, 'line')} cannot be read, so {unreadable.length === 1 ? 'it stays' : 'they stay'} manual.
          </p>
          <p className="mt-0.5 text-xs text-muted">JobQuery cannot read the jobs on systems such as Workday yet. Add one from its careers page address above to keep it on your list without automatic checks.</p>
          <ul className="mt-2 space-y-1 text-xs">
            {unreadable.slice(0, MAX_UNREADABLE).map((l) => (
              <li key={l.line}>
                <span className="break-all font-mono text-fg">{l.line}</span>
                <span className="block text-muted">{l.error}</span>
              </li>
            ))}
            {unreadable.length > MAX_UNREADABLE && <li className="text-faint">And {count(unreadable.length - MAX_UNREADABLE)} more.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
