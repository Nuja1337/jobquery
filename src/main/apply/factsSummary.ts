import { EMPTY_APPLICATION_FACTS } from '@shared/defaults'
import type { ApplicationFacts, AuthorizationStatus, EmploymentType, JobPreferences, TravelWillingness } from '@shared/types'

// Renders the facts the candidate gave as plain lines for the model that fills short fields. A fact that
// was not answered is written as "not stated", so the model sees the gap and does not fill it.

const NOT_STATED = 'not stated'

const AUTHORIZATION_TEXT: Record<AuthorizationStatus, string> = {
  citizen: 'citizen',
  permanent_resident: 'permanent resident',
  visa: 'work visa',
  none: 'no work authorization'
}

const TRAVEL_TEXT: Record<TravelWillingness, string> = {
  none: 'none',
  some: 'some travel',
  frequent: 'frequent travel'
}

const EMPLOYMENT_TEXT: Record<EmploymentType, string> = {
  full_time: 'full time',
  part_time: 'part time',
  contract: 'contract',
  contract_to_hire: 'contract to hire',
  temporary: 'temporary',
  internship: 'internship',
  freelance: 'freelance'
}

const yesNo = (value: boolean | null | undefined): string => (value === true ? 'yes' : value === false ? 'no' : NOT_STATED)

/** The work and availability facts as lines. Unanswered ones read "not stated". */
function workLines(facts: ApplicationFacts): string[] {
  const base = EMPTY_APPLICATION_FACTS
  const wa = { ...base.workArrangement, ...facts.workArrangement }
  const job = { ...base.employment, ...facts.employment }
  const pay = { ...base.employment.currentPay, ...facts.employment?.currentPay }
  const schedule = { ...base.schedule, ...facts.schedule }
  const screening = { ...base.screening, ...facts.screening }
  const list = (items: string[]): string => (items.length ? items.join(', ') : NOT_STATED)
  const days = wa.maxOfficeDaysPerWeek === null ? NOT_STATED : String(wa.maxOfficeDaysPerWeek)
  const payText = pay.stance === 'decline' ? 'prefers not to say' : pay.stance === 'amount' && pay.amount !== null ? `${pay.amount} ${pay.currency} per ${pay.period}` : NOT_STATED
  return [
    `Would work on site: ${yesNo(wa.onsite)}`,
    `Would work hybrid: ${yesNo(wa.hybrid)}`,
    `Would work remotely: ${yesNo(wa.remote)}`,
    `Most days a week in the office: ${days}`,
    `Cities they can commute to: ${list(wa.commutableCities)}`,
    `Kinds of work they take: ${list(job.types.map((t) => EMPLOYMENT_TEXT[t] ?? t))}`,
    `Hours a week they can work: ${job.hoursPerWeek === null ? NOT_STATED : job.hoursPerWeek}`,
    `Currently employed: ${yesNo(job.currentlyEmployed)}`,
    `Desired job title: ${job.desiredTitle.trim() || NOT_STATED}`,
    `Current pay: ${payText}`,
    `Would work evenings: ${yesNo(schedule.evenings)}`,
    `Would work weekends: ${yesNo(schedule.weekends)}`,
    `Would work nights: ${yesNo(schedule.nights)}`,
    `Would be on call: ${yesNo(schedule.onCall)}`,
    `Would work overtime: ${yesNo(schedule.overtime)}`,
    `Time zones they can work in: ${list(schedule.timeZones)}`,
    `Willing to undergo a background check: ${yesNo(screening.backgroundCheck)}`,
    `Willing to take a drug test: ${yesNo(screening.drugTest)}`,
    `Willing to undergo a credit check: ${yesNo(screening.creditCheck)}`
  ]
}

/**
 * The candidate's stated facts as lines of text: relocation and the places they would move to, travel,
 * work authorization per country, clearance, driver's license, whether they are over 18, the remote
 * preference, and the work and availability facts. The text goes into the `form_map` context next to the profile. Facts the candidate left
 * empty read "not stated". Call it with `profile.application` and the job preferences from Settings.
 */
export function renderApplicationFacts(facts: ApplicationFacts, prefs: Pick<JobPreferences, 'remote'>): string {
  const lines: string[] = []

  const { willing, places } = facts.relocation
  lines.push(`Willing to relocate: ${willing === true ? 'yes' : willing === false ? 'no' : NOT_STATED}`)
  if (willing !== false) lines.push(`Places they would relocate to: ${places.length ? places.join(', ') : willing === true ? 'any place' : NOT_STATED}`)

  lines.push(`Travel for work: ${facts.travel ? TRAVEL_TEXT[facts.travel] : NOT_STATED}`)

  if (facts.authorization.length === 0) {
    lines.push(`Work authorization: ${NOT_STATED}`)
  } else {
    for (const a of facts.authorization) {
      const sponsorship = a.needsSponsorship ? 'needs visa sponsorship' : 'needs no visa sponsorship'
      lines.push(`Work authorization in ${a.country}: ${AUTHORIZATION_TEXT[a.status]}, ${sponsorship}${a.notes.trim() ? `. ${a.notes.trim()}` : ''}`)
    }
  }

  lines.push(`Security clearance: ${facts.clearance.trim() || NOT_STATED}`)
  lines.push(`Driver's license: ${yesNo(facts.driversLicense)}`)
  lines.push(`Over 18: ${yesNo(facts.over18)}`)
  lines.push(`Remote preference: ${prefs.remote.length ? prefs.remote.join(', ') : NOT_STATED}`)

  lines.push(...workLines(facts))

  return lines.join('\n')
}
