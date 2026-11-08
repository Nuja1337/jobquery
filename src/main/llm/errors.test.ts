import { describe, expect, it } from 'vitest'
import { BudgetExceededError, LlmCancelledError, LlmFormatError, LlmRefusalError, NoModelConfiguredError, RateLimitedError, isJobFault, isProviderError } from './errors'

describe('error classes', () => {
  it('blames the job only for a refusal or an unreadable reply', () => {
    expect(isJobFault(new LlmFormatError('bad', ''))).toBe(true)
    expect(isJobFault(new LlmRefusalError())).toBe(true)
    expect(isJobFault(new Error('fetch failed'))).toBe(false)
    expect(isJobFault(new RateLimitedError())).toBe(false)
  })

  it('calls network, server and timeout failures provider errors, and limits and setup problems something else', () => {
    for (const err of [new TypeError('fetch failed'), new Error('connect ECONNREFUSED 127.0.0.1:11434'), Object.assign(new Error('Bad gateway'), { status: 502 }), new Error('Request timed out.')]) {
      expect(isProviderError(err)).toBe(true)
    }
    for (const err of [new BudgetExceededError('x'), new RateLimitedError(), new NoModelConfiguredError(), new LlmCancelledError(), new LlmFormatError('x', ''), new LlmRefusalError()]) {
      expect(isProviderError(err)).toBe(false)
    }
  })
})
