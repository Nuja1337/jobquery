import { describe, expect, it } from 'vitest'
import { BudgetExceededError, LlmCancelledError, LlmFormatError, LlmRefusalError, NoModelConfiguredError, OutOfCreditsError, RateLimitedError, asOutOfCredits, isJobFault, isProviderError } from './errors'

describe('error classes', () => {
  it('blames the job only for a refusal or an unreadable reply', () => {
    expect(isJobFault(new LlmFormatError('bad', ''))).toBe(true)
    expect(isJobFault(new LlmRefusalError())).toBe(true)
    expect(isJobFault(new Error('fetch failed'))).toBe(false)
    expect(isJobFault(new RateLimitedError())).toBe(false)
    expect(isJobFault(new OutOfCreditsError())).toBe(false)
  })

  it('calls network, server and timeout failures provider errors, and limits and setup problems something else', () => {
    for (const err of [new TypeError('fetch failed'), new Error('connect ECONNREFUSED 127.0.0.1:11434'), Object.assign(new Error('Bad gateway'), { status: 502 }), new Error('Request timed out.')]) {
      expect(isProviderError(err)).toBe(true)
    }
    for (const err of [new BudgetExceededError('x'), new OutOfCreditsError(), new RateLimitedError(), new NoModelConfiguredError(), new LlmCancelledError(), new LlmFormatError('x', ''), new LlmRefusalError()]) {
      expect(isProviderError(err)).toBe(false)
    }
  })
})

describe('asOutOfCredits', () => {
  const withStatus = (status: number, message: string, extra: object = {}) => Object.assign(new Error(message), { status, ...extra })

  it('is a budget error with a default message', () => {
    const err = new OutOfCreditsError()
    expect(err).toBeInstanceOf(BudgetExceededError)
    expect(err.name).toBe('OutOfCreditsError')
    expect(err.message).toBe('Your AI provider says the account is out of credits.')
  })

  it('returns an OutOfCreditsError as it is', () => {
    const err = new OutOfCreditsError('x')
    expect(asOutOfCredits(err)).toBe(err)
  })

  it('reads an HTTP 402 from any provider', () => {
    expect(asOutOfCredits(withStatus(402, 'Insufficient credits'))).toBeInstanceOf(OutOfCreditsError)
  })

  it('reads the Anthropic 400 messages about the credit balance and the usage limit, in any case', () => {
    const balance = '400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
    const limit = '400 You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.'
    expect(asOutOfCredits(withStatus(400, balance))).toBeInstanceOf(OutOfCreditsError)
    expect(asOutOfCredits(withStatus(400, limit))).toBeInstanceOf(OutOfCreditsError)
    expect(asOutOfCredits(withStatus(400, 'YOUR CREDIT BALANCE IS TOO LOW'))).toBeInstanceOf(OutOfCreditsError)
  })

  it('reads an OpenAI 429 with code insufficient_quota, on the error or on its body', () => {
    expect(asOutOfCredits(withStatus(429, 'You exceeded your current quota', { code: 'insufficient_quota' }))).toBeInstanceOf(OutOfCreditsError)
    expect(asOutOfCredits(withStatus(429, 'You exceeded your current quota', { error: { code: 'insufficient_quota' } }))).toBeInstanceOf(OutOfCreditsError)
  })

  it('returns null for a plain 429, an unrelated 400, a 500 and a value that is not an object', () => {
    expect(asOutOfCredits(withStatus(429, 'slow down'))).toBeNull()
    expect(asOutOfCredits(withStatus(429, 'slow down', { code: 'rate_limit_exceeded' }))).toBeNull()
    expect(asOutOfCredits(withStatus(400, 'output_config.format is not supported'))).toBeNull()
    expect(asOutOfCredits(withStatus(500, 'Your credit balance is too low'))).toBeNull()
    expect(asOutOfCredits('credit balance is too low')).toBeNull()
    expect(asOutOfCredits(null)).toBeNull()
    expect(asOutOfCredits(undefined)).toBeNull()
  })
})
