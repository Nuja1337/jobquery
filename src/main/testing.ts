// Helpers for tests. Nothing here is used by the app itself.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PushChannel, PushEvents } from '@shared/api'
import type { Profile, RawJob } from '@shared/types'
import { EMPTY_PROFILE } from '@shared/defaults'
import { type AppContext, createContext } from './context'
import type { ClientFactory } from './llm/service'
import type { LlmClient, LlmRequest } from './llm/types'
import { appPaths } from './paths'
import { testVault } from './secrets'

export interface TestEnv {
  ctx: AppContext
  /** Everything pushed to the UI. */
  pushed: Array<{ channel: PushChannel; payload: unknown }>
  /** Every request the fake model received. */
  llmCalls: LlmRequest[]
  model: ModelStats
}

export interface FakeModelOptions {
  /** Score for a job, read from the prompt. Defaults to 80. */
  score?: (prompt: string) => number
  /** Throw this instead of answering. */
  fail?: (prompt: string) => Error | null
  /** Wait this long before answering, to test concurrency. */
  delayMs?: number
}

export interface ModelStats {
  inflight: number
  maxInflight: number
}

export function fakeClientFactory(calls: LlmRequest[], options: FakeModelOptions = {}, stats: ModelStats = { inflight: 0, maxInflight: 0 }): ClientFactory {
  const client: LlmClient = {
    kind: 'anthropic',
    async complete(model, req) {
      calls.push(req)
      return { text: 'ok', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, truncated: false }
    },
    async completeJson(model, req, schema) {
      calls.push(req)
      stats.inflight += 1
      stats.maxInflight = Math.max(stats.maxInflight, stats.inflight)
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      stats.inflight -= 1
      const failure = options.fail?.(req.prompt)
      if (failure) throw failure
      const score = options.score ? options.score(req.prompt) : 80
      const value = schema.parse({
        score,
        summary: `Fit is ${score}.`,
        matches: ['TypeScript'],
        gaps: score < 70 ? ['Kubernetes'] : [],
        dealbreakers: [],
        seniorityFit: 'match',
        keywords: ['typescript']
      })
      return {
        text: '{}',
        value,
        usage: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model,
        truncated: false
      }
    },
    async listModels() {
      return ['claude-haiku-5-5']
    }
  }
  return () => client
}

/** An in-memory context with a fake AI provider already set up. */
export async function makeTestEnv(options: FakeModelOptions & { provider?: boolean } = {}): Promise<TestEnv> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-test-'))
  const pushed: TestEnv['pushed'] = []
  const llmCalls: LlmRequest[] = []
  const model: ModelStats = { inflight: 0, maxInflight: 0 }
  const ctx = await createContext({
    dbFile: null,
    paths: appPaths(dir),
    vault: testVault,
    emit: <C extends PushChannel>(channel: C, payload: PushEvents[C]) => {
      pushed.push({ channel, payload })
    },
    clientFactory: fakeClientFactory(llmCalls, options, model)
  })
  if (options.provider !== false) ctx.providers.save({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-test' })
  return { ctx, pushed, llmCalls, model }
}

export function makeRaw(overrides: Partial<RawJob> = {}): RawJob {
  const id = overrides.externalId ?? String(Math.random()).slice(2, 10)
  return {
    source: 'greenhouse',
    externalId: id,
    company: 'Acme',
    title: 'Software Engineer',
    location: 'Remote',
    remote: 'remote',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    employmentType: null,
    url: `https://example.com/jobs/${id}`,
    applyUrl: null,
    ats: 'unknown',
    atsToken: null,
    description: `We build things in TypeScript and React. Posting ${id}.`,
    postedAt: new Date().toISOString(),
    ...overrides
  }
}

export function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    ...structuredClone(EMPTY_PROFILE),
    fullName: 'Sam Rivera',
    headline: 'Full-stack engineer',
    skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'],
    yearsExperience: 5,
    experience: [{ company: 'Initech', title: 'Software Engineer', highlights: ['Built a billing service'] }],
    ...overrides
  }
}
