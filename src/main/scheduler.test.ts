import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions } from '@shared/types'
import type { WorkLoop } from './pipeline/loop'
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
  it('runs an overdue run within a minute after the computer wakes', async () => {
    env.ctx.settings.update({ autopilot: { enabled: true, intervalHours: 6 } })
    const record = env.ctx.runs.start('manual')
    env.ctx.runs.finish(record.id, record.stats)
    const scheduler = new Scheduler(env.ctx, pipeline)
    scheduler.start()
    // The computer sleeps for 7 hours. The clock moves on, but the timer's own clock does not.
    vi.setSystemTime(Date.now() + 7 * HOUR)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runs).toHaveLength(0)
    scheduler.resume()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(runs).toHaveLength(1)
  })

  it('keeps the next run time after waking when nothing was missed', async () => {
    env.ctx.settings.update({ autopilot: { enabled: true, intervalHours: 6 } })
    const record = env.ctx.runs.start('manual')
    env.ctx.runs.finish(record.id, record.stats)
    const scheduler = new Scheduler(env.ctx, pipeline)
    scheduler.start()
    const before = scheduler.nextRunAt()
    await vi.advanceTimersByTimeAsync(HOUR)
    scheduler.resume()
    expect(scheduler.nextRunAt()).toBe(before)
    await vi.advanceTimersByTimeAsync(5 * HOUR + 1000)
    expect(runs).toHaveLength(1)
  })

  it('does nothing on wake while autopilot is off', async () => {
    const scheduler = new Scheduler(env.ctx, pipeline)
    scheduler.start()
    scheduler.resume()
    expect(scheduler.nextRunAt()).toBeNull()
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(runs).toHaveLength(0)
  })

  describe('continuous mode', () => {
    function fakeLoop() {
      const calls = { start: 0, stop: 0, wake: 0 }
      let on = false
      const loop = {
        isRunning: () => on,
        start: () => {
          calls.start += 1
          on = true
        },
        stop: async () => {
          // Like the real loop, stopping one that is not running does nothing.
          if (on) calls.stop += 1
          on = false
        },
        wake: () => {
          calls.wake += 1
        }
      } as unknown as WorkLoop
      return { loop, calls }
    }

    it('starts the loop and sets no timer, and does not run batches', async () => {
      env.ctx.settings.update({ autopilot: { enabled: true, mode: 'continuous' } })
      const { loop, calls } = fakeLoop()
      const scheduler = new Scheduler(env.ctx, pipeline, loop)
      scheduler.start()
      expect(calls.start).toBe(1)
      expect(scheduler.nextRunAt()).toBeNull()
      await vi.advanceTimersByTimeAsync(24 * HOUR)
      expect(runs).toHaveLength(0)
    })

    it('wakes a running loop on every reschedule instead of starting it again', () => {
      env.ctx.settings.update({ autopilot: { enabled: true, mode: 'continuous' } })
      const { loop, calls } = fakeLoop()
      const scheduler = new Scheduler(env.ctx, pipeline, loop)
      scheduler.start()
      env.ctx.settings.update({ routing: { triage: null } })
      scheduler.reschedule()
      expect(calls).toMatchObject({ start: 1, wake: 1 })
    })

    it('stops the loop when autopilot is turned off or the mode goes back to interval, and then runs on the timer', async () => {
      env.ctx.settings.update({ autopilot: { enabled: true, mode: 'continuous', intervalHours: 1 } })
      const { loop, calls } = fakeLoop()
      const scheduler = new Scheduler(env.ctx, pipeline, loop)
      scheduler.start()
      env.ctx.settings.update({ autopilot: { mode: 'interval' } })
      scheduler.reschedule()
      expect(calls.stop).toBe(1)
      expect(scheduler.nextRunAt()).not.toBeNull()
      await vi.advanceTimersByTimeAsync(61_000)
      expect(runs).toHaveLength(1)

      env.ctx.settings.update({ autopilot: { mode: 'continuous' } })
      scheduler.reschedule()
      expect(calls.start).toBe(2)
      env.ctx.settings.update({ autopilot: { enabled: false } })
      scheduler.reschedule()
      expect(calls.stop).toBe(2)
    })

    it('waits for a batch run that is going before it starts the loop', async () => {
      env.ctx.settings.update({ autopilot: { enabled: true, mode: 'continuous' } })
      const { loop, calls } = fakeLoop()
      running = true
      const scheduler = new Scheduler(env.ctx, pipeline, loop)
      scheduler.start()
      expect(calls.start).toBe(0)
      running = false
      await vi.advanceTimersByTimeAsync(61_000)
      expect(calls.start).toBe(1)
      expect(runs).toHaveLength(0)
    })

    it('stops the loop with the scheduler', async () => {
      env.ctx.settings.update({ autopilot: { enabled: true, mode: 'continuous' } })
      const { loop, calls } = fakeLoop()
      const scheduler = new Scheduler(env.ctx, pipeline, loop)
      scheduler.start()
      await scheduler.stop()
      expect(calls.stop).toBe(1)
    })
  })

  it('tells its listener whenever the schedule is worked out again', async () => {
    let calls = 0
    const scheduler = new Scheduler(env.ctx, pipeline)
    scheduler.onChange(() => (calls += 1))
    scheduler.start()
    expect(calls).toBe(1)
    env.ctx.settings.update({ autopilot: { enabled: true, intervalHours: 1 } })
    scheduler.reschedule()
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(61_000)
    // The run finished and the next one was scheduled.
    expect(calls).toBe(3)
  })
})
