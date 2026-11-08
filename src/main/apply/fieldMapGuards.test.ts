import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '@shared/defaults'
import type { FieldType, FormField, Profile, Settings } from '@shared/types'
import type { LlmService } from '../llm/service'
import { answerFields, type AnswerDeps, type SavedAnswer } from './answers'
import { isOptIn, isTickableConsent, mapInferredField, mapKnownField, optInAnswer } from './fieldMap'

// Guards for questions the app must not answer by guesswork: residence versus citizenship, opt-ins versus
// skills, consent boxes bundled with other promises, and "worked here before" wording.

const field = (label: string, type: FieldType = 'text', options: string[] = [], required = true): FormField => ({
  key: 'q',
  label,
  type,
  required,
  options,
  placeholder: null,
  maxLength: null,
  fileHint: null
})

const AUSTIN: Profile = { ...EMPTY_PROFILE, fullName: 'Sam Rivera', location: 'Austin, TX' }
const ctx = (profile: Profile, company = 'Acme') => ({ profile, settings: DEFAULT_SETTINGS, jobSource: 'greenhouse' as const, jobLocation: null, company })
const inferred = (f: FormField, profile: Profile = AUSTIN, company = 'Acme') => mapInferredField(f, ctx(profile, company))
const yesNo = (label: string) => field(label, 'select', ['Yes', 'No'])

describe('residence questions', () => {
  it('answers a plain question about where the person lives', () => {
    expect(inferred(yesNo('Are you currently located in the US?'))).toMatchObject({ value: 'Yes', confidence: 0.85 })
    expect(inferred(yesNo('Do you currently live in the United States?'))?.value).toBe('Yes')
    expect(inferred(yesNo('Are you based in Canada?'))?.value).toBe('No')
  })

  it('leaves citizenship and residency status questions alone', () => {
    for (const label of [
      'Are you a lawful permanent resident in the United States?',
      'Are you a US citizen or permanent resident currently residing in the US?',
      'Are you a green card holder living in the US?',
      'Do you hold US citizenship and live in the US?',
      'Are you currently living in the US on a work visa?',
      'Are you currently located in the US and authorized to work here?'
    ]) {
      expect(inferred(yesNo(label)), label).toBeNull()
      expect(mapKnownField(yesNo(label), ctx(AUSTIN)), label).toBeNull()
    }
  })
})

describe('order of the answer sources', () => {
  const llm = { json: () => Promise.reject(new Error('No AI call expected')), text: () => Promise.reject(new Error('No AI call expected')) } as unknown as LlmService
  const job = { id: 'j1', company: 'Acme', title: 'Engineer', location: null, description: '', fit: null, source: 'greenhouse' as const }

  async function answerOne(f: FormField, profile: Profile, saved: SavedAnswer | null = null, settings: Settings = DEFAULT_SETTINGS) {
    const deps: AnswerDeps = { llm, settings, profile, samples: [], findSavedAnswer: () => saved, markAnswerUsed: () => {}, resumePath: null }
    return (await answerFields(deps, job, [f], null)).answers[0]
  }

  it('a profile fact beats the inferred residence answer', async () => {
    const label = 'Are you a lawful permanent resident in the United States?'
    const profile: Profile = { ...AUSTIN, facts: [{ question: label, answer: 'No' }] }
    expect(await answerOne(yesNo(label), profile)).toMatchObject({ value: 'No', source: 'profile' })
  })

  it('a profile fact beats the inferred previous-employer answer', async () => {
    const label = 'Have you ever worked for Acme before?'
    const profile: Profile = { ...AUSTIN, facts: [{ question: label, answer: 'Yes, as a contractor' }] }
    expect(await answerOne(field(label), profile)).toMatchObject({ value: 'Yes, as a contractor' })
  })

  it('a saved answer beats an inferred one', async () => {
    const label = 'Have you ever worked for Acme before?'
    const saved: SavedAnswer = { id: 's1', answer: 'Yes', kind: 'fact' }
    expect(await answerOne(yesNo(label), AUSTIN, saved)).toMatchObject({ value: 'Yes', source: 'answer_bank' })
  })

  it('an inferred answer fills in when nothing else answers', async () => {
    expect(await answerOne(yesNo('Have you ever worked for Acme before?'), AUSTIN)).toMatchObject({ value: 'No', source: 'profile' })
  })

  it('regenerating skips the inferred answer', async () => {
    const f = yesNo('Have you ever worked for Acme before?')
    const calls: unknown[] = []
    const ai = {
      json: (req: unknown) => {
        calls.push(req)
        return Promise.resolve({ value: { answers: [{ key: 'q', value: 'Yes', confidence: 0.9, needsUser: false, note: '' }] }, costUsd: 0 })
      }
    } as unknown as LlmService
    const deps: AnswerDeps = { llm: ai, settings: DEFAULT_SETTINGS, profile: AUSTIN, samples: [], findSavedAnswer: () => null, markAnswerUsed: () => {}, resumePath: null }
    const out = await answerFields(deps, job, [f], null, { regenerateKeys: new Set(['q']) })
    expect(calls).toHaveLength(1)
    expect(out.answers[0]).toMatchObject({ value: 'Yes', source: 'ai' })
  })
})

describe('opt-in detection', () => {
  it('does not treat skill and prose questions as opt-ins', () => {
    for (const label of [
      'What newsletters, blogs or podcasts do you subscribe to?',
      'How do you grow newsletter subscribers? Describe a campaign.',
      'Do you have experience sending and receiving SMS at scale with Twilio?',
      'Have you built WhatsApp or SMS alerts for customers?',
      'Would you like to work on our SMS product?',
      'Would you like to be considered for our newsletter team?',
      'Do you want to lead our job alerts product?'
    ]) {
      expect(isOptIn(label), label).toBe(false)
      for (const type of ['text', 'textarea'] as const) expect(optInAnswer(field(label, type)), `${type}: ${label}`).toBeNull()
      expect(optInAnswer(yesNo(label)), label).toBeNull()
    }
  })

  it('never answers a written field as an opt-in, whatever the wording', () => {
    for (const type of ['text', 'textarea'] as const) {
      expect(optInAnswer(field('Yes - I consent to receiving SMS text messages', type))).toBeNull()
    }
  })

  it('still recognizes the live opt-in wording', () => {
    for (const label of [
      'Yes - I consent to receiving SMS text messages',
      'Yes - I consent to receiving WhatsApp messages',
      'Do you opt-in to receive WhatsApp messages from Stripe Recruiting?',
      'Would you like to receive job alerts by email?',
      'Do you want to join our talent community?',
      'I agree to be contacted about this role via phone and SMS',
      'I agree to be contacted by text',
      'Keep me updated about new roles with the newsletter',
      'Subscribe to our newsletter'
    ]) {
      expect(isOptIn(label), label).toBe(true)
    }
    expect(optInAnswer(field('Do you opt-in to receive WhatsApp messages from Stripe Recruiting?', 'radio', ['Yes', 'No']))).toMatchObject({ value: 'No' })
    expect(optInAnswer(field('Yes - I consent to receiving WhatsApp messages', 'checkbox', [], false))).toMatchObject({ value: 'false' })
  })
})

describe('required consent boxes with the setting on', () => {
  it('ticks the live examples', () => {
    for (const label of [
      "By checking this box, I consent to Discord collecting, storing, and processing my demographic data, which I have voluntarily disclosed, in accordance with Discord's Applicant Privacy Notice.",
      'Can you confirm that everything in this application is true and accurate?',
      'I have read, understand and accept the content of the Privacy Notice and consent to the processing of my data as part of this application.',
      'I have read and agree to the Privacy Policy',
      'I confirm that the information provided is true, accurate and complete'
    ]) {
      expect(isTickableConsent(label, label.includes('Discord') ? 'Discord' : 'Acme'), label).toBe(true)
    }
  })

  it('ticks a truthfulness box that adds "to the best of my knowledge"', () => {
    expect(isTickableConsent('The information I provided is true and complete to the best of my knowledge')).toBe(true)
    expect(isTickableConsent('I confirm that the information is accurate to the best of my knowledge and belief')).toBe(true)
    expect(isTickableConsent('I consent to Acme retaining my data for 12 months', 'Acme')).toBe(true)
    // A skill question about knowledge stays blocked.
    expect(isTickableConsent('Please confirm that you have knowledge of GDPR and that the information is true')).toBe(false)
    expect(isTickableConsent('Do you confirm your knowledge of data protection law?')).toBe(false)
  })

  it('does not tick a second promise added with "and the" or "including"', () => {
    for (const label of [
      'I agree to the privacy policy and the assignment of inventions',
      'I agree to the privacy policy and the non-disparagement clause',
      'I agree to the privacy policy and the confidentiality obligations',
      'I agree to the privacy policy and the employee handbook',
      'I agree to the privacy policy and the code of conduct',
      'I acknowledge the privacy notice and the at will policy',
      'I consent to the processing of my personal data and the use of my image',
      'I consent to the processing of my personal data, including health information',
      'I consent to the processing of my personal data including my immigration status',
      'I consent to the processing of my personal data, including my social security number',
      'I consent to the processing of my personal data for screening, including psychometric assessment',
      'I consent to the processing of my personal data and the use of cookies for advertising'
    ]) {
      expect(isTickableConsent(label, 'Acme'), label).toBe(false)
    }
  })

  it('does not tick a clause that adds something after the privacy phrase', () => {
    expect(isTickableConsent('I confirm the information is accurate and employer may reach out to my old teams', 'Acme')).toBe(false)
  })

  it('does not tick consent bundled with another promise', () => {
    for (const label of [
      'I confirm the information is true and complete. I authorize the investigation of all statements and release from all liability.',
      'I confirm the information is true and complete and I authorize Acme to verify it and contact my references and former employers',
      'I confirm the information is true. If hired, my employment is at-will.',
      'I consent to Acme collecting, storing and using my biometric data (facial geometry)',
      'I consent to the processing of my personal data by automated employment decision tools',
      'I acknowledge the privacy notice and consent to a drug test',
      'I acknowledge the privacy notice and agree to submit to a credit check',
      'I acknowledge the privacy notice and consent to being recorded',
      'I confirm that I hold a valid security clearance and that the information I provided is accurate',
      'Please confirm the following statements are true: I am willing to work on-site 5 days a week',
      'I confirm the information is accurate and I agree to be contacted about this role via phone and SMS',
      'I consent to my data being shared with partners',
      'Have you read and understood the job description, and can you confirm the details are correct?',
      'I confirm that I am at least 18 years old and that all information provided is true.',
      'Please confirm that the following is true: I can work from our Austin office 5 days a week',
      'Do you understand data protection regulations such as GDPR?',
      'Can you confirm you have hands-on experience with data processing pipelines?'
    ]) {
      expect(isTickableConsent(label), label).toBe(false)
    }
  })

  it('only allows the name of the employer in the label', () => {
    const label = "I consent to Globex collecting and processing my data in accordance with its Privacy Notice"
    expect(isTickableConsent(label, 'Globex')).toBe(true)
    expect(isTickableConsent(label, 'Acme')).toBe(false)
  })

  it('does not tick pure agreement words with nothing to agree to', () => {
    for (const label of ['I agree', 'I have read and understand', 'Yes, I confirm']) {
      expect(isTickableConsent(label), label).toBe(false)
    }
  })
})

describe('previous employer', () => {
  const worked = (company: string): Profile => ({ ...AUSTIN, experience: [{ company, title: 'Engineer', start: '2018', end: '2020', highlights: [] }] })
  const at = (company: string, label: string, profile: Profile) => inferred(yesNo(label), profile, company)

  it('leaves questions that are not about working for the company', () => {
    expect(at('Stripe', "Have you ever worked with Stripe's API before?", AUSTIN)).toBeNull()
    expect(at('Stripe', 'Have you ever been employed by a company that competes with Stripe?', AUSTIN)).toBeNull()
    expect(at('Stripe', 'Have you previously worked for a Stripe customer?', AUSTIN)).toBeNull()
    expect(at('Remote', 'Have you ever worked remote before?', AUSTIN)).toBeNull()
  })

  it('does not match a longer company name from a shorter one', () => {
    expect(at('Google', 'Have you ever been employed by Google DeepMind?', worked('Google'))).toBeNull()
  })

  it('leaves it to the person when the names only share a prefix', () => {
    expect(at('Google DeepMind', 'Have you ever been employed by Google DeepMind?', worked('Google'))).toMatchObject({ needsUser: true })
  })

  it('keeps the live examples', () => {
    const figma = 'Have you ever worked for Figma before, as an employee or a contractor/consultant?'
    expect(at('Figma', figma, worked('Figma, Inc.'))?.value).toBe('Yes')
    expect(at('Figma', figma, AUSTIN)?.value).toBe('No')
    const stripe = 'Have you ever been employed by Stripe or a Stripe affiliate?'
    expect(at('Stripe', stripe, worked('Stripe'))?.value).toBe('Yes')
    expect(at('Stripe', stripe, AUSTIN)?.value).toBe('No')
  })
})

describe('highest degree', () => {
  const options = ["Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Doctor of Philosophy (Ph.D.)', 'High School']
  const edu = (...degrees: string[]): Profile => ({ ...AUSTIN, education: degrees.map((degree, i) => ({ school: `School ${i}`, degree, end: String(2000 + i * 3) })) })

  it('picks the highest degree, not the latest', () => {
    expect(inferred(field('Highest degree earned', 'select', options), edu('PhD', 'BS'))?.value).toBe('Doctor of Philosophy (Ph.D.)')
    expect(inferred(field('Highest level of education completed', 'select', options), edu('BS', 'MS', 'Associate'))?.value).toBe("Master's Degree")
  })

  it('still uses the latest entry for a plain "Degree" box', () => {
    expect(inferred(field('Degree', 'select', options), edu('PhD', 'BS'))?.value).toBe("Bachelor's Degree")
  })

  it('leaves it alone when a degree is not recognized', () => {
    expect(inferred(field('Highest degree earned', 'select', options), edu('Diplom-Ingenieur', 'BS'))).toBeNull()
  })
})

describe('common consent wordings', () => {
  it('ticks plain truthfulness and data-handling boxes', () => {
    for (const label of [
      'I certify that the information in this application is true and complete.',
      'I certify that the information provided is true, accurate and complete.',
      'By submitting, I consent to Acme storing my personal data for recruitment purposes.',
      'I have read and agree to the Privacy Policy.'
    ]) {
      expect(isTickableConsent(label, 'Acme'), label).toBe(true)
    }
  })

  it('still refuses anything bundled with them', () => {
    for (const label of [
      'I agree to the privacy policy and to receive marketing emails.',
      'I agree to the Terms of Service and Privacy Policy.',
      'I consent to Acme sharing my data with its affiliates.',
      'I confirm the information is accurate and I am 18 years or older.',
      'I acknowledge the privacy notice and agree to a background check.',
      'I understand that false information may result in termination of employment.',
      'I certify that the information is true and complete and that Acme may contact my references.'
    ]) {
      expect(isTickableConsent(label, 'Acme'), label).toBe(false)
    }
  })
})
