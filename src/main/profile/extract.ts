import { z } from 'zod'
import type { Profile, VoiceProfile } from '@shared/types'
import type { LlmService } from '../llm/service'
import { lintText } from '../writing/lint'
import { passingSignaturePhrases } from '../writing/prompts'

const ResumeSchema = z.object({
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  linkedin: z.string(),
  github: z.string(),
  portfolio: z.string(),
  website: z.string(),
  otherLinks: z.array(z.string()),
  headline: z.string(),
  summary: z.string(),
  yearsExperience: z.number().nullable(),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      start: z.string(),
      end: z.string(),
      highlights: z.array(z.string())
    })
  ),
  education: z.array(z.object({ school: z.string(), degree: z.string(), field: z.string(), start: z.string(), end: z.string() })),
  skills: z.array(z.string()),
  certifications: z.array(z.string()),
  languages: z.array(z.string()),
  projects: z.array(z.object({ name: z.string(), description: z.string(), url: z.string(), highlights: z.array(z.string()) }))
})

const RESUME_SYSTEM = `You turn a resume into structured data. Accuracy matters more than anything else, because every later step trusts this data.

- Copy facts exactly as the resume states them. Keep numbers, names and tools as written.
- Highlights are the resume's own bullet points, cleaned of broken line wraps. Don't rewrite or embellish them.
- Never invent anything. Use an empty string or empty list when the resume doesn't say.
- Dates: YYYY-MM when the month is known, otherwise YYYY. Use "present" for a current role.
- experience is newest first.
- yearsExperience: total years of professional work computed from the dates, rounded down, or null if unclear.
- headline: their current or most recent title and focus, at most 10 words, using the resume's own words.
- summary: the resume's own summary or profile section if it has one, otherwise an empty string.
- skills: individual tools, languages and skills, one per item, no duplicates.`

/** Reads a resume into a draft profile. Fields the resume doesn't cover keep their current values. */
export async function extractProfileFromText(llm: LlmService, resumeText: string, current: Profile): Promise<Profile> {
  const res = await llm.json({
    task: 'extract_profile',
    stage: 'extraction',
    promptVersion: 'resume-v1',
    system: RESUME_SYSTEM,
    prompt: `RESUME\n"""\n${resumeText.slice(0, 40_000)}\n"""`,
    schema: ResumeSchema,
    schemaName: 'resume',
    maxTokens: 12_000,
    effort: 'low'
  })
  const r = res.value
  const pick = (extracted: string, existing: string) => (extracted.trim() ? extracted.trim() : existing)
  const nonEmpty = <T,>(extracted: T[], existing: T[]) => (extracted.length ? extracted : existing)
  return {
    ...current,
    fullName: pick(r.fullName, current.fullName),
    email: pick(r.email, current.email),
    phone: pick(r.phone, current.phone),
    location: pick(r.location, current.location),
    links: {
      linkedin: pick(r.linkedin, current.links.linkedin),
      github: pick(r.github, current.links.github),
      portfolio: pick(r.portfolio, current.links.portfolio),
      website: pick(r.website, current.links.website),
      other: nonEmpty(r.otherLinks.filter(Boolean), current.links.other)
    },
    headline: pick(r.headline, current.headline),
    summary: pick(r.summary, current.summary),
    yearsExperience: r.yearsExperience != null && r.yearsExperience >= 0 ? Math.floor(r.yearsExperience) : current.yearsExperience,
    experience: nonEmpty(
      r.experience.map((e) => ({
        company: e.company,
        title: e.title,
        location: e.location || undefined,
        start: e.start || undefined,
        end: e.end || undefined,
        highlights: e.highlights.filter(Boolean)
      })),
      current.experience
    ),
    education: nonEmpty(
      r.education.map((e) => ({ school: e.school, degree: e.degree || undefined, field: e.field || undefined, start: e.start || undefined, end: e.end || undefined })),
      current.education
    ),
    skills: nonEmpty([...new Set(r.skills.map((s) => s.trim()).filter(Boolean))], current.skills),
    certifications: nonEmpty(r.certifications.filter(Boolean), current.certifications),
    languages: nonEmpty(r.languages.filter(Boolean), current.languages),
    projects: nonEmpty(
      r.projects.map((p) => ({ name: p.name, description: p.description, url: p.url || undefined, highlights: p.highlights.filter(Boolean) })),
      current.projects
    )
  }
}

const VoiceSchema = z.object({
  summary: z.string(),
  formality: z.enum(['casual', 'neutral', 'formal']),
  traits: z.array(z.string()),
  signaturePhrases: z.array(z.string()),
  avoid: z.array(z.string())
})

const VOICE_SYSTEM = `You study someone's writing so another writer can sound like them in job applications.

Describe how they write, not what they wrote about:
- summary: 2 to 4 plain sentences on their tone, how directly they get to the point, how technical they are, whether they use contractions or humor, how they open and close.
- formality: casual, neutral or formal.
- traits: 4 to 8 short, specific observations a writer could follow, such as "uses first names, not titles" or "states numbers without hedging".
- signaturePhrases: 3 to 6 short phrases copied word for word from the samples that sound like them. Skip generic phrases, stock cover letter lines and anything about loving games or being passionate.
- avoid: 3 to 6 things that would sound wrong coming from them, such as "exclamation marks" or "corporate words like synergy".

Base every point on the samples. Don't invent traits the samples don't show.`

/** Builds a voice profile from the user's cover letters and writing samples. */
export async function buildVoice(llm: LlmService, samples: Array<{ id: string; name: string; text: string }>): Promise<VoiceProfile> {
  const usable = samples.filter((s) => s.text.trim().length > 200)
  if (usable.length === 0) {
    throw new Error('Add at least one writing sample or past cover letter with a few paragraphs of your own writing first.')
  }
  let budget = 14_000
  const parts: string[] = []
  for (const s of usable) {
    if (budget <= 0) break
    const text = s.text.trim().slice(0, budget)
    budget -= text.length
    parts.push(`--- ${s.name} ---\n${text}`)
  }
  const res = await llm.json({
    task: 'voice',
    stage: 'extraction',
    promptVersion: 'voice-v2',
    system: VOICE_SYSTEM,
    prompt: `WRITING SAMPLES\n${parts.join('\n\n')}`,
    schema: VoiceSchema,
    schemaName: 'voice',
    maxTokens: 4000,
    effort: 'medium'
  })
  // Sentence length is measured directly rather than estimated by the model.
  const measured = usable.map((s) => lintText(s.text).stats.avgSentenceWords).filter((n) => n > 0)
  const avgSentenceWords = measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : 16
  return {
    ...res.value,
    // A phrase the style check would flag is not kept, so the writer is never told to use it.
    signaturePhrases: passingSignaturePhrases(res.value.signaturePhrases),
    avgSentenceWords: Math.round(avgSentenceWords * 10) / 10,
    builtFrom: usable.map((s) => s.id),
    builtAt: new Date().toISOString()
  }
}
