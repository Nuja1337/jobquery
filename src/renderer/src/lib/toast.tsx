import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { clsx } from 'clsx'
import { errorMessage } from './format'

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  success: (message: string) => void
  info: (message: string) => void
  /** Shows the message of a thrown Error. */
  error: (e: unknown) => void
}

const Ctx = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), [])
  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = Date.now() + Math.random()
      setItems((list) => [...list.slice(-3), { id, kind, message }])
      setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000)
    },
    [dismiss]
  )

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      info: (m) => push('info', m),
      error: (e) => push('error', errorMessage(e))
    }),
    [push]
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-96 flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={clsx(
              'animate-slide-in pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-raised px-3 py-2.5 text-sm shadow-xl',
              t.kind === 'error' ? 'border-bad/40' : t.kind === 'success' ? 'border-good/40' : 'border-line-strong'
            )}
          >
            {t.kind === 'error' ? <AlertCircle size={16} className="mt-0.5 shrink-0 text-bad" /> : t.kind === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good" /> : <Info size={16} className="mt-0.5 shrink-0 text-info" />}
            <p className="min-w-0 flex-1 break-words text-fg">{t.message}</p>
            <button onClick={() => dismiss(t.id)} className="text-faint hover:text-fg" aria-label="Dismiss message">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
