import { describe, expect, it } from 'vitest'
import type { VolumeCounts } from '@shared/types'
import { funnelSteps, pageInfo, quotaShare, quotaTone, scoredAtOrAbove, shareOfFound, thresholdContext } from './volumeHelpers'

const counts: VolumeCounts = { discovered: 200, filteredOut: 120, scored: 70, shortlisted: 30, prepared: 20, submitted: 10, needsAttention: 2, ready: 5, costUsd: 0.4 }

describe('funnelSteps', () => {
  it('lists found, passed filters, scored, shortlisted, prepared and sent', () => {
    const steps = funnelSteps(counts)
    expect(steps.map((s) => [s.label, s.value])).toEqual([
      ['Found', 200],
      ['Passed filters', 80],
      ['Scored', 70],
      ['Shortlisted', 30],
      ['Prepared', 20],
      ['Sent', 10]
    ])
  })

  it('never shows a negative number of jobs that passed', () => {
    expect(funnelSteps({ ...counts, discovered: 5, filteredOut: 9 })[1].value).toBe(0)
  })

  it('gives each step as a share of the jobs found', () => {
    const steps = funnelSteps(counts)
    expect(shareOfFound(steps, 0)).toBeNull()
    expect(shareOfFound(steps, 1)).toBeCloseTo(0.4)
    expect(shareOfFound(funnelSteps({ ...counts, discovered: 0, filteredOut: 0 }), 3)).toBeNull()
  })
})

describe('scoredAtOrAbove', () => {
  // Index 0 is score 50. Two jobs at 50, three at 72, one at 100.
  const scoreCounts = new Array<number>(51).fill(0)
  scoreCounts[0] = 2
  scoreCounts[22] = 3
  scoreCounts[50] = 1

  it('counts exactly, including scores between multiples of 5', () => {
    expect(scoredAtOrAbove(scoreCounts, 72)).toBe(4)
    expect(scoredAtOrAbove(scoreCounts, 73)).toBe(1)
    expect(scoredAtOrAbove(scoreCounts, 50)).toBe(6)
    expect(scoredAtOrAbove(scoreCounts, 100)).toBe(1)
    expect(scoredAtOrAbove(scoreCounts, 101)).toBe(0)
  })

  it('counts from 50 for a threshold under 50', () => {
    expect(scoredAtOrAbove(scoreCounts, 10)).toBe(6)
  })

  it('writes the line under a threshold', () => {
    expect(thresholdContext(scoreCounts, 72)).toBe('In the last 7 days, 4 scored jobs were at or above this line.')
    expect(thresholdContext(scoreCounts, 100)).toBe('In the last 7 days, 1 scored job was at or above this line.')
    expect(thresholdContext(scoreCounts, 30)).toBe('In the last 7 days, 6 scored jobs were at or above this line. Jobs scored under 50 are not counted.')
  })
})

describe('quota', () => {
  it('gives a share only when there is a daily limit', () => {
    expect(quotaShare({ requestsToday: 50, requestsPerDay: 200 })).toBe(0.25)
    expect(quotaShare({ requestsToday: 500, requestsPerDay: 200 })).toBe(1)
    expect(quotaShare({ requestsToday: 50, requestsPerDay: null })).toBeNull()
  })

  it('warns near the limit and flags it at the limit', () => {
    expect(quotaTone(null)).toBe('accent')
    expect(quotaTone(0.5)).toBe('accent')
    expect(quotaTone(0.8)).toBe('warn')
    expect(quotaTone(1)).toBe('bad')
  })
})

describe('pageInfo', () => {
  it('describes a middle page', () => {
    expect(pageInfo(120, 2, 50)).toEqual({ page: 2, pages: 3, from: 51, to: 100, offset: 50, hasPrev: true, hasNext: true })
  })

  it('describes the last, short page', () => {
    expect(pageInfo(120, 3, 50)).toMatchObject({ from: 101, to: 120, hasNext: false })
  })

  it('handles no rows and a page past the end', () => {
    expect(pageInfo(0, 1, 50)).toEqual({ page: 1, pages: 1, from: 0, to: 0, offset: 0, hasPrev: false, hasNext: false })
    expect(pageInfo(60, 9, 50).page).toBe(2)
  })
})
