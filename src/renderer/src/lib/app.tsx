import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppInfo, DeepPartial } from '@shared/api'
import type { PipelineProgress, Settings, UsageSummary } from '@shared/types'
import { api, onPush } from './api'
import { useToast } from './toast'
import { useAsync } from './hooks'

interface AppState {
  settings: Settings | null
  updateSettings: (patch: DeepPartial<Settings>) => Promise<Settings | null>
  usage: UsageSummary | null
  refreshUsage: () => void
  progress: PipelineProgress
  running: boolean
  /** True from the moment Run now is pressed until the run finishes. */
  starting: boolean
  runNow: () => Promise<void>
  cancelRun: () => Promise<void>
  /** Applications waiting in the review queue. */
  reviewCount: number
  loadError: string | null
  /** Null until loaded. */
  appInfo: AppInfo | null
}

const IDLE: PipelineProgress = { runId: null, phase: 'idle', message: 'Idle', done: 0, total: 0 }
const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const toast = useToast()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [progress, setProgress] = useState<PipelineProgress>(IDLE)
  const [starting, setStarting] = useState(false)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    api.getSettings().then(setSettings, (e: Error) => setLoadError(e.message))
    api.getPipelineStatus().then(setProgress, () => undefined)
    api.getAppInfo().then(setAppInfo, () => undefined)
    return onPush('pipeline:progress', setProgress)
  }, [])

  const usageState = useAsync(() => api.getUsage(), [], ['event:new', 'pipeline:progress', 'applications:changed'])
  const queue = useAsync(() => api.listApplications({ statuses: ['ready', 'needs_attention'], limit: 1 }), [], ['applications:changed'])
  const reloadUsage = usageState.reload
  const startingRef = useRef(false)

  const updateSettings = useCallback(
    async (patch: DeepPartial<Settings>) => {
      try {
        const next = await api.updateSettings(patch)
        setSettings(next)
        reloadUsage()
        return next
      } catch (e) {
        toast.error(e)
        return null
      }
    },
    [toast, reloadUsage]
  )

  const runNow = useCallback(async () => {
    if (startingRef.current) return
    startingRef.current = true
    setStarting(true)
    try {
      const stats = await api.runPipeline({ discover: true, triage: true, prepare: true, trigger: 'manual' })
      toast.success(`Run finished. ${stats.newJobs} new jobs, ${stats.shortlisted} shortlisted.`)
    } catch (e) {
      toast.error(e)
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }, [toast])

  const cancelRun = useCallback(async () => {
    try {
      await api.cancelPipeline()
    } catch (e) {
      toast.error(e)
    }
  }, [toast])

  const value = useMemo<AppState>(
    () => ({
      settings,
      updateSettings,
      usage: usageState.data,
      refreshUsage: reloadUsage,
      progress,
      running: progress.phase !== 'idle',
      starting,
      runNow,
      cancelRun,
      reviewCount: queue.data?.total ?? 0,
      loadError,
      appInfo
    }),
    [settings, updateSettings, usageState.data, reloadUsage, progress, starting, runNow, cancelRun, queue.data, loadError, appInfo]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
