import type { LlmUsage } from './types'

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export class NoModelConfiguredError extends Error {
  constructor(message = 'No AI model is set up yet. Add a provider and pick models in Settings.') {
    super(message)
    this.name = 'NoModelConfiguredError'
  }
}

/** The model declined the request. The caller should flag the item for the user instead of retrying. */
export class LlmRefusalError extends Error {
  constructor(
    message = 'The model declined to answer this request.',
    /** Tokens the provider billed for the declined reply. */
    readonly usage?: LlmUsage
  ) {
    super(message)
    this.name = 'LlmRefusalError'
  }
}

/** The model answered, but not in the shape we asked for, even after a repair attempt. */
export class LlmFormatError extends Error {
  constructor(
    message: string,
    readonly raw: string,
    /** Tokens the provider billed for the unusable reply. */
    readonly usage?: LlmUsage
  ) {
    super(message)
    this.name = 'LlmFormatError'
  }
}
