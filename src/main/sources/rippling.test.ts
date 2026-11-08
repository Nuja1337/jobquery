import { describe, expect, it } from 'vitest'
import { fetchRipplingBoard, parseRipplingJob } from './rippling'
import { fixtureJson, stubFetch, useFastHttp } from './testHelpers'

useFastHttp()

const list = fixtureJson<any[]>('rippling-list.json')
const detail = fixtureJson('rippling-detail.json')
const board = 'https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs'

describe('parseRipplingJob', () => {
  it('reads the list fields and the detail', () => {
    const job = parseRipplingJob(list[1], detail, 'rippling')
    expect(job).toMatchObject({
      source: 'rippling',
      ats: 'rippling',
      atsToken: 'rippling',
      atsJobId: list[1].uuid,
      externalId: list[1].uuid,
      company: 'Rippling',
      title: 'Engineering Manager, HRIS Flow Platform',
      location: 'Toronto, Canada; New York, NY; San Francisco, CA',
      employmentType: 'Full-time',
      salaryMin: 186000,
      salaryMax: 310000,
      salaryCurrency: 'USD',
      url: list[1].url,
      applyUrl: list[1].url
    })
    expect(job.postedAt).toBe(new Date(detail.createdOn).toISOString())
    expect(job.description).not.toContain('<')
    expect(job.description.length).toBeGreaterThan(200)
  })

  it('trims the padded title and falls back to the list when there is no detail', () => {
    const job = parseRipplingJob({ ...list[2], name: ' Account Executive, Broker Channel (Boston) ' }, null, 'rippling', 'Rippling')
    expect(job.title).toBe('Account Executive, Broker Channel (Boston)')
    expect(job.location).toBe('Boston, MA')
    expect(job.description).toBe('')
    expect(job.postedAt).toBeNull()
  })
})

describe('fetchRipplingBoard', () => {
  it('fetches details for new postings only, up to the limit', async () => {
    const routes: Record<string, { json: unknown }> = { [board]: { json: list } }
    for (const item of list) routes[`${board}/${item.uuid}`] = { json: { ...detail, uuid: item.uuid, name: item.name } }
    const seen = stubFetch(routes)
    const result = await fetchRipplingBoard('rippling', 'Rippling', { isKnown: (id) => id === list[0].uuid, detailLimit: 1 })
    expect(seen).toHaveLength(2)
    expect(result.jobs).toHaveLength(2)
    expect(result.complete).toBe(false)
    const withText = result.jobs.filter((j) => j.description)
    expect(withText).toHaveLength(1)
    expect(withText[0].externalId).toBe(list[1].uuid)
  })

  it('is complete when every posting was read', async () => {
    const routes: Record<string, { json: unknown }> = { [board]: { json: list } }
    for (const item of list) routes[`${board}/${item.uuid}`] = { json: { ...detail, uuid: item.uuid } }
    stubFetch(routes)
    const result = await fetchRipplingBoard('rippling')
    expect(result.jobs).toHaveLength(3)
    expect(result.complete).toBe(true)
  })

  it('reports an unknown board as a 404', async () => {
    stubFetch({ [board]: { status: 404, json: { error_code: 'RESOURCE_NOT_FOUND' } } })
    await expect(fetchRipplingBoard('rippling')).rejects.toThrow(/404/)
  })
})
