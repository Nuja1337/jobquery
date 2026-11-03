import { useEffect, useRef, useState } from 'react'
import { BookmarkPlus, Check, RefreshCw, TriangleAlert } from 'lucide-react'
import { clsx } from 'clsx'
import type { AnswerKind, PreparedAnswer } from '@shared/types'
import { AUTO_SUBMIT_MIN_CONFIDENCE, answerNeedsUser, isGuess } from '@shared/answers'
import { api } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { basename, parseMulti, stringifyMulti } from '@renderer/lib/format'
import { AnswerSourceBadge } from './badges'
import { LintScore } from './LintPanel'
import { Badge, Button, Checkbox, Field, Input, Modal, Select, Textarea } from './ui'

interface Props {
  answer: PreparedAnswer
  minLint: number
  /** Character limit the form states, if any. */
  maxLength?: number | null
  /** Locks the field while a submit or a regenerate is running, so a late save can't overwrite the result. */
  readOnly?: boolean
  /** False when the application is going out or finished, and the main process refuses to rewrite answers. */
  canRegenerate?: boolean
  onChange: (next: PreparedAnswer) => void
  onRegenerate: (guidance: string | null) => Promise<void>
}

export function AnswerField({ answer, minLint, maxLength, readOnly, canRegenerate: mayRegenerate = true, onChange, onRegenerate }: Props): React.JSX.Element {
  const toast = useToast()
  const [guidanceOpen, setGuidanceOpen] = useState(false)
  const [guidance, setGuidance] = useState('')
  const [busy, setBusy] = useState(false)
  const [bankOpen, setBankOpen] = useState(false)
  const [lint, setLint] = useState(answer.lint)
  const flagged = answerNeedsUser(answer)
  const guess = isGuess(answer)
  const locked = !!readOnly || busy
  const isLong = answer.type === 'textarea'
  const lastLinted = useRef(answer.value)

  // Re-lint long answers a moment after the person stops typing.
  useEffect(() => {
    if (!isLong || answer.value === lastLinted.current) return
    const t = setTimeout(() => {
      lastLinted.current = answer.value
      api.lintText(answer.value).then(setLint, () => undefined)
    }, 600)
    return () => clearTimeout(t)
  }, [answer.value, isLong])

  useEffect(() => {
    setLint(answer.lint)
    lastLinted.current = answer.value
    // Only reset when the server hands back a new lint report (after Regenerate).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer.lint])

  function setValue(value: string): void {
    onChange({ ...answer, value, source: 'user', confidence: 1, needsUser: answer.needsUser && !value.trim() && value !== 'false' })
  }

  /** Confirms a guess as it stands. It is saved like any other edit. */
  function confirmGuess(): void {
    onChange({ ...answer, source: 'user', confidence: 1 })
  }

  async function regenerate(): Promise<void> {
    setBusy(true)
    try {
      await onRegenerate(guidance.trim() || null)
      setGuidanceOpen(false)
      setGuidance('')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const id = `ans-${answer.fieldKey}`
  let control: React.ReactNode
  switch (answer.type) {
    case 'textarea':
      control = (
        <>
          <Textarea id={id} rows={5} value={answer.value} onChange={(e) => setValue(e.target.value)} />
          {maxLength != null && (
            <p className={clsx('mt-1 text-right text-xs tabular-nums', answer.value.length > maxLength ? 'text-bad' : 'text-faint')}>
              {answer.value.length} of {maxLength} characters
            </p>
          )}
        </>
      )
      break
    case 'select':
      control = (
        <Select id={id} value={answer.value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose one</option>
          {answer.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      )
      break
    case 'radio':
      control = (
        <div className="flex flex-wrap gap-4" role="radiogroup" aria-label={answer.label}>
          {answer.options.map((o) => (
            <label key={o} className="flex cursor-pointer items-center gap-2 text-sm text-fg">
              <input type="radio" name={id} checked={answer.value === o} onChange={() => setValue(o)} />
              {o}
            </label>
          ))}
        </div>
      )
      break
    case 'multiselect':
    case 'checkboxes': {
      const picked = parseMulti(answer.value)
      control = (
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {answer.options.map((o) => (
            <Checkbox key={o} label={o} checked={picked.includes(o)} onChange={(on) => setValue(stringifyMulti(on ? [...picked, o] : picked.filter((x) => x !== o)))} />
          ))}
        </div>
      )
      break
    }
    case 'checkbox':
      control = <Checkbox label="Yes" ariaLabel={answer.label} checked={answer.value === 'true'} onChange={(on) => setValue(on ? 'true' : 'false')} />
      break
    case 'file':
      control = (
        <p className="truncate rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs text-muted" title={answer.value}>
          {answer.value ? basename(answer.value) : 'No file chosen'}
        </p>
      )
      break
    case 'combobox': {
      const listId = `${id}-options`
      control = (
        <>
          <Input id={id} list={listId} value={answer.value} onChange={(e) => setValue(e.target.value)} />
          <datalist id={listId}>
            {answer.options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </>
      )
      break
    }
    default:
      control = <Input id={id} type={answer.type === 'date' ? 'date' : answer.type === 'number' ? 'number' : answer.type} value={answer.value} onChange={(e) => setValue(e.target.value)} />
  }

  const canRegenerate = answer.type !== 'file' && mayRegenerate
  const canBank = (answer.type === 'text' || answer.type === 'textarea') && !!answer.value.trim()

  return (
    <div className={clsx('rounded-lg border p-3.5', flagged ? 'border-warn/60 bg-warn-soft' : guess ? 'border-warn/40 bg-surface' : 'border-line bg-surface')} data-flagged={flagged || guess || undefined} data-answer={answer.fieldKey}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {answer.label}
          {answer.required && <span className="text-bad"> *</span>}
        </label>
        <div className="flex shrink-0 items-center gap-1.5">
          {flagged && (
            <Badge tone="warn">
              <TriangleAlert size={11} /> {answer.required ? 'Needs your answer' : 'Check this'}
            </Badge>
          )}
          {!flagged && guess && (
            <Badge tone="warn" title={`Below ${Math.round(AUTO_SUBMIT_MIN_CONFIDENCE * 100)}% sure. The Submit button won't send this application while it's a guess. Edit it or press Looks right.`}>
              <TriangleAlert size={11} /> Check this guess
            </Badge>
          )}
          <AnswerSourceBadge source={answer.source} />
          {answer.source !== 'user' && answer.source !== 'file' && (answer.value.trim() || flagged) && (
            <Badge tone={guess ? 'warn' : answer.confidence >= 0.8 ? 'good' : 'neutral'} title="How sure JobPilot is about this answer">
              {Math.round(answer.confidence * 100)}%
            </Badge>
          )}
        </div>
      </div>

      <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
        {control}
      </fieldset>

      {answer.note && <p className="mt-2 text-xs text-muted">{answer.note}</p>}
      {isLong && lint && (
        <div className="mt-2 flex items-center gap-3">
          <LintScore score={lint.score} min={minLint} />
          {lint.issues.length > 0 && <span className="text-xs text-muted">{lint.issues[0].message}{lint.issues.length > 1 ? ` and ${lint.issues.length - 1} more` : ''}</span>}
        </div>
      )}

      {(canRegenerate || canBank || guess) && (
        <div className="mt-2.5 flex items-center gap-2">
          {guess && (
            <Button size="sm" variant="secondary" icon={<Check size={12} />} disabled={locked} onClick={confirmGuess} title="Keep this answer as it is and stop treating it as a guess">
              Looks right
            </Button>
          )}
          {canRegenerate && (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={locked} onClick={() => setGuidanceOpen(!guidanceOpen)}>
              Regenerate
            </Button>
          )}
          {canBank && (
            <Button size="sm" variant="ghost" icon={<BookmarkPlus size={12} />} disabled={!!readOnly} onClick={() => setBankOpen(true)}>
              Save answer to bank
            </Button>
          )}
        </div>
      )}
      {guidanceOpen && canRegenerate && (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!locked) void regenerate()
          }}
        >
          <fieldset disabled={locked} className="m-0 flex min-w-0 items-center gap-2 border-0 p-0">
            <Input autoFocus value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="Guidance, for example: mention the open source project" aria-label="Guidance for the new answer" />
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={locked}>
              Write it again
            </Button>
          </fieldset>
        </form>
      )}
      {bankOpen && <SaveToBank answer={answer} onClose={() => setBankOpen(false)} />}
    </div>
  )
}

function SaveToBank({ answer, onClose }: { answer: PreparedAnswer; onClose: () => void }): React.JSX.Element {
  const toast = useToast()
  const [question, setQuestion] = useState(answer.label)
  const [kind, setKind] = useState<AnswerKind>(answer.type === 'textarea' ? 'template' : 'fact')
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    setBusy(true)
    try {
      await api.saveAnswer({ question: question.trim(), answer: answer.value, kind })
      toast.success('Saved to your answer bank.')
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Save answer to bank"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!question.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Question">
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <Field label="Use it as" hint={kind === 'fact' ? 'Reused word for word whenever the same question comes up.' : 'A starting point. The AI adapts it to each company.'}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as AnswerKind)}>
            <option value="fact">Fact</option>
            <option value="template">Template</option>
          </Select>
        </Field>
        <p className="whitespace-pre-wrap rounded-md border border-line bg-bg p-2.5 text-sm text-muted">{answer.value}</p>
      </div>
    </Modal>
  )
}
