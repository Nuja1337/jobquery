import { describe, expect, it } from 'vitest'
import { TRANSIENT_REASONS } from '@shared/reviewReasons'
import { answeredMessage, askHeading, defaultSaveToBank, inputKindFor, REASON_HEADINGS, REASON_HINTS, retryMessage } from './exceptionsHelpers'

describe('askHeading', () => {
  it('uses the singular and the plural correctly', () => {
    expect(askHeading(1, 'Favorite editor')).toBe('1 application asks: Favorite editor')
    expect(askHeading(12, 'Expected salary (USD)')).toBe('12 applications ask: Expected salary (USD)')
  })
})

describe('inputKindFor', () => {
  it('picks a control by type and choices', () => {
    expect(inputKindFor({ type: 'select', options: ['A', 'B'] })).toBe('select')
    expect(inputKindFor({ type: 'radio', options: ['Yes', 'No'] })).toBe('select')
    expect(inputKindFor({ type: 'checkboxes', options: ['A', 'B'] })).toBe('multi')
    expect(inputKindFor({ type: 'checkbox', options: null })).toBe('yesno')
    expect(inputKindFor({ type: 'date', options: null })).toBe('date')
    expect(inputKindFor({ type: 'textarea', options: null })).toBe('textarea')
    expect(inputKindFor({ type: 'number', options: null })).toBe('number')
    expect(inputKindFor({ type: 'text', options: null })).toBe('text')
  })
})

describe('defaultSaveToBank', () => {
  it('is on for a topic and off for questions only the person may answer', () => {
    expect(defaultSaveToBank({ topic: 'notice_period', userOnly: false })).toBe(true)
    // A saved amount carries no currency, so salary is not saved by default.
    expect(defaultSaveToBank({ topic: 'salary_expectation', userOnly: false })).toBe(false)
    expect(defaultSaveToBank({ topic: null, userOnly: false })).toBe(false)
    expect(defaultSaveToBank({ topic: 'ai_use_disclosure', userOnly: true })).toBe(false)
  })
})

describe('toast messages', () => {
  it('says how many became ready', () => {
    expect(answeredMessage({ updated: 5, ready: 3, skipped: 0 })).toBe('Answered 5 applications. 3 became ready.')
    expect(answeredMessage({ updated: 1, ready: 1, skipped: 0 })).toBe('Answered 1 application. 1 became ready.')
    expect(answeredMessage({ updated: 2, ready: 0, skipped: 1 })).toBe('Answered 2 applications. None are ready yet. 1 application could not take this answer.')
    expect(answeredMessage({ updated: 0, ready: 0, skipped: 2 })).toMatch(/Nothing changed/)
  })
  it('says how many went back in the queue', () => {
    expect(retryMessage({ updated: 2, skipped: 1 })).toBe('2 applications will be tried again on the next run. 1 stayed here because they need you.')
    expect(retryMessage({ updated: 0, skipped: 3 })).toBe('None of them could go back in the queue.')
  })
})

describe('reason text', () => {
  it('has a heading and a hint for every reason', () => {
    for (const reason of Object.keys(REASON_HEADINGS) as Array<keyof typeof REASON_HEADINGS>) {
      expect(REASON_HEADINGS[reason].length).toBeGreaterThan(0)
      expect(REASON_HINTS[reason]).toMatch(/[.]$/)
    }
    expect(Object.keys(REASON_HEADINGS).sort()).toEqual(Object.keys(REASON_HINTS).sort())
  })
  it('keeps Retry later to the passing reasons', () => {
    expect(TRANSIENT_REASONS).toEqual(['timed_out', 'browser', 'no_confirmation'])
  })
})
