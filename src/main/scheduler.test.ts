import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions } from '@shared/types'
import type { Pipeline } from './pipeline/orchestrator'
import { Scheduler } from './scheduler'
import { type TestEnv, makeTestEnv } from './testing'

const HOUR = 3_600_000

describe('Scheduler', () => {
  let env: TestEnv
  let runs: RunOptions[]
  let running: boolean
  let pipeline: Pipeline

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    env = await makeTestEnv()
    runs = []
    running = false
    pipeline = {
      isRunning: () => running,
      run: async (options: RunOptions) => {
        runs.push(options)
        const record = env.ctx.runs.start(options.trigger ?? 'manual')
        env.ctx.runs.finish(record.id, record.stats)
        return record.stats
      }
    } as unknown as Pipeline
  })

  afterEach(() => vi.useRealTimers())

  it('does nothing while autopilot is off', async () => {
    const scheduler = new Scheduler(env.ctx, pipeline)
    scheduler.start()
    expect(scheduler.nextRunAt()).toBeNull()
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(runs).toHaveLength(0)
  })

  it('runs soon after start when it has never run, then every interval', async () => {
    env.ctx.settings.update({ autopilot: { enabled: true, intervalHours: 6, autoPrepare: true, autoSubmit: false } })
    const scheduler = new Scheduler(env.ctx, pipeline)
    scheduler.start()
    expect(scheduler.nextRunAt()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(runs).toEqual([{ discover: true, triage: true, prepare: true, submit: false, trigger: 'schedule' }])
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(runs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(runs).toHaveLength(2)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(runs).toHaveLength(2)
  })

  it('counts the interval from the last run, including manual ones', async () => {
    env.ctx.settings.update({ autopilot: { enabled: true, intervalHours: 4 } })
    const record = env.ctx.runs.start('manual')
    env.ctx.runs.finish(record.id, record.stats)
    const scheduler = new Scheduler(env.ctx, pipeline)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(HOUR + 1000)
    expect(runs).toHaveLength(1)
  })

  it('picks up setting changes on reschedule', async () => {
    const scheduler = new Scheduler(env.ctx, pipeline)
    scheduler.start()
    env.ctx.settings.update({ autopilot: { enabled: true, intervalHours: 1 } })
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(runs).toHaveLength(1)
    env.ctx.settings.update({ autopilot: { enabled: false } })
    scheduler.reschedule()
    expect(scheduler.nextRunAt()).toBeNull()
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(runs).toHaveLength(1)
  })

  it('skips a tick while a run is already going and tries again soon', async () => {
    env.ctx.settings.update({ autopilot: { enabled: true, intervalHours: 6 } })
    const scheduler = new Scheduler(env.ctx, pipeline)
    running = true
    scheduler.start()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(runs).toHaveLength(0)
    expect(scheduler.nextRunAt()).not.toBeNull()
    running = false
    await vi.advanceTimersByTimeAsync(61_000)
    expect(runs).toHaveLength(1)
  })

  it('keeps going when a run throws', async () => {
    env.ctx.settings.update({ autopilot: { enabled: true, intervalHours: 1 } })
    let calls = 0
    const failing = {
      isRunning: () => false,
      run: async () => {
        calls += 1
        throw new Error('boom')
      }
    } as unknown as Pipeline
    const scheduler = new Scheduler(env.ctx, failing)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(calls).toBe(1)
    expect(scheduler.nextRunAt()).not.toBeNull()
  })
})
