import { describe, expect, it } from 'vitest'
import { parseBoardList, probeBoard } from './importBoards'
import { STARTER_PACK, starterPack } from './starterPack'
import { fixtureJson, fixtureText, stubFetch, useFastHttp } from './testHelpers'

useFastHttp()

describe('parseBoardList', () => {
  it('reads addresses, ats:token pairs and bare domains', () => {
    const list = parseBoardList(
      [
        'https://job-boards.greenhouse.io/stripe/jobs/8172510',
        'lever:spotify',
        'jobs.ashbyhq.com/ramp',
        'https://acme.breezy.hr/p/98323abf2296-role',
        'demo.jobs.personio.de',
        'https://ats.rippling.com/rippling/jobs',
        'smartrecruiters:Ubisoft2'
      ].join('\n')
    )
    expect(list.map((e) => ('error' in e ? e.error : `${e.ats}:${e.token}`))).toEqual([
      'greenhouse:stripe',
      'lever:spotify',
      'ashby:ramp',
      'breezy:acme',
      'personio:demo',
      'rippling:rippling',
      'smartrecruiters:Ubisoft2'
    ])
  })

  it('names boards from the starter pack and falls back to the token', () => {
    const [a, b, c] = parseBoardList('greenhouse:riotgames\nlever:some-startup\nhttps://boards.greenhouse.io/scaleai/jobs/1')
    expect(a).toMatchObject({ name: 'Riot Games', line: 'greenhouse:riotgames' })
    expect(b).toMatchObject({ name: 'Some Startup' })
    expect(c).toMatchObject({ name: 'Scale AI' })
  })

  it('skips blanks and comments and removes repeats', () => {
    const list = parseBoardList('\n# games\ngreenhouse:stripe\n  GREENHOUSE:Stripe  \nhttps://boards.greenhouse.io/stripe/jobs/5\r\nlever:stripe\n')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ ats: 'greenhouse', token: 'stripe', line: 'greenhouse:stripe' })
    expect(list[1]).toMatchObject({ ats: 'lever', token: 'stripe' })
  })

  it('reports lines it cannot use and keeps going', () => {
    const list = parseBoardList('stripe.com\nworkday:acme\nhttps://acme.wd5.myworkdayjobs.com/en/Site\nnot a board\ngreenhouse:ok')
    expect(list).toHaveLength(5)
    for (const entry of list.slice(0, 4)) expect(entry).toHaveProperty('error')
    expect(list[0]).toMatchObject({ line: 'stripe.com' })
    expect((list[2] as { error: string }).error).toMatch(/workday/)
    expect(list[4]).toMatchObject({ ats: 'greenhouse', token: 'ok' })
  })
})

describe('starter pack', () => {
  it('has unique boards in two groups', () => {
    const keys = STARTER_PACK.map((b) => `${b.ats}:${b.token.toLowerCase()}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(starterPack('games').length + starterPack('tech').length).toBe(STARTER_PACK.length)
    expect(starterPack()).toHaveLength(STARTER_PACK.length)
    expect(starterPack('games').every((b) => b.group === 'games')).toBe(true)
  })

  it('round-trips through the list parser', () => {
    const text = STARTER_PACK.map((b) => `${b.ats}:${b.token}`).join('\n')
    const parsed = parseBoardList(text)
    expect(parsed).toHaveLength(STARTER_PACK.length)
    expect(parsed.every((e) => !('error' in e))).toBe(true)
    expect(parsed.map((e) => ('name' in e ? e.name : null))).toEqual(STARTER_PACK.map((b) => b.name))
  })
})

describe('probeBoard', () => {
  it('reads the Greenhouse name and job count', async () => {
    stubFetch({
      'https://boards-api.greenhouse.io/v1/boards/riotgames': { json: { name: 'Riot Games', content: '' } },
      'https://boards-api.greenhouse.io/v1/boards/riotgames/jobs': { json: { jobs: [{ id: 1 }, { id: 2 }], meta: { total: 2 } } }
    })
    expect(await probeBoard('greenhouse', 'riotgames')).toEqual({ ok: true, name: 'Riot Games', jobs: 2 })
  })

  it('says so when a board does not exist', async () => {
    stubFetch({})
    expect(await probeBoard('greenhouse', 'nobody')).toEqual({ ok: false, error: 'Greenhouse has no board named "nobody".' })
    expect(await probeBoard('personio', 'nobody')).toMatchObject({ ok: false })
  })

  it('counts Rippling, Breezy and Personio postings without reading descriptions', async () => {
    const rippling = fixtureJson<unknown[]>('rippling-list.json')
    const breezy = fixtureJson<any[]>('breezy-list.json')
    const seen = stubFetch({
      'https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs': { json: rippling },
      'https://jobs.breezy.hr/json': { json: breezy },
      'https://demo.jobs.personio.de/xml': { text: fixtureText('personio.xml') }
    })
    expect(await probeBoard('rippling', 'rippling')).toEqual({ ok: true, name: null, jobs: 3 })
    expect(await probeBoard('breezy', 'jobs')).toEqual({ ok: true, name: 'Breezy HR', jobs: 2 })
    expect(await probeBoard('personio', 'demo')).toEqual({ ok: true, name: null, jobs: 4 })
    expect(seen).toHaveLength(3)
  })

  it('treats a SmartRecruiters company with no postings as unknown', async () => {
    stubFetch({
      'https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings?limit=1': { json: { totalFound: 298, content: [] } },
      'https://api.smartrecruiters.com/v1/companies/nobody/postings?limit=1': { json: { totalFound: 0, content: [] } }
    })
    expect(await probeBoard('smartrecruiters', 'Ubisoft2')).toEqual({ ok: true, name: null, jobs: 298 })
    expect(await probeBoard('smartrecruiters', 'nobody')).toMatchObject({ ok: false })
  })

  it('rejects a system it cannot read', async () => {
    expect(await probeBoard('workday', 'acme')).toMatchObject({ ok: false, error: expect.stringContaining('workday') })
  })
})
