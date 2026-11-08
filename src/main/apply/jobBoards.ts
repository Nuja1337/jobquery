// Job boards list other companies' jobs. Their pages link to the employer's application, so a
// form found on one of them (a search box, a newsletter signup) is never the application itself.

const JOB_BOARD_HOSTS = [
  'remotive.com',
  'remoteok.com',
  'remoteok.io',
  'arbeitnow.com',
  'news.ycombinator.com',
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'weworkremotely.com',
  'wellfound.com',
  'angel.co',
  'builtin.com',
  'dice.com',
  'monster.com',
  'simplyhired.com',
  'jooble.org',
  'careerbuilder.com',
  'workingnomads.com',
  'himalayas.app',
  'jobspresso.co',
  'themuse.com',
  'jobicy.com'
]

/** Adzuna runs one site per country, such as adzuna.com, adzuna.co.uk and adzuna.de. */
const ADZUNA = /(^|\.)adzuna\.[a-z.]+$/

/** True when the address is on a job board rather than an employer's own site or application system. */
export function isJobBoardUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return false
  }
  if (ADZUNA.test(host)) return true
  return JOB_BOARD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}
