import type { CoverLetterLength, FitAssessment, Profile, Settings } from '@shared/types'
import { trimDescription } from '../util/text'
import { BANNED_PHRASES } from './rules'

// Bump a version when its template changes, so cached answers from the old template aren't reused.
export const PROMPT_VERSIONS = {
  coverLetter: 'cover-v1',
  answer: 'answer-v1',
  revise: 'revise-v1'
}

export const LENGTH_TARGETS: Record<CoverLetterLength, { min: number; max: number; paragraphs: string }> = {
  short: { min: 120, max: 190, paragraphs: '2 or 3' },
  medium: { min: 200, max: 300, paragraphs: '3' },
  long: { min: 300, max: 420, paragraphs: '3 or 4' }
}

export interface WritingSample {
  name: string
  text: string
}

export interface JobForWriting {
  id: string
  company: string
  title: string
  location: string | null
  description: string
  fit: FitAssessment | null
}

/** Stable instructions shared by every writing call. Kept identical across calls so providers can cache it. */
export function buildWritingSystem(settings: Settings): string {
  const banned = [
    ...BANNED_PHRASES.filter((r) => r.severity !== 'low').map((r) => r.phrase),
    ...settings.writing.bannedPhrases
  ]
  const styleNotes = settings.writing.styleNotes.trim()
  return `You write job application materials for one person, in their voice. What you write is sent under their name, so it has to sound like them and it has to be true.

Truth
- Use only facts found in the candidate profile, their documents and their notes. Never invent employers, titles, dates, numbers, tools, degrees, people or stories.
- If a fact would help but isn't there, write around it. If the question can't be answered honestly without it, reply with exactly one line: NEEDS_INPUT: <what is missing, in a few words>
- Don't claim feelings or motives the notes don't support. "I want this because..." needs a reason from the profile, the notes or the posting.
- Follow the candidate's notes about what to stress and what never to mention.
- If the question asks whether or how the candidate used AI, or asks them to agree to, certify or consent to something, reply with NEEDS_INPUT. Only the candidate can answer those.

How it should read
- Plain sentences, the way this person would explain it to a friend who works in the same field.
- Specific beats general. One real project with a number or a named tool says more than three adjectives.
- Connect their experience to something specific in the posting, such as the product, a problem the team has, a tool or a stated requirement.
- Vary sentence length. Mix short sentences with longer ones. Don't start two paragraphs the same way.
- Match the voice profile and writing samples for tone, word choice and how formal to be. Never copy sentences from the samples.
- Don't open with "I am writing to", "As a [role] with N years" or "I hope this finds you well". Don't close with "I look forward to the opportunity to discuss". A plain sign-off is fine.

Never use
- Dashes as pauses (em dash, en dash or double hyphen). Use a comma or a period.
- "Not only X but Y", "It's not X, it's Y" or "isn't just".
- Lists of three where one or two items would do. Semicolons that stack sentences. Colons that join sentences.
- Rhetorical questions, exclamation marks, emoji, arrows, markdown, bullet points or headings.
- Filler words such as just, simply, really, actually, truly, genuinely and incredibly.
- Any of these words or phrases: ${banned.join(', ')}.
- Placeholders such as [Company Name].
${styleNotes ? `\nThe candidate's own style notes\n${styleNotes}\n` : ''}
Output
- Only the text that goes into the form. No preamble, no notes to the candidate, no quotation marks around it.`
}

/** The candidate profile as compact text. Shared by fit scoring and writing so both see the same facts. */
export function renderProfile(profile: Profile): string {
  const lines: string[] = []
  const push = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) lines.push(`${label}: ${value.trim()}`)
  }
  push('Name', profile.fullName)
  push('Location', profile.location)
  push('Headline', profile.headline)
  if (profile.yearsExperience != null) push('Years of experience', String(profile.yearsExperience))
  push('Summary', profile.summary)
  const auth = profile.workAuthorization
  if (auth.authorizedCountries.length || auth.notes) {
    push('Work authorization', `${auth.authorizedCountries.join(', ') || 'not stated'}${auth.needsSponsorship ? ', needs visa sponsorship' : ', no sponsorship needed'}${auth.notes ? `. ${auth.notes}` : ''}`)
  }
  if (profile.skills.length) push('Skills', profile.skills.join(', '))
  if (profile.experience.length) {
    lines.push('Experience:')
    for (const e of profile.experience) {
      lines.push(`- ${e.title} at ${e.company}${e.location ? `, ${e.location}` : ''} (${e.start ?? '?'} to ${e.end ?? 'present'})`)
      for (const h of e.highlights) lines.push(`  * ${h}`)
    }
  }
  if (profile.projects.length) {
    lines.push('Projects:')
    for (const p of profile.projects) {
      lines.push(`- ${p.name}: ${p.description}${p.url ? ` (${p.url})` : ''}`)
      for (const h of p.highlights) lines.push(`  * ${h}`)
    }
  }
  if (profile.education.length) {
    lines.push('Education:')
    for (const ed of profile.education) {
      lines.push(`- ${[ed.degree, ed.field].filter(Boolean).join(' in ') || 'Studies'} at ${ed.school}${ed.end ? ` (${ed.end})` : ''}`)
    }
  }
  if (profile.certifications.length) push('Certifications', profile.certifications.join(', '))
  if (profile.languages.length) push('Languages', profile.languages.join(', '))
  const links = [profile.links.linkedin, profile.links.github, profile.links.portfolio, profile.links.website, ...profile.links.other].filter(Boolean)
  if (links.length) push('Links', links.join(', '))
  if (profile.facts.length) {
    lines.push('Facts the candidate gave for applications:')
    for (const f of profile.facts) lines.push(`- ${f.question}: ${f.answer}`)
  }
  return lines.join('\n')
}

/** Profile, voice and writing samples. Stable per user, so it is cached after the system prompt. */
export function buildCandidateContext(profile: Profile, samples: WritingSample[]): string {
  const parts = [`CANDIDATE PROFILE\n${renderProfile(profile)}`]
  if (profile.notesForAi.trim()) {
    parts.push(`CANDIDATE'S NOTES FOR YOU (follow these)\n${profile.notesForAi.trim()}`)
  }
  if (profile.voice) {
    const v = profile.voice
    parts.push(
      [
        'VOICE PROFILE',
        v.summary,
        `Formality: ${v.formality}. Typical sentence length: about ${Math.round(v.avgSentenceWords)} words.`,
        v.traits.length ? `Traits: ${v.traits.join('; ')}` : '',
        v.signaturePhrases.length ? `Phrases they use: ${v.signaturePhrases.map((s) => `"${s}"`).join(', ')}` : '',
        v.avoid.length ? `Would sound wrong from them: ${v.avoid.join('; ')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  const usable = samples.filter((s) => s.text.trim()).slice(0, 3)
  if (usable.length) {
    parts.push(
      `WRITING SAMPLES (for voice and tone only, do not reuse their sentences or facts unless the profile has them too)\n${usable
        .map((s) => `--- ${s.name} ---\n${s.text.trim().slice(0, 3000)}`)
        .join('\n\n')}`
    )
  }
  return parts.join('\n\n')
}

function renderJob(job: JobForWriting, maxChars: number): string {
  const lines = [`Company: ${job.company}`, `Title: ${job.title}`]
  if (job.location) lines.push(`Location: ${job.location}`)
  if (job.fit) {
    if (job.fit.matches.length) lines.push(`Where the candidate matches: ${job.fit.matches.join('; ')}`)
    if (job.fit.gaps.length) lines.push(`Gaps to avoid drawing attention to: ${job.fit.gaps.join('; ')}`)
    if (job.fit.keywords.length) lines.push(`Posting keywords worth using where they're true: ${job.fit.keywords.join(', ')}`)
  }
  lines.push(`Posting:\n"""\n${trimDescription(job.description, maxChars)}\n"""`)
  return lines.join('\n')
}

export function coverLetterPrompt(
  job: JobForWriting,
  length: CoverLetterLength,
  candidateFirstName: string,
  guidance: string | null
): string {
  const t = LENGTH_TARGETS[length]
  return `Write a cover letter for this job.

JOB
${renderJob(job, 6000)}

Length: ${t.min} to ${t.max} words in ${t.paragraphs} paragraphs, plus a greeting line and a sign-off.
Greeting: use a name only if the posting gives the hiring manager's name. Otherwise write "Hi ${job.company} team,".
Sign off with "${candidateFirstName || 'the candidate\'s first name'}" on its own line after a short closing word such as "Thanks," or "Best,".
Open with something concrete: a result they got that matters for this role, or a specific thing about ${job.company}'s work that connects to their experience.${guidance ? `\n\nThe candidate asked for this: ${guidance}` : ''}`
}

export function answerPrompt(
  job: JobForWriting,
  question: { label: string; maxLength: number | null; long: boolean },
  guidance: string | null
): string {
  const limit = question.maxLength ? `Hard limit: ${question.maxLength} characters, counting spaces.` : ''
  const size = question.long
    ? 'Length: whatever the question needs, usually 60 to 150 words. One or two paragraphs.'
    : 'Length: one to three sentences.'
  return `Answer this question from the ${job.company} application for ${job.title}.

QUESTION
"${question.label}"

${size} ${limit}
Answer the question that was asked, directly, in the first sentence. Use a specific example from the profile when the question invites one.

JOB
${renderJob(job, 3500)}${guidance ? `\n\nThe candidate asked for this: ${guidance}` : ''}`
}

export function revisePrompt(draft: string, problems: string, maxChars: number | null): string {
  return `A style check found problems in this draft you wrote. Rewrite it to fix every one of them.
Keep every fact and the meaning. Keep about the same length${maxChars ? `, and stay under ${maxChars} characters` : ''}. Change only what you need to.
Return only the revised text.

PROBLEMS
${problems}

DRAFT
"""
${draft}
"""`
}
