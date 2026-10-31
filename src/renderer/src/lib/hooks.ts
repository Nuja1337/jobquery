import { useCallback, useEffect, useRef, useState } from 'react'
import type { PushChannel } from '@shared/api'
import { onPush } from './api'
import { errorMessage } from './format'

export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
  setData: (updater: T | null | ((prev: T | null) => T | null)) => void
}

/** Loads data when deps change. Keeps the old data on screen while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], channels: PushChannel[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const run = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const load = useCallback(() => {
    const id = ++run.current
    setLoading(true)
    fnRef.current().then(
      (value) => {
        if (id !== run.current) return
        setData(value)
        setError(null)
        setLoading(false)
      },
      (e: unknown) => {
        if (id !== run.current) return
        setError(errorMessage(e))
        setLoading(false)
      }
    )
  }, [])

  useEffect(load, deps) // eslint-disable-line react-hooks/exhaustive-deps

  const channelKey = channels.join(',')
  useEffect(() => {
    if (!channelKey) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const trigger = (): void => {
      clearTimeout(timer)
      timer = setTimeout(load, 250)
    }
    const offs = (channelKey.split(',') as PushChannel[]).map((c) => onPush(c, trigger as never))
    return () => {
      clearTimeout(timer)
      offs.forEach((off) => off())
    }
  }, [channelKey, load])

  return { data, error, loading, reload: load, setData }
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Runs a handler on a key press unless focus is in a form field. */
export function useHotkeys(map: Record<string, () => void>, enabled = true): void {
  const ref = useRef(map)
  ref.current = map
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const fn = ref.current[e.key.toLowerCase()]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (v: T) => {
      setValue(v)
      try {
        localStorage.setItem(key, JSON.stringify(v))
      } catch {
        // storage can be unavailable; the value still works for this session
      }
    },
    [key]
  )
  return [value, set]
}
