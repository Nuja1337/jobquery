import { describe, expect, it } from 'vitest'
import { BudgetExceededError, LlmFormatError, RateLimitedError } from '../llm/errors'
import { makeProfile, makeRaw, makeTestEnv } from '../testing'
import { scoreJobNow } from './actions'
import { renderProfile } from '../writing/prompts'
import { ingestRaw } from './ingest'
import { scoreJobWithAi, toAssessment, TRIAGE_BATCH_SIZE, triageJobs } from './triage'

async function setup(options: Parameters<typeof makeTestEnv>[0] = {}) {
  const env = await makeTestEnv(options)
  env.ctx.profile.save(makeProfile())
  return env
}

function add(env: Awaited<ReturnType<typeof setup>>, id: string, extra: Record<string, unknown> = {}) {
  return ingestRaw(env.ctx, makeRaw({ externalId: id, title: `Engineer ${id}`, ...extra })).job
}

describe('scoreJobWithAi', () => {
  it('stores the score, bucket, summary and profile version and shortlists the job', async () => {
    const env = await setup({ score: () => 82 })
    const job = add(env, 'a')
    const result = await scoreJobWithAi(env.ctx, job)
    expect(result.called).toBe(true)
    expect(result.costUsd).toBeGreaterThan(0)
    const stored = env.ctx.jobs.get(job.id)!
    expect(stored).toMatchObject({ stage: 'shortlisted', fitScore: 82, fitBucket: 'great', fitSummary: 'Fit is 82.' })
    expect(stored.fit).toMatchObject({ score: 82, bucket: 'great', matches: ['TypeScript'], seniorityFit: 'match' })
    expect(env.ctx.jobs.scoredProfileVersion(job.id)).toBe(env.ctx.profile.get().version)
  })

  it('archives a job below the shortlist line as scored', async () => {
    const env = await setup({ score: () => 45 })
    const job = add(env, 'a')
    await scoreJobWithAi(env.ctx, job)
    expect(env.ctx.jobs.get(job.id)).toMatchObject({ stage: 'scored', fitBucket: 'weak' })
  })

  it('never sends a job again for the same profile version unless forced', async () => {
    const env = await setup()
    const job = add(env, 'a')
    await scoreJobWithAi(env.ctx, job)
    expect(env.llmCalls).toHaveLength(1)
    const again = await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!)
    expect(again.called).toBe(false)
    expect(env.llmCalls).toHaveLength(1)
    // Forcing asks again. The identical request comes back from the local cache, so it is still free.
    const forced = await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!, { force: true })
    expect(forced).toMatchObject({ called: true, cached: true, costUsd: 0 })
    expect(env.llmCalls).toHaveLength(1)
  })

  it('scores again after a change that affects fit, but not after notes or links change', async () => {
    const env = await setup()
    const job = add(env, 'a')
    await scoreJobWithAi(env.ctx, job)
    const current = env.ctx.profile.get().profile
    env.ctx.profile.save({ ...current, notesForAi: 'Prefers small teams.', links: { ...current.links, github: 'https://github.com/sam' } })
    expect((await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!)).called).toBe(false)
    env.ctx.profile.save({ ...current, skills: [...current.skills, 'Rust'] })
    expect((await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!)).called).toBe(true)
    expect(env.llmCalls).toHaveLength(2)
  })

  it('keeps the rubric and profile text identical across jobs so provider caching works', async () => {
    const env = await setup()
    await scoreJobWithAi(env.ctx, add(env, 'a', { description: 'First posting.' }))
    await scoreJobWithAi(env.ctx, add(env, 'b', { description: 'A different posting.' }))
    const [first, second] = env.llmCalls
    expect(first.system).toBe(second.system)
    expect(first.context).toBe(second.context)
    expect(first.prompt).not.toBe(second.prompt)
    expect(first.context).toContain(renderProfile(env.ctx.profile.get().profile, 'fit'))
    expect(first.system).toMatch(/85 to 100/)
    expect(first.system).toMatch(/clearance/i)
    expect(first.prompt).toContain('Engineer a')
    expect(first.prompt).not.toContain('Sam Rivera')
  })

  it('shortens long descriptions in the prompt', async () => {
    const env = await setup()
    await scoreJobWithAi(env.ctx, add(env, 'a', { description: 'Useful sentence. '.repeat(1000) }))
    expect(env.llmCalls[0].prompt.length).toBeLessThan(4600)
    expect(env.llmCalls[0].prompt).toContain('[posting shortened]')
  })

  it('clamps scores to 0-100', () => {
    const base = { summary: 's', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }
    expect(toAssessment({ ...base, score: 140 }, 60).score).toBe(100)
    expect(toAssessment({ ...base, score: -3 }, 60)).toMatchObject({ score: 0, bucket: 'weak' })
    expect(toAssessment({ ...base, score: 71.6 }, 60)).toMatchObject({ score: 72, bucket: 'great' })
    expect(toAssessment({ ...base, score: 86 }, 60).bucket).toBe('perfect')
  })

  it('lets a forced score keep the stage of a job already past scoring', async () => {
    const env = await setup({ score: () => 90 })
    const job = add(env, 'a')
    env.ctx.jobs.dismiss(job.id, null, [])
    await scoreJobWithAi(env.ctx, env.ctx.jobs.get(job.id)!, { force: true })
    expect(env.ctx.jobs.get(job.id)).toMatchObject({ stage: 'dismissed', fitScore: 90 })
  })
})

describe('triageJobs', () => {
  it('runs four at a time', async () => {
    const env = await setup({ delayMs: 15 })
    const jobs = Array.from({ length: 10 }, (_, i) => add(env, `j${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(summary.scored).toBe(10)
    expect(env.model.maxInflight).toBe(4)
  })

  it('stops cleanly when the budget runs out', async () => {
    const env = await setup()
    const jobs = Array.from({ length: 6 }, (_, i) => add(env, `j${i}`))
    // Each call costs about $0.00035 on the default Haiku price.
    env.ctx.settings.update({ budget: { dailyUsd: 0.0004 } })
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary.stoppedForBudget).toBe(true)
    expect(summary.budgetMessage).toMatch(/budget/)
    expect(summary.scored).toBe(2)
    expect(summary.errors).toBe(0)
    expect(env.ctx.jobs.listByStage('new')).toHaveLength(4)
  })

  it('counts a failed job as an error and keeps going', async () => {
    const env = await setup({ fail: (prompt) => (prompt.includes('Engineer bad') ? new Error('model said no') : null) })
    const jobs = [add(env, 'ok1'), add(env, 'bad'), add(env, 'ok2')]
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary).toMatchObject({ scored: 2, errors: 1 })
    expect(summary.errorMessages[0]).toContain('model said no')
    expect(env.ctx.jobs.get(jobs[1].id)!.stage).toBe('new')
  })

  it('throws budget errors from a single score so the caller can show them', async () => {
    const env = await setup()
    env.ctx.settings.update({ budget: { dailyUsd: 0.0001 } })
    const first = add(env, 'a')
    await scoreJobWithAi(env.ctx, first)
    await expect(scoreJobWithAi(env.ctx, add(env, 'b'))).rejects.toBeInstanceOf(BudgetExceededError)
  })
})

describe('triage and provider limits', () => {
  it('stops on a rate limit without counting a failure against any job', async () => {
    const env = await setup({ fail: (prompt) => (prompt.includes('Engineer rl') ? new RateLimitedError('Too many requests.') : null) })
    const jobs = [add(env, 'ok1'), add(env, 'rl'), add(env, 'ok2')]
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary).toMatchObject({ scored: 1, errors: 0, stoppedForRateLimit: true, rateLimitMessage: 'Too many requests.', stoppedForBudget: false })
    expect(env.ctx.jobs.get(jobs[2].id)!.stage).toBe('new')
    for (const job of jobs) expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(0)
  })

  it('does not count a budget stop as a failure either', async () => {
    const env = await setup()
    const jobs = Array.from({ length: 4 }, (_, i) => add(env, `j${i}`))
    env.ctx.settings.update({ budget: { dailyUsd: 0.0004 } })
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary.stoppedForBudget).toBe(true)
    for (const job of jobs) expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(0)
  })
})

describe('provider errors during triage', () => {
  it("don't count against the jobs and stop scoring after three", async () => {
    const env = await setup({ fail: () => new Error('connect ECONNREFUSED 127.0.0.1:11434') })
    const jobs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => add(env, id))
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary.errors).toBe(3)
    expect(env.llmCalls).toHaveLength(3)
    expect(summary.errorMessages.at(-1)).toMatch(/stopped after 3 errors/)
    for (const job of jobs) expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(0)
  })
})

describe('provider errors in a row during triage', () => {
  it('keeps scoring when a good call comes between the errors', async () => {
    const env = await setup({ fail: (prompt) => (prompt.includes('Engineer fail') ? new Error('connect ECONNREFUSED 127.0.0.1:11434') : null) })
    const jobs = ['fail1', 'fail2', 'fine1', 'fail3', 'fail4', 'fine2'].map((id) => add(env, id))
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary.errors).toBe(4)
    expect(summary.scored).toBe(2)
    expect(env.llmCalls).toHaveLength(6)
    expect(summary.errorMessages.join(' ')).not.toMatch(/stopped after/)
  })
})

describe('triage failure cap', () => {
  const pick = (env: Awaited<ReturnType<typeof setup>>) => env.ctx.jobs.listByStage('new', { skipRepeatedTriageFailures: true })

  it('counts failures, skips a job after three, and resets on success', async () => {
    let broken = true
    const env = await setup({ fail: (prompt) => (broken && prompt.includes('Engineer bad') ? new LlmFormatError('model said no', '') : null) })
    const bad = add(env, 'bad')
    const good = add(env, 'good')
    for (let run = 1; run <= 3; run++) {
      const picked = pick(env)
      expect(picked.map((j) => j.id)).toContain(bad.id)
      await triageJobs(env.ctx, picked, { concurrency: 1 })
      expect(env.ctx.jobs.get(bad.id)!.triageFailures).toBe(run)
    }
    expect(env.ctx.jobs.get(good.id)!.stage).not.toBe('new')
    expect(pick(env)).toHaveLength(0)
    expect(env.ctx.jobs.listByStage('new')).toHaveLength(1)

    // "Score now" ignores the cap, and a good score clears the count.
    broken = false
    const rescored = await scoreJobNow(env.ctx, bad.id)
    expect(rescored.triageFailures).toBe(0)
    expect(rescored.fitScore).not.toBeNull()
  })

  it('gives every job a fresh start when the profile changes in a way that affects fit', async () => {
    const env = await setup({ fail: () => new LlmFormatError('model said no', '') })
    const job = add(env, 'bad')
    for (let i = 0; i < 3; i++) await triageJobs(env.ctx, pick(env), { concurrency: 1 })
    expect(pick(env)).toHaveLength(0)
    const profile = env.ctx.profile.get().profile
    // Notes don't change the fit version, so the count stays.
    env.ctx.profile.save({ ...profile, notesForAi: 'Prefers small teams.' })
    expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(3)
    env.ctx.profile.save({ ...profile, skills: [...profile.skills, 'Rust'] })
    expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(0)
    expect(pick(env)).toHaveLength(1)
  })
})

describe('scoring context', () => {
  it('leaves facts, links and notes out of the scoring prompt but keeps them for writing', async () => {
    const env = await setup()
    const current = env.ctx.profile.get().profile
    env.ctx.profile.save({
      ...current,
      facts: [{ question: 'Notice period', answer: 'Two weeks' }],
      links: { ...current.links, linkedin: 'https://linkedin.com/in/sam' },
      notesForAi: 'Never mention the layoffs.'
    })
    await scoreJobWithAi(env.ctx, add(env, 'a'))
    const context = env.llmCalls[0].context!
    expect(context).toContain('TypeScript')
    expect(context).not.toContain('Notice period')
    expect(context).not.toContain('linkedin.com')
    expect(context).not.toContain('layoffs')
    expect(renderProfile(env.ctx.profile.get().profile)).toContain('Notice period: Two weeks')
  })
})

describe('triage on a free provider', () => {
  async function freeSetup(options: Parameters<typeof makeTestEnv>[0] = {}) {
    const env = await makeTestEnv({ ...options, provider: false })
    env.ctx.profile.save(makeProfile())
    const free = await env.ctx.providers.save({ kind: 'gemini', label: 'Gemini', apiKey: 'k', billing: 'free' })
    const ref = { providerId: free.id, model: 'gemini-2.5-flash' }
    env.ctx.settings.update({ routing: { triage: ref, writing: ref, extraction: ref } })
    return env
  }

  it('scores five jobs in one call', async () => {
    const env = await freeSetup()
    const jobs = Array.from({ length: TRIAGE_BATCH_SIZE }, (_, i) => add(env, `f${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(TRIAGE_BATCH_SIZE).toBe(5)
    expect(env.llmCalls).toHaveLength(1)
    expect(summary).toMatchObject({ scored: 5, errors: 0, costUsd: 0 })
    for (const job of jobs) expect(env.ctx.jobs.get(job.id)).toMatchObject({ stage: 'shortlisted', fitScore: 80 })
    for (const n of [1, 2, 3, 4, 5]) expect(env.llmCalls[0].prompt).toContain(`JOB job${n}
`)
    expect(env.llmCalls[0].system).toMatch(/Several postings in one reply/)
  })

  it('splits twelve jobs into calls of five, five and two, one call at a time', async () => {
    const env = await freeSetup({ delayMs: 10 })
    const jobs = Array.from({ length: 12 }, (_, i) => add(env, `g${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(summary.scored).toBe(12)
    expect(env.llmCalls).toHaveLength(3)
    expect(env.model.maxInflight).toBe(1)
  })

  it('fails only the job the reply leaves out', async () => {
    const env = await freeSetup({ omit: (text) => text.includes('Engineer g2') })
    const jobs = Array.from({ length: 4 }, (_, i) => add(env, `g${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(env.llmCalls).toHaveLength(1)
    expect(summary).toMatchObject({ scored: 3, errors: 1 })
    expect(summary.errorMessages[0]).toMatch(/Engineer g2.*no score for this job/)
    expect(env.ctx.jobs.get(jobs[2].id)).toMatchObject({ stage: 'new', triageFailures: 1 })
    for (const i of [0, 1, 3]) expect(env.ctx.jobs.get(jobs[i].id)).toMatchObject({ stage: 'shortlisted', triageFailures: 0 })
  })

  it('splits the cost and tokens of the one call between the jobs', async () => {
    const env = await freeSetup()
    const jobs = Array.from({ length: 4 }, (_, i) => add(env, `h${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(summary.tokens).toBeGreaterThan(0)
    expect(summary.tokens).toBeLessThanOrEqual(2300)
  })

  it('sends each job on its own when the whole reply cannot be read', async () => {
    const env = await freeSetup({ fail: (prompt) => (prompt.includes('JOB job1') ? new LlmFormatError('not JSON', '{oops') : null) })
    const jobs = Array.from({ length: 3 }, (_, i) => add(env, `k${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(env.llmCalls).toHaveLength(4)
    expect(summary).toMatchObject({ scored: 3, errors: 0 })
    for (const job of jobs) expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(0)
  })

  it('does not send a job that already has a score for this profile', async () => {
    const env = await freeSetup()
    const jobs = Array.from({ length: 3 }, (_, i) => add(env, `m${i}`))
    await scoreJobWithAi(env.ctx, jobs[0])
    const before = env.llmCalls.length
    const summary = await triageJobs(env.ctx, jobs.map((j) => env.ctx.jobs.get(j.id)!))
    expect(summary.scored).toBe(3)
    expect(env.llmCalls).toHaveLength(before + 1)
    expect(env.llmCalls.at(-1)!.prompt).not.toContain('JOB job3')
  })

  it('keeps one job per call on a paid provider', async () => {
    const env = await setup()
    const jobs = Array.from({ length: 5 }, (_, i) => add(env, `p${i}`))
    await triageJobs(env.ctx, jobs)
    expect(env.llmCalls).toHaveLength(5)
    expect(env.llmCalls.every((c) => !c.prompt.includes('JOB job1'))).toBe(true)
  })

  it('stops on a rate limit during a batch without failing any job', async () => {
    const env = await freeSetup({ fail: () => new RateLimitedError('Too many requests.') })
    const jobs = Array.from({ length: 5 }, (_, i) => add(env, `r${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(summary).toMatchObject({ scored: 0, errors: 0, stoppedForRateLimit: true })
    for (const job of jobs) expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(0)
  })
})

describe('provider errors count failed calls', () => {
  const timeout = () => new Error('Request timed out.')
  const rejected = (status: number, message = 'Bad request.') => Object.assign(new Error(message), { status })

  async function freeSetup(options: Parameters<typeof makeTestEnv>[0] = {}) {
    const env = await makeTestEnv({ ...options, provider: false })
    env.ctx.profile.save(makeProfile())
    const free = await env.ctx.providers.save({ kind: 'gemini', label: 'Gemini', apiKey: 'k', billing: 'free' })
    const ref = { providerId: free.id, model: 'gemini-2.5-flash' }
    env.ctx.settings.update({ routing: { triage: ref, writing: ref, extraction: ref } })
    return env
  }

  it('counts one timeout on a batch of five as one provider error', async () => {
    const env = await freeSetup({ fail: timeout })
    const jobs = Array.from({ length: TRIAGE_BATCH_SIZE }, (_, i) => add(env, `t${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(env.llmCalls).toHaveLength(1)
    expect(summary).toMatchObject({ scored: 0, errors: 5, providerErrors: 1, stoppedForProviderErrors: false })
    for (const job of jobs) expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(0)
  })

  it('stops after three failed calls, not after three jobs', async () => {
    const env = await freeSetup({ fail: timeout })
    const jobs = Array.from({ length: 20 }, (_, i) => add(env, `u${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(env.llmCalls).toHaveLength(3)
    expect(summary).toMatchObject({ errors: 15, providerErrors: 3, stoppedForProviderErrors: true })
  })

  it('counts one call per job on a paid provider', async () => {
    const env = await setup({ fail: timeout })
    const jobs = ['a', 'b'].map((id) => add(env, id))
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(summary).toMatchObject({ errors: 2, providerErrors: 2 })
  })

  it('counts a posting the provider rejects against that job and scores the rest', async () => {
    const env = await setup({ fail: (prompt) => (prompt.includes('Engineer huge') ? rejected(413, 'Request too large.') : null) })
    const huge = add(env, 'huge')
    const fine = add(env, 'fine')
    const summary = await triageJobs(env.ctx, [huge, fine], { concurrency: 1 })
    expect(summary).toMatchObject({ scored: 1, errors: 1, providerErrors: 0, stoppedForProviderErrors: false })
    expect(env.ctx.jobs.get(huge.id)!.triageFailures).toBe(1)
    expect(env.ctx.jobs.get(fine.id)!.triageFailures).toBe(0)
  })

  it('takes a rejected posting out of the next runs after three tries', async () => {
    const env = await setup({ fail: (prompt) => (prompt.includes('Engineer huge') ? rejected(400) : null) })
    const huge = add(env, 'huge')
    for (let run = 1; run <= 3; run++) {
      const picked = env.ctx.jobs.listByStage('new', { skipRepeatedTriageFailures: true })
      expect(picked.map((j) => j.id)).toContain(huge.id)
      const summary = await triageJobs(env.ctx, picked, { concurrency: 1 })
      expect(summary.providerErrors).toBe(0)
      expect(env.ctx.jobs.get(huge.id)!.triageFailures).toBe(run)
    }
    expect(env.ctx.jobs.listByStage('new', { skipRepeatedTriageFailures: true })).toHaveLength(0)
  })

  it.each([400, 413, 422])('treats HTTP %i as the posting\'s fault', async (status) => {
    const env = await setup({ fail: () => rejected(status) })
    const job = add(env, 'x')
    const summary = await triageJobs(env.ctx, [job])
    expect(summary).toMatchObject({ errors: 1, providerErrors: 0 })
    expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(1)
  })

  it('treats a content filter as the posting\'s fault', async () => {
    const env = await setup({ fail: () => Object.assign(new Error('The response was filtered.'), { code: 'content_filter' }) })
    const job = add(env, 'x')
    const summary = await triageJobs(env.ctx, [job])
    expect(summary).toMatchObject({ errors: 1, providerErrors: 0 })
    expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(1)
  })

  it('does not treat 401, 404 or 500 as the posting\'s fault', async () => {
    for (const status of [401, 404, 500]) {
      const env = await setup({ fail: () => rejected(status, 'Nope.') })
      const job = add(env, 'x')
      const summary = await triageJobs(env.ctx, [job])
      expect(summary).toMatchObject({ errors: 1, providerErrors: 1 })
      expect(env.ctx.jobs.get(job.id)!.triageFailures).toBe(0)
    }
  })

  it('sends the jobs of a rejected batch on their own and fails only the one the provider rejects', async () => {
    const env = await freeSetup({ fail: (prompt) => (prompt.includes('Engineer bad') ? rejected(400) : null) })
    const jobs = ['ok1', 'ok2', 'bad', 'ok3', 'ok4'].map((id) => add(env, id))
    const summary = await triageJobs(env.ctx, jobs)
    // The batch call, then each of the five on its own.
    expect(env.llmCalls).toHaveLength(6)
    expect(summary).toMatchObject({ scored: 4, errors: 1, providerErrors: 0, stoppedForProviderErrors: false })
    expect(env.ctx.jobs.get(jobs[2].id)!.triageFailures).toBe(1)
    for (const i of [0, 1, 3, 4]) expect(env.ctx.jobs.get(jobs[i].id)).toMatchObject({ stage: 'shortlisted', triageFailures: 0 })
  })

  it('stops when five postings in a row are rejected, since the setup is the likelier cause', async () => {
    const env = await setup({ fail: () => rejected(400, 'API key not valid.') })
    const jobs = Array.from({ length: 9 }, (_, i) => add(env, `z${i}`))
    const summary = await triageJobs(env.ctx, jobs, { concurrency: 1 })
    expect(env.llmCalls).toHaveLength(5)
    expect(summary.stoppedForProviderErrors).toBe(true)
    expect(summary.errorMessages.join(' ')).toMatch(/5 postings in a row/)
  })

  it('counts one failed call next to a scored one as one provider error', async () => {
    // One batch scores and the next times out: the one failed call is what the orchestrator sees.
    const env = await freeSetup({ fail: (prompt) => (prompt.includes('Engineer w5') ? timeout() : null) })
    const jobs = Array.from({ length: 10 }, (_, i) => add(env, `w${i}`))
    const summary = await triageJobs(env.ctx, jobs)
    expect(summary).toMatchObject({ scored: 5, errors: 5, providerErrors: 1 })
  })
})
