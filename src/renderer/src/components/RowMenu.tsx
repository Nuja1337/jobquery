import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { clsx } from 'clsx'
import { IconButton } from '@renderer/components/ui'

export interface RowMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

/** A small menu of row actions. It opens at the button and closes on a click elsewhere, Escape or scroll. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }): React.JSX.Element {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!at) return
    const close = (): void => setAt(null)
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [at])

  return (
    <div ref={root} className="inline-block">
      <IconButton
        label={label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={(e) => {
          if (at) return setAt(null)
          const box = e.currentTarget.getBoundingClientRect()
          setAt({ top: box.bottom + 4, right: window.innerWidth - box.right })
        }}
      >
        <MoreHorizontal size={15} />
      </IconButton>
      {at && (
        <div role="menu" style={{ top: at.top, right: at.right }} className="fixed z-30 min-w-44 rounded-md border border-line-strong bg-raised py-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setAt(null)
                item.onSelect()
              }}
              className={clsx('block w-full px-3 py-1.5 text-left text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50', item.danger ? 'text-bad' : 'text-fg')}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
