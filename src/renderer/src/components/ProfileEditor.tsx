import { Plus, Trash2 } from 'lucide-react'
import type { Education, Profile, ProfileFact, Project, WorkExperience } from '@shared/types'
import { cleanApplication } from './applicationFactsHelpers'
import { Button, Card, Field, IconButton, Input, NumberInput, TagInput, Textarea, Toggle } from './ui'

interface Props {
  value: Profile
  onChange: (next: Profile) => void
}

export function Block({ title, hint, children, actions }: { title: string; hint?: string; children: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div>
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          {hint && <p className="text-xs text-faint">{hint}</p>}
        </div>
        {actions}
      </div>
      <div className="space-y-3 p-4">{children}</div>
    </Card>
  )
}

function replaceAt<T>(list: T[], index: number, next: T): T[] {
  return list.map((x, i) => (i === index ? next : x))
}

/** Removes empty lines before saving. */
export function cleanProfile(p: Profile): Profile {
  const lines = (xs: string[]): string[] => xs.map((x) => x.trim()).filter(Boolean)
  return {
    ...p,
    experience: p.experience.map((e) => ({ ...e, highlights: lines(e.highlights) })),
    projects: p.projects.map((x) => ({ ...x, highlights: lines(x.highlights) })),
    facts: p.facts.filter((f) => f.question.trim() || f.answer.trim()),
    application: cleanApplication(p.application)
  }
}

export function ProfileEditor({ value: p, onChange }: Props): React.JSX.Element {
  const set = <K extends keyof Profile>(key: K, v: Profile[K]): void => onChange({ ...p, [key]: v })
  const setLink = (key: 'linkedin' | 'github' | 'portfolio' | 'website', v: string): void => onChange({ ...p, links: { ...p.links, [key]: v } })

  return (
    <div>
      <Block title="Contact">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Full name">
            <Input value={p.fullName} onChange={(e) => set('fullName', e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" value={p.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={p.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Location">
            <Input value={p.location} onChange={(e) => set('location', e.target.value)} placeholder="City, country" />
          </Field>
        </div>
      </Block>

      <Block title="Links">
        <div className="grid grid-cols-2 gap-3">
          <Field label="LinkedIn">
            <Input value={p.links.linkedin} onChange={(e) => setLink('linkedin', e.target.value)} placeholder="https://linkedin.com/in/you" />
          </Field>
          <Field label="GitHub">
            <Input value={p.links.github} onChange={(e) => setLink('github', e.target.value)} placeholder="https://github.com/you" />
          </Field>
          <Field label="Portfolio">
            <Input value={p.links.portfolio} onChange={(e) => setLink('portfolio', e.target.value)} />
          </Field>
          <Field label="Website">
            <Input value={p.links.website} onChange={(e) => setLink('website', e.target.value)} />
          </Field>
        </div>
        <Field label="Other links" hint="Press Enter after each link.">
          <TagInput value={p.links.other} onChange={(v) => onChange({ ...p, links: { ...p.links, other: v } })} placeholder="https://" />
        </Field>
      </Block>

      <Block title="About you">
        <Field label="Headline" hint="One line that says what you do.">
          <Input value={p.headline} onChange={(e) => set('headline', e.target.value)} />
        </Field>
        <Field label="Summary">
          <Textarea rows={4} value={p.summary} onChange={(e) => set('summary', e.target.value)} />
        </Field>
        <Field label="Years of experience" className="w-40">
          <NumberInput value={p.yearsExperience} min={0} max={60} onChange={(v) => set('yearsExperience', v)} />
        </Field>
      </Block>

      <Block title="Work authorization" hint="Used for the eligibility questions on application forms.">
        <Field label="Countries you can work in without sponsorship">
          <TagInput value={p.workAuthorization.authorizedCountries} onChange={(v) => set('workAuthorization', { ...p.workAuthorization, authorizedCountries: v })} placeholder="Add a country" />
        </Field>
        <Toggle checked={p.workAuthorization.needsSponsorship} onChange={(v) => set('workAuthorization', { ...p.workAuthorization, needsSponsorship: v })} label="I need visa sponsorship" />
        <Field label="Notes">
          <Input value={p.workAuthorization.notes} onChange={(e) => set('workAuthorization', { ...p.workAuthorization, notes: e.target.value })} />
        </Field>
      </Block>

      <Block
        title="Experience"
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => set('experience', [...p.experience, { company: '', title: '', highlights: [''] }])}>
            Add job
          </Button>
        }
      >
        {p.experience.length === 0 && <p className="text-sm text-muted">No work history yet. Add a job.</p>}
        {p.experience.map((x, i) => (
          <ExperienceRow key={i} value={x} onChange={(v) => set('experience', replaceAt(p.experience, i, v))} onRemove={() => set('experience', p.experience.filter((_, j) => j !== i))} />
        ))}
      </Block>

      <Block
        title="Education"
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => set('education', [...p.education, { school: '' }])}>
            Add school
          </Button>
        }
      >
        {p.education.length === 0 && <p className="text-sm text-muted">No education added.</p>}
        {p.education.map((x, i) => (
          <EducationRow key={i} value={x} onChange={(v) => set('education', replaceAt(p.education, i, v))} onRemove={() => set('education', p.education.filter((_, j) => j !== i))} />
        ))}
      </Block>

      <Block title="Skills, certifications and languages">
        <Field label="Skills" hint="Press Enter or a comma after each skill.">
          <TagInput value={p.skills} onChange={(v) => set('skills', v)} placeholder="Add a skill" />
        </Field>
        <Field label="Certifications">
          <TagInput value={p.certifications} onChange={(v) => set('certifications', v)} placeholder="Add a certification" />
        </Field>
        <Field label="Languages">
          <TagInput value={p.languages} onChange={(v) => set('languages', v)} placeholder="For example: English (fluent)" />
        </Field>
      </Block>

      <Block
        title="Projects"
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => set('projects', [...p.projects, { name: '', description: '', highlights: [''] }])}>
            Add project
          </Button>
        }
      >
        {p.projects.length === 0 && <p className="text-sm text-muted">No projects added.</p>}
        {p.projects.map((x, i) => (
          <ProjectRow key={i} value={x} onChange={(v) => set('projects', replaceAt(p.projects, i, v))} onRemove={() => set('projects', p.projects.filter((_, j) => j !== i))} />
        ))}
      </Block>

      <Block
        title="Facts"
        hint="Questions that come up again and again, such as notice period or salary expectation."
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => set('facts', [...p.facts, { question: '', answer: '' }])}>
            Add fact
          </Button>
        }
      >
        {p.facts.length === 0 && <p className="text-sm text-muted">No facts yet.</p>}
        {p.facts.map((f: ProfileFact, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
            <Input value={f.question} onChange={(e) => set('facts', replaceAt(p.facts, i, { ...f, question: e.target.value }))} placeholder="Question" aria-label="Question" />
            <Input value={f.answer} onChange={(e) => set('facts', replaceAt(p.facts, i, { ...f, answer: e.target.value }))} placeholder="Answer" aria-label="Answer" />
            <IconButton label="Remove fact" onClick={() => set('facts', p.facts.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </Block>

      <Block title="Notes for the AI" hint="Things to stress, things never to mention, context it should know.">
        <Textarea rows={4} value={p.notesForAi} onChange={(e) => set('notesForAi', e.target.value)} />
      </Block>
    </div>
  )
}

function RowShell({ children, onRemove, label }: { children: React.ReactNode; onRemove: () => void; label: string }): React.JSX.Element {
  return (
    <div className="relative rounded-lg border border-line bg-bg p-3">
      <div className="absolute right-2 top-2">
        <IconButton label={label} onClick={onRemove}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <div className="space-y-3 pr-8">{children}</div>
    </div>
  )
}

function ExperienceRow({ value: x, onChange, onRemove }: { value: WorkExperience; onChange: (v: WorkExperience) => void; onRemove: () => void }): React.JSX.Element {
  return (
    <RowShell onRemove={onRemove} label="Remove job">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Company">
          <Input value={x.company} onChange={(e) => onChange({ ...x, company: e.target.value })} />
        </Field>
        <Field label="Title">
          <Input value={x.title} onChange={(e) => onChange({ ...x, title: e.target.value })} />
        </Field>
        <Field label="Location">
          <Input value={x.location ?? ''} onChange={(e) => onChange({ ...x, location: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <Input value={x.start ?? ''} onChange={(e) => onChange({ ...x, start: e.target.value })} placeholder="2021-03" />
          </Field>
          <Field label="End">
            <Input value={x.end ?? ''} onChange={(e) => onChange({ ...x, end: e.target.value })} placeholder="present" />
          </Field>
        </div>
      </div>
      <Field label="Highlights" hint="One per line. Numbers help.">
        <Textarea rows={4} value={x.highlights.join('\n')} onChange={(e) => onChange({ ...x, highlights: e.target.value.split('\n') })} />
      </Field>
    </RowShell>
  )
}

function EducationRow({ value: x, onChange, onRemove }: { value: Education; onChange: (v: Education) => void; onRemove: () => void }): React.JSX.Element {
  return (
    <RowShell onRemove={onRemove} label="Remove school">
      <div className="grid grid-cols-2 gap-3">
        <Field label="School">
          <Input value={x.school} onChange={(e) => onChange({ ...x, school: e.target.value })} />
        </Field>
        <Field label="Degree">
          <Input value={x.degree ?? ''} onChange={(e) => onChange({ ...x, degree: e.target.value })} />
        </Field>
        <Field label="Field of study">
          <Input value={x.field ?? ''} onChange={(e) => onChange({ ...x, field: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <Input value={x.start ?? ''} onChange={(e) => onChange({ ...x, start: e.target.value })} />
          </Field>
          <Field label="End">
            <Input value={x.end ?? ''} onChange={(e) => onChange({ ...x, end: e.target.value })} />
          </Field>
        </div>
      </div>
    </RowShell>
  )
}

function ProjectRow({ value: x, onChange, onRemove }: { value: Project; onChange: (v: Project) => void; onRemove: () => void }): React.JSX.Element {
  return (
    <RowShell onRemove={onRemove} label="Remove project">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={x.name} onChange={(e) => onChange({ ...x, name: e.target.value })} />
        </Field>
        <Field label="Link">
          <Input value={x.url ?? ''} onChange={(e) => onChange({ ...x, url: e.target.value })} />
        </Field>
      </div>
      <Field label="Description">
        <Textarea rows={2} value={x.description} onChange={(e) => onChange({ ...x, description: e.target.value })} />
      </Field>
      <Field label="Highlights" hint="One per line.">
        <Textarea rows={3} value={x.highlights.join('\n')} onChange={(e) => onChange({ ...x, highlights: e.target.value.split('\n') })} />
      </Field>
    </RowShell>
  )
}
