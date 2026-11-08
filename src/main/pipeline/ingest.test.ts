import { describe, expect, it } from 'vitest'
import { type TestEnv, makeRaw, makeTestEnv } from '../testing'
import { autoWatchBoard, boardLinkIn, ingestRaw, noteStartedWatching } from './ingest'

async function setup() {
  return makeTestEnv({ provider: false })
}

const fromRemotive = (over: Parameters<typeof makeRaw>[0] = {}) =>
  makeRaw({ source: 'remotive', externalId: 'r1', company: 'Acme', ats: 'greenhouse', atsToken: 'acme', ...over })

const watched = (env: TestEnv) => env.ctx.companies.list().filter((c) => c.watch)

describe('boardLinkIn', () => {
  it('finds the first readable board among the links in a text', () => {
    const text = 'See https://acme.example/careers and https://boards.greenhouse.io/acme/jobs/123, or https://jobs.lever.co/other.'
    expect(boardLinkIn(text)).toEqual({ ats: 'greenhouse', token: 'acme' })
  })

  it('skips links to systems that cannot be read, and links with no board', () => {
    expect(boardLinkIn('https://acme.wd1.myworkdayjobs.com/en/Careers/job/x_R1 and https://jobs.ashbyhq.com/acme')).toEqual({ ats: 'ashby', token: 'acme' })
    expect(boardLinkIn('no links here')).toBeNull()
    expect(boardLinkIn('https://news.ycombinator.com/item?id=1')).toBeNull()
  })

  it('drops trailing punctuation', () => {
    expect(boardLinkIn('Apply: https://jobs.lever.co/acme/abc-123.')).toEqual({ ats: 'lever', token: 'acme' })
  })

  it('does not trust a board name that a site cut short', () => {
    expect(boardLinkIn('https://jobs.lever.co/acme/abc-1...')).toEqual({ ats: 'lever', token: 'acme' })
    expect(boardLinkIn('https://jobs.lever.co/ac...')).toBeNull()
  })
})

describe('auto-watching boards found in postings', () => {
  it('watches the board a job-site posting links to, due at once', async () => {
    const env = await setup()
    const result = ingestRaw(env.ctx, fromRemotive())
    expect(result.startedWatching).toBe('Acme')
    expect(watched(env)).toMatchObject([{ name: 'Acme', ats: 'greenhouse', atsToken: 'acme', origin: 'posting_link' }])
    const due = env.ctx.boards.due(new Date().toISOString(), 10)
    expect(due.map((d) => d.company.name)).toEqual(['Acme'])
    expect(due[0].state.origin).toBe('posting_link')
  })

  it('does nothing when the setting is off', async () => {
    const env = await setup()
    env.ctx.settings.update({ discovery: { autoWatchBoards: false } })
    expect(ingestRaw(env.ctx, fromRemotive()).startedWatching).toBeUndefined()
    expect(env.ctx.companies.list()).toEqual([])
  })

  it('never watches a blocked company, found by board or by name', async () => {
    const env = await setup()
    const board = env.ctx.companies.save({ name: 'Acme', ats: 'greenhouse', atsToken: 'acme', blocked: true })
    expect(ingestRaw(env.ctx, fromRemotive()).startedWatching).toBeUndefined()
    expect(env.ctx.companies.get(board.id)!.watch).toBe(false)

    env.ctx.companies.save({ name: 'Nope Inc', blocked: true })
    expect(ingestRaw(env.ctx, fromRemotive({ externalId: 'r2', company: 'Nope, Inc.', atsToken: 'nope' })).startedWatching).toBeUndefined()
    expect(env.ctx.companies.findByAts('greenhouse', 'nope')).toBeNull()

    env.ctx.settings.update({ preferences: { excludedCompanies: ['Excluded Ltd'] } })
    expect(ingestRaw(env.ctx, fromRemotive({ externalId: 'r3', company: 'Excluded', atsToken: 'excluded' })).startedWatching).toBeUndefined()
    expect(watched(env)).toEqual([])
  })

  it('stops at the cap', async () => {
    const env = await setup()
    env.ctx.settings.update({ discovery: { maxWatchedBoards: 2 } })
    const results = ['a', 'b', 'c'].map((t) => ingestRaw(env.ctx, fromRemotive({ externalId: t, company: `Co ${t}`, atsToken: t })))
    expect(results.map((r) => r.startedWatching)).toEqual(['Co a', 'Co b', undefined])
    expect(watched(env)).toHaveLength(2)
  })

  it('does not count a manually watched board twice or turn it back on after the user turned it off', async () => {
    const env = await setup()
    const mine = env.ctx.companies.save({ name: 'Acme', ats: 'greenhouse', atsToken: 'acme', watch: true })
    expect(ingestRaw(env.ctx, fromRemotive()).startedWatching).toBeUndefined()
    expect(env.ctx.companies.get(mine.id)!.origin).toBe('manual')

    // The user watched this one, then turned it off. It has a board state.
    const off = env.ctx.companies.save({ name: 'Off Co', ats: 'lever', atsToken: 'offco', watch: true })
    env.ctx.boards.ensureState(off.id)
    env.ctx.companies.save({ id: off.id, watch: false })
    expect(ingestRaw(env.ctx, fromRemotive({ externalId: 'r2', company: 'Off Co', ats: 'lever', atsToken: 'offco' })).startedWatching).toBeUndefined()
    expect(env.ctx.companies.get(off.id)!.watch).toBe(false)
  })

  it('watches an existing unwatched company that has never had a board state', async () => {
    const env = await setup()
    const pasted = env.ctx.companies.save({ name: 'Acme', ats: 'greenhouse', atsToken: 'acme', watch: false })
    expect(ingestRaw(env.ctx, fromRemotive()).startedWatching).toBe('Acme')
    expect(env.ctx.companies.get(pasted.id)).toMatchObject({ watch: true, origin: 'posting_link' })
    expect(env.ctx.boards.get(pasted.id)).not.toBeNull()
  })

  it('does not watch a board the app cannot read', async () => {
    const env = await setup()
    expect(ingestRaw(env.ctx, fromRemotive({ ats: 'workday', atsToken: 'acme' })).startedWatching).toBeUndefined()
    expect(autoWatchBoard(env.ctx, { ats: 'recruitee', token: 'acme' })).toBeNull()
    expect(env.ctx.companies.list()).toEqual([])
  })

  it('finds a board link in the text of a Hacker News posting', async () => {
    const env = await setup()
    const hn = makeRaw({
      source: 'hn_whoishiring',
      externalId: '4242',
      company: 'Linked Co',
      ats: 'unknown',
      atsToken: null,
      description: 'Linked Co | Remote | Full-time\nWe build tools. Apply: https://jobs.lever.co/linkedco/1234-abcd or email jobs@linked.example'
    })
    const result = ingestRaw(env.ctx, hn)
    expect(result.startedWatching).toBe('Linked Co')
    expect(env.ctx.companies.findByAts('lever', 'linkedco')).toMatchObject({ watch: true, origin: 'posting_link', name: 'Linked Co' })
  })

  it('reads links in the text of job-site postings only', async () => {
    const env = await setup()
    // A pasted link or a board's own posting with a link in its text is not a job-site posting.
    const own = makeRaw({ source: 'manual', externalId: 'm1', company: 'Own Co', description: 'See https://boards.greenhouse.io/ownco/jobs/1' })
    expect(ingestRaw(env.ctx, own).startedWatching).toBeUndefined()
    expect(watched(env)).toEqual([])
  })

  it('a pasted board link watches that board too', async () => {
    const env = await setup()
    const board = makeRaw({ source: 'greenhouse', externalId: '99', company: 'Pasted Co', ats: 'greenhouse', atsToken: 'pastedco' })
    expect(ingestRaw(env.ctx, board).startedWatching).toBe('Pasted Co')
  })

  it('writes one note, with the right grammar', async () => {
    const env = await setup()
    noteStartedWatching(env.ctx, 0)
    noteStartedWatching(env.ctx, 1)
    noteStartedWatching(env.ctx, 3)
    expect(env.ctx.events.list({ limit: 10 }).map((e) => e.message).sort()).toEqual([
      'Started watching 1 new company board found in postings.',
      'Started watching 3 new company boards found in postings.'
    ])
  })

  it('loads settings saved before the discovery section existed with its defaults', async () => {
    const env = await setup()
    env.ctx.db.run("DELETE FROM settings WHERE key = 'discovery'")
    expect(env.ctx.settings.get().discovery).toEqual({ autoWatchBoards: true, maxWatchedBoards: 5000, boardsPerRun: 2000 })
  })
})

describe('the same posting from a job site and from its own board', () => {
  const site = (over: Parameters<typeof makeRaw>[0] = {}) =>
    makeRaw({ source: 'remotive', externalId: 'r-42', description: 'Remotive text about the role.', ats: 'greenhouse', atsToken: 'acme', atsJobId: '42', ...over })
  const board = (over: Parameters<typeof makeRaw>[0] = {}) =>
    makeRaw({ source: 'greenhouse', externalId: '42', description: 'Board text, the full description.', ats: 'greenhouse', atsToken: 'acme', atsJobId: '42', ...over })
  const fit = { score: 80, bucket: 'great' as const, summary: 'Good.', matches: [], gaps: [], dealbreakers: [], seniorityFit: 'match' as const, keywords: [] }

  it('makes the board row the original when the job site found the posting first', async () => {
    const env = await setup()
    const first = ingestRaw(env.ctx, site())
    const second = ingestRaw(env.ctx, board())
    expect(second).toMatchObject({ isNew: true, duplicate: false })
    expect(env.ctx.jobs.get(second.job.id)).toMatchObject({ stage: 'new', dupOf: null })
    expect(env.ctx.jobs.get(first.job.id)).toMatchObject({ stage: 'duplicate', dupOf: second.job.id })
  })

  it('closes the posting on the board read, so the job-site copy does not stay open', async () => {
    const env = await setup()
    const first = ingestRaw(env.ctx, site())
    const second = ingestRaw(env.ctx, board())
    // The board lists only another posting now.
    expect(env.ctx.jobs.markClosedMissing('greenhouse', 'acme', ['99'])).toEqual([second.job.id])
    expect(env.ctx.jobs.get(second.job.id)!.stage).toBe('closed')
    expect(env.ctx.jobs.get(first.job.id)!.stage).toBe('duplicate')
  })

  it('moves the score and the other duplicates to the board row', async () => {
    const env = await setup()
    const first = ingestRaw(env.ctx, site())
    const other = ingestRaw(env.ctx, site({ source: 'remoteok', externalId: 'ok-42', description: 'RemoteOK text.' }))
    expect(env.ctx.jobs.get(other.job.id)).toMatchObject({ stage: 'duplicate', dupOf: first.job.id })
    env.ctx.jobs.saveFit(first.job.id, fit, 3, 'shortlisted')
    const second = ingestRaw(env.ctx, board())
    expect(env.ctx.jobs.get(second.job.id)).toMatchObject({ dupOf: null, fit: { score: 80 } })
    expect(env.ctx.jobs.scoredProfileVersion(second.job.id)).toBe(3)
    expect(env.ctx.jobs.get(first.job.id)).toMatchObject({ stage: 'duplicate', dupOf: second.job.id })
    expect(env.ctx.jobs.get(other.job.id)).toMatchObject({ stage: 'duplicate', dupOf: second.job.id })
  })

  it('keeps the job-site row as the original when it has an application', async () => {
    const env = await setup()
    const first = ingestRaw(env.ctx, site())
    env.ctx.applications.create(first.job.id)
    const second = ingestRaw(env.ctx, board())
    expect(second.duplicate).toBe(true)
    expect(env.ctx.jobs.get(second.job.id)).toMatchObject({ stage: 'duplicate', dupOf: first.job.id })
    expect(env.ctx.jobs.get(first.job.id)).toMatchObject({ dupOf: null })
  })

  it('keeps the job-site row as the original when the user dismissed it', async () => {
    const env = await setup()
    const first = ingestRaw(env.ctx, site())
    env.ctx.jobs.dismiss(first.job.id, 'Not interested', [])
    const second = ingestRaw(env.ctx, board())
    expect(second.duplicate).toBe(true)
    expect(env.ctx.jobs.get(first.job.id)!.stage).toBe('dismissed')
    expect(env.ctx.jobs.get(second.job.id)).toMatchObject({ stage: 'duplicate', dupOf: first.job.id })
  })

  it('keeps the board row as the original when the board found the posting first', async () => {
    const env = await setup()
    const first = ingestRaw(env.ctx, board())
    const second = ingestRaw(env.ctx, site())
    expect(second.duplicate).toBe(true)
    expect(env.ctx.jobs.get(second.job.id)).toMatchObject({ stage: 'duplicate', dupOf: first.job.id })
    expect(env.ctx.jobs.get(first.job.id)!.dupOf).toBeNull()
  })

  it('keeps the first job-site row as the original when two job sites list the posting', async () => {
    const env = await setup()
    const first = ingestRaw(env.ctx, site())
    const second = ingestRaw(env.ctx, site({ source: 'remoteok', externalId: 'ok-42', description: 'RemoteOK text.' }))
    expect(second.duplicate).toBe(true)
    expect(env.ctx.jobs.get(second.job.id)).toMatchObject({ stage: 'duplicate', dupOf: first.job.id })
  })
})
