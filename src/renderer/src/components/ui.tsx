import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { AlertCircle, Loader2, X } from 'lucide-react'
import { clsx } from 'clsx'

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  loading?: boolean
  icon?: ReactNode
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-strong disabled:bg-accent/40 disabled:text-accent-fg/70',
  secondary: 'border border-line-strong bg-raised text-fg hover:bg-hover disabled:text-faint',
  ghost: 'text-muted hover:bg-hover hover:text-fg disabled:text-faint',
  danger: 'border border-bad/40 bg-bad-soft text-bad hover:bg-bad/20 disabled:opacity-50'
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        BUTTON_VARIANTS[variant],
        className
      )}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ label, className, children, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }): React.JSX.Element {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={clsx('inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-hover disabled:opacity-40', active ? 'text-warn' : 'text-faint hover:text-fg', className)}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

export function PageHeader({ title, intro, actions }: { title: string; intro?: string; actions?: ReactNode }): React.JSX.Element {
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {intro && <p className="mt-0.5 text-sm text-muted">{intro}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div {...rest} className={clsx('rounded-lg border border-line bg-surface', className)}>
      {children}
    </div>
  )
}

export function CardHeader({ title, hint, actions }: { title: string; hint?: string; actions?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-fg">{title}</h2>
        {hint && <p className="text-xs text-faint">{hint}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Section({ title, hint, children, actions }: { title: string; hint?: string; children: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return (
    <Card className="mb-4">
      <CardHeader title={title} hint={hint} actions={actions} />
      <div className="space-y-4 p-4">{children}</div>
    </Card>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={clsx('mt-1 text-2xl font-semibold tabular-nums tracking-tight', tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-fg')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  )
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text: string; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-6 py-12 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted">{text}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return <Loader2 size={16} className={clsx('animate-spin text-faint', className)} aria-label="Loading" />
}

export function Loading({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-faint" role="status">
      <Spinner />
      {label}
    </div>
  )
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-bad/40 bg-bad-soft px-4 py-3 text-sm" role="alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-bad" />
      <div className="min-w-0 flex-1">
        <p className="text-fg">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

export function Notice({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode; title?: string }): React.JSX.Element {
  const styles = { info: 'border-info/30 bg-info-soft', warn: 'border-warn/40 bg-warn-soft', bad: 'border-bad/40 bg-bad-soft', good: 'border-good/40 bg-good-soft' }
  return (
    <div className={clsx('rounded-lg border px-3.5 py-2.5 text-sm', styles[tone])}>
      {title && <p className="mb-0.5 font-medium text-fg">{title}</p>}
      <div className="text-muted">{children}</div>
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd className="rounded border border-line-strong bg-raised px-1.5 py-px font-mono text-[11px] text-muted">{children}</kbd>
}

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'warn' | 'bad' }): React.JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={clsx('h-full rounded-full transition-all', tone === 'accent' ? 'bg-accent' : tone === 'warn' ? 'bg-warn' : 'bg-bad')} style={{ width: `${pct}%` }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Badges and chips
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent'

const TONES: Record<Tone, string> = {
  neutral: 'bg-hover text-muted',
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent-strong'
}

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }): React.JSX.Element {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium leading-4', TONES[tone], className)}>
      {children}
    </span>
  )
}

export function Chip({ children, onRemove, onClick, selected, className }: { children: ReactNode; onRemove?: () => void; onClick?: () => void; selected?: boolean; className?: string }): React.JSX.Element {
  const body = (
    <>
      {children}
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onRemove()
            }
          }}
          className="-mr-0.5 rounded text-faint hover:text-fg"
        >
          <X size={12} />
        </span>
      )}
    </>
  )
  const cls = clsx(
    'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
    selected ? 'border-accent/60 bg-accent-soft text-accent-strong' : 'border-line-strong bg-raised text-muted',
    onClick && !selected && 'hover:bg-hover hover:text-fg',
    className
  )
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={selected} className={cls}>
      {body}
    </button>
  ) : (
    <span className={cls}>{body}</span>
  )
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const CONTROL =
  'rounded-md border border-line-strong bg-bg px-2.5 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60'

/** Controls fill their container unless the caller sets a width. */
const fill = (className?: string): string | undefined => (className && /(^|\s)w-/.test(className) ? undefined : 'w-full')

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...rest} className={clsx(CONTROL, fill(className), 'h-8', className)} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea {...rest} className={clsx(CONTROL, fill(className), 'py-1.5 leading-relaxed', className)} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select {...rest} className={clsx(CONTROL, fill(className), 'h-8 pr-6', className)}>
      {children}
    </select>
  )
}

export function Field({ label, hint, children, className, required }: { label?: string; hint?: ReactNode; children: ReactNode; className?: string; required?: boolean }): React.JSX.Element {
  const id = useId()
  return (
    <div className={clsx('min-w-0', className)}>
      {label && (
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
          {label}
          {required && <span className="text-bad"> *</span>}
        </label>
      )}
      <FieldControl id={id}>{children}</FieldControl>
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  )
}

/** Gives the first child control the label's id. */
function FieldControl({ id, children }: { id: string; children: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current?.querySelector('input, textarea, select')
    if (el && !el.id) el.id = id
  }, [id])
  return <div ref={ref}>{children}</div>
}

export function Toggle({ checked, onChange, label, hint, disabled, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: string; hint?: ReactNode; disabled?: boolean; ariaLabel?: string }): React.JSX.Element {
  return (
    <label className={clsx('flex items-start gap-3', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-sm text-fg">{label}</span>}
          {hint && <span className="block text-xs text-faint">{hint}</span>}
        </span>
      )}
    </label>
  )
}

export function Checkbox({ checked, onChange, label, disabled, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; ariaLabel?: string }): React.JSX.Element {
  return (
    <label className={clsx('flex items-center gap-2 text-sm text-fg', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5" />
      {label}
    </label>
  )
}

/** Comma or Enter adds a chip. Backspace on an empty field removes the last one. */
export function TagInput({ value, onChange, placeholder, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[] }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  function commit(raw: string): void {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (!parts.length) return
    onChange([...value, ...parts.filter((p) => !value.includes(p))])
    setDraft('')
  }
  const listId = useId()
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-bg px-1.5 py-1 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
      {value.map((v) => (
        <Chip key={v} onRemove={() => onChange(value.filter((x) => x !== v))}>
          {v}
        </Chip>
      ))}
      <input
        value={draft}
        list={suggestions ? listId : undefined}
        onChange={(e) => {
          if (e.target.value.endsWith(',')) commit(e.target.value)
          else setDraft(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => commit(draft)}
        placeholder={value.length ? '' : placeholder}
        className="min-w-24 flex-1 bg-transparent px-1 text-sm text-fg placeholder:text-faint focus:outline-none"
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  )
}

export function NumberInput({ value, onChange, min, max, step, placeholder, className }: { value: number | null; onChange: (v: number | null) => void; min?: number; max?: number; step?: number; placeholder?: string; className?: string }): React.JSX.Element {
  return (
    <Input
      type="number"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      className={className}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  )
}

// ---------------------------------------------------------------------------
// Tabs and segmented controls
// ---------------------------------------------------------------------------

export function Tabs<T extends string>({ items, value, onChange }: { items: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void }): React.JSX.Element {
  return (
    <div className="flex gap-1 border-b border-line" role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors', value === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
        >
          {t.label}
          {t.count != null && <span className="rounded bg-hover px-1.5 text-[11px] tabular-nums text-faint">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Segmented<T extends string | number>({ items, value, onChange }: { items: Array<{ id: T; label: string }>; value: T; onChange: (id: T) => void }): React.JSX.Element {
  return (
    <div className="inline-flex rounded-md border border-line-strong bg-bg p-0.5">
      {items.map((t) => (
        <button
          key={String(t.id)}
          onClick={() => onChange(t.id)}
          aria-pressed={value === t.id}
          className={clsx('rounded px-2.5 py-1 text-xs font-medium transition-colors', value === t.id ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open dialogs, newest last. Only the newest one answers Escape and Tab. */
const openModals: object[] = []

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Read while rendering. Effects run after the browser has already moved focus to an autoFocus field.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined)
  if (openerRef.current === undefined) openerRef.current = document.activeElement as HTMLElement | null

  useEffect(() => {
    const token = {}
    openModals.push(token)
    const opener = openerRef.current
    const dialog = dialogRef.current
    // Move focus in unless a field inside already took it (autoFocus).
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? dialog).focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (openModals[openModals.length - 1] !== token || !dialogRef.current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        e.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!dialogRef.current.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const at = openModals.indexOf(token)
      if (at >= 0) openModals.splice(at, 1)
      if (opener && opener.isConnected) opener.focus()
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'var(--overlay)' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={clsx('animate-slide-in flex outline-none max-h-[85vh] w-full flex-col rounded-xl border border-line-strong bg-surface shadow-2xl', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const TH = 'sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-faint'
export const TD = 'border-b border-line px-3 py-2 align-middle'

export function Page({ children, narrow, wide }: { children: ReactNode; narrow?: boolean; wide?: boolean }): React.JSX.Element {
  return <div className={clsx('mx-auto px-6 py-5', narrow ? 'max-w-3xl' : wide ? 'max-w-[1500px]' : 'max-w-6xl')}>{children}</div>
}
