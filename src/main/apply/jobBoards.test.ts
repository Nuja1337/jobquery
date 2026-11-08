import { describe, expect, it } from 'vitest'
import { isJobBoardUrl } from './jobBoards'

describe('isJobBoardUrl', () => {
  it('knows the aggregator sites jobpls reads', () => {
    for (const url of [
      'https://www.themuse.com/jobs/gitlab/staff-backend-engineer-6d4207',
      'https://jobicy.com/jobs/159648-staff-machine-learning-engineer',
      'https://himalayas.app/companies/gardens-interactive/jobs/gameplay-engineer',
      'https://weworkremotely.com/remote-jobs/squarespace-staff-software-engineer',
      'https://remotive.com/remote-jobs/software-dev/abc',
      'https://uk.adzuna.co.uk/jobs/details/1'
    ]) {
      expect(isJobBoardUrl(url), url).toBe(true)
    }
  })

  it('does not match employer sites or application systems', () => {
    for (const url of [
      'https://job-boards.greenhouse.io/gitlab/jobs/8490477002',
      'https://acme.breezy.hr/p/98323abf2296-role',
      'https://demo.jobs.personio.de/job/1',
      'https://ats.rippling.com/rippling/jobs/abc',
      'https://notthemuse.com/jobs/1',
      'not a url'
    ]) {
      expect(isJobBoardUrl(url), url).toBe(false)
    }
  })
})
