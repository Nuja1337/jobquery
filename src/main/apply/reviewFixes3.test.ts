import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_APPLICATION_FACTS, EMPTY_PROFILE } from '@shared/defaults'
import type { ApplicationFacts, AuthorizationEntry, FieldType, FormField, Profile, Settings } from '@shared/types'
import { splitFullName as editorSplit } from '../../renderer/src/components/workFactsHelpers'
import { splitFullName } from '../db/repos/profile'
import { previouslyAppliedAnswer } from './companyQuestions'
import { agreeAnswer, isTickableConsent, mapInferredField, mapKnownField, mustAskUser, type MapContext } from './fieldMap'
import { willingnessFamily } from './questionFamilies'

// Regression tests for the final code review (answer rules).

const field = (label: string, type: FieldType = 'select', options: string[] = ['Yes', 'No']): FormField =>
  ({ key: 'q', label, type, required: true, options: type === 'textarea' || type === 'text' ? [] : options, placeholder: null, maxLength: null, fileHint: null }) as FormField

const US_CITIZEN: AuthorizationEntry = { country: 'United States', status: 'citizen', needsSponsorship: false, notes: '', visaType: '', expires: null, anyEmployer: true }

const profileWith = (facts: Partial<ApplicationFacts> = {}, experience: Profile['experience'] = []): Profile => ({
  ...EMPTY_PROFILE,
  fullName: 'Alex Rivera',
  location: 'Seattle, WA',
  yearsExperience: 6,
  experience,
  workAuthorization: { authorizedCountries: ['United States'], needsSponsorship: false, notes: '' },
  application: { ...structuredClone(EMPTY_APPLICATION_FACTS), authorization: [US_CITIZEN], citizenships: ['United States'], ...facts }
})

const run = (f: FormField, profile: Profile = profileWith(), ctx: Partial<MapContext> = {}) => {
  const c: MapContext = { profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse', jobLocation: 'Seattle, WA', company: 'Acme', ...ctx }
  return mapKnownField(f, c) ?? mapInferredField(f, c)
}

describe('1: nationality words name the country asked about', () => {
  it.each([
    'Are you a Canadian citizen?',
    'Are you a British citizen?',
    'Are you a German citizen?',
    'Are you a Mexican citizen?',
    'Are you an EU citizen?',
    'Are you a citizen of the European Union?',
    'Are you a Canadian citizen or permanent resident?',
    'Are you an Indian citizen?'
  ])('answers No for a US citizen on a Seattle job: %s', (label) => {
    expect(run(field(label))).toMatchObject({ value: 'No', needsUser: false })
  })

  it('answers No on a Toronto job too, and Yes for the home country', () => {
    const toronto = { jobLocation: 'Toronto, ON, Canada' }
    expect(run(field('Are you a Canadian citizen?'), profileWith(), toronto)).toMatchObject({ value: 'No' })
    expect(run(field('Are you an American citizen?'), profileWith(), toronto)).toMatchObject({ value: 'Yes' })
  })

  it('answers Yes when the owner holds that citizenship', () => {
    const dual = profileWith({ citizenships: ['United States', 'Canada'] })
    expect(run(field('Are you a Canadian citizen?'), dual)).toMatchObject({ value: 'Yes' })
    expect(run(field('Are you a Canadian citizen or permanent resident?'), dual)).toMatchObject({ value: 'Yes' })
    expect(run(field('Are you a German citizen?'), dual)).toMatchObject({ value: 'No' })
    const german = profileWith({ citizenships: ['Germany'] })
    expect(run(field('Are you an EU citizen?'), german)).toMatchObject({ value: 'Yes' })
  })

  it('answers Yes for a permanent resident of that country', () => {
    const pr = profileWith({ authorization: [US_CITIZEN, { ...US_CITIZEN, country: 'Canada', status: 'permanent_resident' }] })
    expect(run(field('Are you a Canadian citizen or permanent resident?'), pr)).toMatchObject({ value: 'Yes' })
    expect(run(field('Are you a Canadian permanent resident?'), pr)).toMatchObject({ value: 'Yes' })
    expect(run(field('Are you a Canadian citizen?'), pr)).toMatchObject({ value: 'No' })
  })

  it('answers from a job in two countries without the job country', () => {
    expect(run(field('Are you a Canadian citizen or permanent resident?'), profileWith(), { jobLocation: 'Seattle, WA or Vancouver, BC' })).toMatchObject({ value: 'No', needsUser: false })
  })

  it('flags when the citizenships are not recorded or the nationality is unknown', () => {
    const none = profileWith({ citizenships: [], authorization: [] })
    expect(run(field('Are you a Canadian citizen?'), none)).toMatchObject({ needsUser: true })
    expect(run(field('Are you a Peruvian citizen?'))).toMatchObject({ needsUser: true })
    expect(run(field('Are you a Canadian citizen living in the US?'))).toMatchObject({ needsUser: true })
  })

  it('still answers the country forms', () => {
    expect(run(field('Are you a US citizen?'))).toMatchObject({ value: 'Yes' })
    expect(run(field('Are you a citizen or permanent resident of Canada?'))).toMatchObject({ value: 'No' })
  })
})

describe('2: required consent boxes with a lone or non-Yes option', () => {
  const on: Settings = { ...DEFAULT_SETTINGS, autopilot: { ...DEFAULT_SETTINGS.autopilot, tickRequiredConsent: true } }

  it('picks the lone acknowledgment option', () => {
    const epic = field('I acknowledge that I have read and understand the Epic Games Candidate Privacy Notice.', 'select', ['I Acknowledge / I Agree'])
    expect(agreeAnswer(epic, on, 'Epic Games')).toMatchObject({ value: 'I Acknowledge / I Agree', needsUser: false })
    const riot = field('By submitting an application, I acknowledge that I have read and understand the Riot Games Candidate Privacy Notice.', 'select', ['I Accept / I Agree'])
    expect(agreeAnswer(riot, on, 'Riot Games')).toMatchObject({ value: 'I Accept / I Agree' })
  })

  it('ticks truthfulness and accuracy certifications', () => {
    const epic = field('I confirm all answers provided by me within this application are true and correct.', 'select', ['I Acknowledge / I Agree'])
    expect(agreeAnswer(epic, on, 'Epic Games')).toMatchObject({ value: 'I Acknowledge / I Agree' })
    const bungie = field('By selecting "Yes", I am certifying that, to the best of my knowledge, the information I have provided in this employment application is true and correct.')
    expect(agreeAnswer(bungie, on, 'Bungie')).toMatchObject({ value: 'Yes' })
  })

  it('reads the acknowledgment from a lone option when the label only names the notice', () => {
    const roblox = field("Please review and acknowledge Roblox's Job Applicant Privacy Notice", 'select', ["I acknowledge that I have read and understood Roblox's Job Applicant Privacy Notice."])
    expect(agreeAnswer(roblox, on, 'Roblox')).toMatchObject({ needsUser: false })
    const airbnb = field('Airbnb Candidate Privacy Policy', 'select', ['I acknowledge that I have read and understood the Airbnb Candidate Privacy Policy.'])
    expect(agreeAnswer(airbnb, on, 'Airbnb')).toMatchObject({ needsUser: false })
  })

  it('picks the matching option of several and never one that declines', () => {
    const label = 'I have read and agree to the Privacy Policy'
    expect(agreeAnswer(field(label, 'radio', ['I do not agree', 'I agree']), on)).toMatchObject({ value: 'I agree' })
    expect(agreeAnswer(field(label, 'radio', ['I Disagree', 'I Accept']), on)).toMatchObject({ value: 'I Accept' })
    expect(agreeAnswer(field(label, 'radio', ['I do not agree', 'Decline']), on)).toBeNull()
    expect(agreeAnswer(field(label, 'select', ['I do not agree']), on)).toBeNull()
  })

  it('ticks the China PIPL consent wording and leaves third-party data to the owner', () => {
    const pipl = [
      'I have read the Recruitment Privacy Policy carefully and consent to the Company’s collection and processing of my personal information according to its provisions. 我已仔细阅读《招聘隐私政策》，并同意公司按照其规定收集和处理我的个人信息。',
      'I expressly, specifically, and voluntarily consent to the Company’s processing of my sensitive personal information according to Section 1 thereof. 我知悉并同意公司根据《招聘隐私政策》第1节的规定处理本人的敏感个人信息。',
      'I expressly, specifically, and voluntarily consent to the Company’s cross-border transfer of my personal information to Riot Games Inc. located outside PRC according to Section 4 thereof.',
      'By ticking the box and clicking the "I Agree" button, I expressly and voluntarily consent to the following Recruitment Privacy Policy :通过在方框中打勾并点击"我同意"按键，本人明确自愿同意以下内容招聘隐私政策：'
    ]
    for (const label of pipl) expect(isTickableConsent(label, 'Riot Games'), label).toBe(true)
    const third =
      'I hereby confirm that if I provide the personal information of a third party to the Company, I have already fully explained the matter to the third party and have obtained the consent of the third party for the Company to process his or her personal information.'
    expect(isTickableConsent(third, 'Riot Games')).toBe(false)
  })

  it('leaves arbitration, terms, waivers, non-competes and AI use to the owner', () => {
    const arbitration = field("Please review and acknowledge Roblox's Candidate Arbitration Agreement", 'select', [
      "I acknowledge that I received and had the opportunity to review Roblox's Candidate Arbitration Agreement, and I agree to be bound by its terms."
    ])
    expect(agreeAnswer(arbitration, on, 'Roblox')).toBeNull()
    expect(agreeAnswer(field('I agree to the Terms of Service', 'select', ['I Agree']), on)).toBeNull()
    expect(agreeAnswer(field('I agree to the non-compete agreement', 'select', ['I Agree']), on)).toBeNull()
    expect(agreeAnswer(field('I waive my right to a jury trial', 'select', ['I Agree']), on)).toBeNull()
    expect(agreeAnswer(field('I confirm I did not use AI to write my answers', 'select', ['I Agree']), on)).toBeNull()
  })

  it('does nothing when the setting is off', () => {
    expect(agreeAnswer(field('I acknowledge the Privacy Notice', 'select', ['I Agree']), DEFAULT_SETTINGS, 'Acme')).toBeNull()
  })
})

describe('5: sponsorship for a work permit is one question', () => {
  it('answers Stripe wording from the sponsorship rules', () => {
    expect(run(field('Will you require sponsorship for a work permit now or in the future?'))).toMatchObject({ value: 'No', needsUser: false })
    const visa = profileWith({ authorization: [{ ...US_CITIZEN, status: 'visa', needsSponsorship: true, visaType: 'h1b', anyEmployer: false }] })
    expect(run(field('Will you require sponsorship for a work permit now or in the future?'), visa)).toMatchObject({ value: 'Yes' })
  })

  it('still flags authorization and sponsorship asked together', () => {
    expect(run(field('Are you authorized to work in the US and will you require sponsorship?'))).toMatchObject({ needsUser: true })
  })
})

describe('6: filler words in a years question', () => {
  it.each([
    'Do you have a minimum of 3 years of experience?',
    'Do you have a total of 5 years of experience?',
    'Do you have an overall 5 years of experience?',
    'Do you have at least 3 years of experience?'
  ])('answers from total years: %s', (label) => {
    expect(run(field(label))).toMatchObject({ value: 'Yes', needsUser: false })
  })

  it('still sends a skill years question elsewhere', () => {
    expect(run(field('Do you have a minimum of 3 years of Python experience?'))?.value ?? '').not.toBe('Yes')
  })
})

describe('7: the employment-type family', () => {
  it('leaves history, authorization and tooling questions out', () => {
    for (const label of [
      'Have you ever worked for or provided services to Roblox or any of its subsidiaries as a full-time employee, part-time employee, contractor, intern, or agency worker?',
      'Do you have permanent work authorization in the US?',
      'Have you worked with contract testing tools like Pact?'
    ]) {
      expect(willingnessFamily(label), label).toBeNull()
    }
  })

  it('keeps willingness and role wording', () => {
    for (const label of ['Are you open to a contract role?', 'Are you looking for a full-time role?', 'This is a contract position. Are you ok with that?', 'Are you willing to work part-time?', 'Are you currently employed full-time?', 'Employment type']) {
      expect(willingnessFamily(label), label).toBe('employment_type')
    }
  })

  it('answers permanent work authorization from the country entry', () => {
    expect(run(field('Do you have permanent work authorization in the US?'))).toMatchObject({ value: 'Yes', needsUser: false })
    const visa = profileWith({ authorization: [{ ...US_CITIZEN, status: 'visa', needsSponsorship: true, visaType: 'h1b', anyEmployer: false }] })
    expect(run(field('Do you have permanent work authorization in the US?'), visa)).toMatchObject({ value: 'No' })
    const pr = profileWith({ authorization: [{ ...US_CITIZEN, status: 'permanent_resident' }] })
    expect(run(field('Do you have permanent work authorization in the US?'), pr)).toMatchObject({ value: 'Yes' })
    expect(run(field('Do you have permanent work authorization in the US?'), profileWith({ authorization: [] }))).toMatchObject({ needsUser: true })
  })

  it('answers the Roblox history question from the work history', () => {
    const label = 'Have you ever worked for or provided services to Roblox or any of its subsidiaries as a full-time employee, part-time employee, contractor, intern, or agency worker?'
    expect(run(field(label), profileWith(), { company: 'Roblox' })).toMatchObject({ value: 'No', needsUser: false })
  })
})

describe('8: authorized to work for any employer without sponsorship', () => {
  const label = 'Are you authorized to work for any employer in the US without sponsorship?'
  it('is Yes for a citizen and for a permanent resident', () => {
    expect(run(field(label))).toMatchObject({ value: 'Yes', needsUser: false })
    expect(run(field(label), profileWith({ authorization: [{ ...US_CITIZEN, status: 'permanent_resident' }] }))).toMatchObject({ value: 'Yes' })
  })
  it('is No for a permit tied to one employer', () => {
    expect(run(field(label), profileWith({ authorization: [{ ...US_CITIZEN, status: 'visa', needsSponsorship: false, visaType: 'h1b', anyEmployer: false }] }))).toMatchObject({ value: 'No' })
  })
  it('still flags a negated version', () => {
    expect(run(field('Are you not authorized to work for any employer in the US without sponsorship?'))).toMatchObject({ needsUser: true })
  })
})

describe('12: "If applicable" is not an applied-before follow-up', () => {
  it("leaves Bungie's relocation question alone", () => {
    const f = field('If applicable and you are not in a Bungie-approved location, would you be willing to relocate within 45 days of a start date?')
    expect(previouslyAppliedAnswer(f, 'Bungie', () => false)).toBeNull()
    expect(run(f, profileWith({ relocation: { willing: true, places: [] } }), { company: 'Bungie' })?.note ?? '').not.toMatch(/applied here/)
  })
  it('still blanks a real applied-before follow-up', () => {
    const f = field('If yes, which role did you apply for?', 'text', [])
    expect(previouslyAppliedAnswer({ ...f, required: false }, 'Bungie', () => false)).toMatchObject({ value: '', needsUser: false })
  })
})

describe('13: a follow-up of a No takes the n/a option', () => {
  const tencent = 'As we are majority owned by Tencent, we would like to know if you have worked for Tencent or a company owned or otherwise affiliated with Tencent within the last 12 months.'
  const year = field('If yes, can you please indicate the last year you worked for Tencent and/or an affiliate company.', 'select', ['n/a', '2026', '2025', '2024'])
  const month = field('If yes, can you please indicate the last month you worked for Tencent and/or an affiliate company.', 'select', ['n/a', 'January', 'February'])
  const ctx = { company: 'Riot Games' }

  it('answers No to the parent and n/a to the follow-ups', () => {
    expect(run(field(tencent), profileWith(), ctx)).toMatchObject({ value: 'No' })
    expect(run(year, profileWith(), ctx)).toMatchObject({ value: 'n/a', needsUser: false })
    expect(run(month, profileWith(), ctx)).toMatchObject({ value: 'n/a', needsUser: false })
  })

  it('stays for the owner when the history shows the job', () => {
    const worked = profileWith({}, [{ company: 'Tencent', title: 'Engineer', location: '', start: '2023-01', end: '2024-01', highlights: [] }])
    expect(run(year, worked, ctx)?.value ?? '').not.toBe('n/a')
  })
})

describe('14: needing an accommodation is the owner’s question', () => {
  it('holds back "require an accommodation" and keeps the ability question', () => {
    expect(mustAskUser({ label: 'Do you require an accommodation to perform the essential functions of the job?', type: 'select' })).not.toBeNull()
    expect(mustAskUser({ label: 'Will you need accommodations during the interview process?', type: 'select' })).not.toBeNull()
    expect(mustAskUser({ label: 'Can you perform the essential functions of the job with or without reasonable accommodation?', type: 'select' })).toBeNull()
  })
})

describe('16: a middle initial in the full name', () => {
  it('splits an initial into the middle name', () => {
    expect(splitFullName('Dana Q. Public')).toEqual({ first: 'Dana', middle: 'Q.', last: 'Public' })
    expect(splitFullName('Dana Q Public')).toEqual({ first: 'Dana', middle: 'Q', last: 'Public' })
    expect(splitFullName('Dana Q. Van Public')).toEqual({ first: 'Dana', middle: 'Q.', last: 'Van Public' })
  })
  it('keeps every other case', () => {
    expect(splitFullName('Mary Ann Smith')).toEqual({ first: 'Mary', last: 'Ann Smith' })
    expect(splitFullName('Dana Q.')).toEqual({ first: 'Dana', last: 'Q.' })
    expect(splitFullName('Alex Rivera')).toEqual({ first: 'Alex', last: 'Rivera' })
    expect(splitFullName('Cher')).toEqual({ first: '', last: '' })
  })
  it('matches the editor copy', () => {
    for (const name of ['Dana Q. Public', 'Dana Q Public', 'Dana Q.', 'Mary Ann Smith', 'Alex Rivera', 'Cher', '  ']) expect(editorSplit(name)).toEqual(splitFullName(name))
  })
})
