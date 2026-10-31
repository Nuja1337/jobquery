import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavedSearch } from '@shared/types'
import { makeTestEnv } from '../testing'
import { defaultTasks, searchesDue } from './index'

afterEach(() => vi.unstubAllGlobals())

const HOUR = 3_600_000

function addSearch(env: Awaited<ReturnType<typeof makeTestEnv>>, source: SavedSearch['source'], label: string): SavedSearch {
  return env.ctx.searches.save({ source, label, params: {}, enabled: true })
}

describe('saved search call limits', () => {
  it('runs one search per source, even when several are saved', async () => {
    const env = await makeTestEnv()
    addSearch(env, 'remotive', 'Remotive one')
    addSearch(env, 'remotive', 'Remotive two')
    addSearch(env, 'remoteok', 'RemoteOK')
    const due = searchesDue(env.ctx)
    expect(due.map((s) => s.source).sort()).toEqual(['remoteok', 'remotive'])
  })

  it('counts the last call of any search of the source against the gap', async () => {
    const env = await makeTestEnv()
    const one = addSearch(env, 'remotive', 'Remotive one')
    addSearch(env, 'remotive', 'Remotive two')
    env.ctx.searches.markRun(one.id)
    // Remotive allows about four calls a day, so six hours must pass for the whole source.
    expect(searchesDue(env.ctx)).toHaveLength(0)
    expect(searchesDue(env.ctx, Date.now() + 5 * HOUR)).toHaveLength(0)
    expect(searchesDue(env.ctx, Date.now() + 7 * HOUR)).toHaveLength(1)
  })

  it('counts a call that failed, and rotates through the searches of a source', async () => {
    const env = await makeTestEnv()
    addSearch(env, 'remotive', 'Remotive one')
    addSearch(env, 'remotive', 'Remotive two')
    vi.stubGlobal('fetch', async () => new Response('down', { status: 500 }))

    const firstRun = defaultTasks(env.ctx)
    expect(firstRun).toHaveLength(1)
    await firstRun[0].run().catch(() => {})
    // The failed call still counts, so a second run right away makes no request.
    expect(defaultTasks(env.ctx)).toHaveLength(0)

    const later = Date.now() + 7 * HOUR
    const secondSearch = searchesDue(env.ctx, later)
    expect(secondSearch).toHaveLength(1)
    expect(secondSearch[0].id).not.toBe(firstRun[0].searchId)
    const thirdTurn = new Set([firstRun[0].searchId, secondSearch[0].id])
    expect(thirdTurn.size).toBe(2)
  })

  it('tags a search task with its source', async () => {
    const env = await makeTestEnv()
    addSearch(env, 'arbeitnow', 'Arbeitnow')
    expect(defaultTasks(env.ctx)[0]).toMatchObject({ searchSource: 'arbeitnow' })
  })
})
