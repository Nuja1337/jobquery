import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { LoopStatus, PipelineProgress, WorkerName, WorkerStatus } from '@shared/types'
import { KeepAwake, shouldKeepAwake, statusLine, type SleepBlocker } from './background'

const IDLE: PipelineProgress = { runId: null, phase: 'idle', message: 'Idle', done: 0, total: 0 }

function localIso(y: number, mo: number, d: number, h: number, mi: number): string {
  return new Date(y, mo - 1, d, h, mi).toISOString()
}

describe('statusLine', () => {
  const now = new Date(2026, 10, 7, 10, 0)
  it('says autopilot is off', () => {
    expect(statusLine({ autopilotEnabled: false, running: false, progress: IDLE, nextRunAt: null }, now)).toBe('Autopilot off')
  })
  it('shows the next run time', () => {
    expect(statusLine({ autopilotEnabled: true, running: false, progress: IDLE, nextRunAt: localIso(2026, 11, 7, 14, 30) }, now)).toBe('Autopilot on, next run 14:30')
  })
  it('adds the weekday for a later day', () => {
    const line = statusLine({ autopilotEnabled: true, running: false, progress: IDLE, nextRunAt: localIso(2026, 11, 8, 9, 5) }, now)
    expect(line).toBe('Autopilot on, next run Sun 09:05')
  })
  it('shows progress during a run', () => {
    const progress: PipelineProgress = { runId: 'r', phase: 'preparing', message: '', done: 3, total: 10 }
    expect(statusLine({ autopilotEnabled: true, running: true, progress, nextRunAt: null }, now)).toBe('Running: Preparing 3 of 10')
  })
  it('shows a run that has not reported progress yet', () => {
    expect(statusLine({ autopilotEnabled: false, running: true, progress: IDLE, nextRunAt: null }, now)).toBe('Running: Starting')
  })
})

describe('statusLine in continuous mode', () => {
  const now = new Date(2026, 10, 7, 10, 0)
  const worker = (patch: Partial<WorkerStatus> = {}): WorkerStatus => ({ state: 'idle', until: null, reason: null, doneToday: 0, active: 0, ...patch })
  const loop = (workers: Partial<Record<WorkerName, Partial<WorkerStatus>>>): LoopStatus => ({
    running: true,
    since: null,
    workers: { discover: worker(workers.discover), score: worker(workers.score), prepare: worker(workers.prepare), submit: worker(workers.submit) },
    today: { discovered: 0, scored: 0, prepared: 0, submitted: 0, errors: 0, costUsd: 0 }
  })
  const line = (status: LoopStatus) => statusLine({ autopilotEnabled: true, running: true, progress: IDLE, nextRunAt: null, loop: status }, now)

  it('shows how many are preparing and submitting', () => {
    expect(line(loop({ prepare: { state: 'working', active: 2 }, submit: { state: 'working', active: 1 } }))).toBe('Running continuously: 2 preparing, 1 submitting')
    expect(line(loop({}))).toBe('Running continuously: 0 preparing, 0 submitting')
  })

  it('shows the reason when every worker is paused', () => {
    const reason = 'The daily limit of 10 applications is reached.'
    const paused = (r: string | null) => worker({ state: 'paused', reason: r })
    expect(line({ ...loop({}), workers: { discover: paused(reason), score: paused(reason), prepare: paused(reason), submit: paused(reason) } })).toBe(
      'Paused: The daily limit of 10 applications is reached'
    )
    // Workers that are switched off do not count.
    expect(line({ ...loop({}), workers: { discover: paused(reason), score: paused(reason), prepare: worker({ state: 'off' }), submit: paused(reason) } })).toBe(
      'Paused: The daily limit of 10 applications is reached'
    )
  })

  it('keeps the usual line when the loop is not running', () => {
    expect(statusLine({ autopilotEnabled: true, running: false, progress: IDLE, nextRunAt: null, loop: { ...loop({}), running: false } }, now)).toBe('Autopilot on')
  })
})

describe('shouldKeepAwake', () => {
  const base = { system: DEFAULT_SETTINGS.system, autopilot: DEFAULT_SETTINGS.autopilot }
  it('stays awake during a run', () => {
    expect(shouldKeepAwake(base, true)).toBe(true)
  })
  it('stays awake while autopilot waits', () => {
    expect(shouldKeepAwake({ ...base, autopilot: { ...base.autopilot, enabled: true } }, false)).toBe(true)
  })
  it('lets the computer sleep when idle with autopilot off', () => {
    expect(shouldKeepAwake(base, false)).toBe(false)
  })
  it('lets the computer sleep when the setting is off, even during a run', () => {
    expect(shouldKeepAwake({ system: { ...base.system, keepAwake: false }, autopilot: { ...base.autopilot, enabled: true } }, true)).toBe(false)
  })
})

describe('KeepAwake', () => {
  function fakeBlocker() {
    const live = new Set<number>()
    let next = 1
    const blocker: SleepBlocker = {
      start: () => {
        live.add(next)
        return next++
      },
      stop: (id) => void live.delete(id),
      isStarted: (id) => live.has(id)
    }
    return { blocker, live }
  }

  it('starts one blocker however often it is asked', () => {
    const { blocker, live } = fakeBlocker()
    const k = new KeepAwake(blocker)
    k.set(true)
    k.set(true)
    expect(live.size).toBe(1)
    expect(k.active).toBe(true)
  })
  it('stops the blocker when it is no longer wanted', () => {
    const { blocker, live } = fakeBlocker()
    const k = new KeepAwake(blocker)
    k.set(true)
    k.set(false)
    k.set(false)
    expect(live.size).toBe(0)
    expect(k.active).toBe(false)
  })
  it('starts a new blocker if the old one was lost', () => {
    const { blocker, live } = fakeBlocker()
    const k = new KeepAwake(blocker)
    k.set(true)
    live.clear()
    k.set(true)
    expect(live.size).toBe(1)
  })
})
