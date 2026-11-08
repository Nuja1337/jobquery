import type { ApplicationFacts, CurrentPayStance, EducationLevel, EmploymentType, PlatformKind, SalaryPeriod } from '@shared/types'
import { CURRENCIES } from './applicationFactsHelpers'
import { Block } from './ProfileEditor'
import { EDUCATION_LEVELS, EMPLOYMENT_TYPES, PAY_PERIODS, PLATFORMS, toggled, triParse, triValue } from './workFactsHelpers'
import { Chip, Field, Input, NumberInput, Select, TagInput } from './ui'

// Work arrangement, employment, schedule, screening, education and experience: the facts behind the
// questions about hours, shifts, checks and background. Not answered (null) stays apart from No.

interface FactsProps {
  facts: ApplicationFacts
  onChange: (next: ApplicationFacts) => void
}

/** A Yes, No or Not answered choice. Not answered makes the question wait for the person. */
export function TriState({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean | null; onChange: (v: boolean | null) => void }): React.JSX.Element {
  return (
    <Field label={label} hint={hint}>
      <Select value={triValue(value)} onChange={(e) => onChange(triParse(e.target.value))}>
        <option value="">Not answered</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </Select>
    </Field>
  )
}

/** Employment type chips. In the job filter, none selected means any type. */
export function EmploymentTypeChips({ value, onChange }: { value: EmploymentType[]; onChange: (v: EmploymentType[]) => void }): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {EMPLOYMENT_TYPES.map((t) => (
        <Chip key={t.id} selected={value.includes(t.id)} onClick={() => onChange(toggled(value, t.id))}>
          {t.label}
        </Chip>
      ))}
    </div>
  )
}

/** Where you can work and which cities you can reach every day. */
export function WorkArrangementBlock({ facts, onChange }: FactsProps): React.JSX.Element {
  const w = facts.workArrangement
  const set = (patch: Partial<ApplicationFacts['workArrangement']>): void => onChange({ ...facts, workArrangement: { ...w, ...patch } })
  return (
    <Block title="Work arrangement and commute" hint="Answers for forms that ask about remote, hybrid or on-site work. Not answered makes jobpls ask you on the form.">
      <div className="grid grid-cols-3 gap-3">
        <TriState label="Work remotely" value={w.remote} onChange={(v) => set({ remote: v })} />
        <TriState label="Work hybrid" value={w.hybrid} onChange={(v) => set({ hybrid: v })} />
        <TriState label="Work on site" value={w.onsite} onChange={(v) => set({ onsite: v })} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Most days a week in the office" hint="Enter 0 if you cannot go in. Empty means not answered.">
          <NumberInput value={w.maxOfficeDaysPerWeek} min={0} max={7} onChange={(v) => set({ maxOfficeDaysPerWeek: v })} />
        </Field>
      </div>
      <Field label="Cities you can commute to" hint={'Answers questions like "Can you commute to Austin?" The places you would move to are under Relocation and travel.'}>
        <TagInput value={w.commutableCities} onChange={(v) => set({ commutableCities: v })} placeholder="Add a city" />
      </Field>
    </Block>
  )
}

/** Types of work and hours per week. */
export function EmploymentBlock({ facts, onChange }: FactsProps): React.JSX.Element {
  const e = facts.employment
  const set = (patch: Partial<ApplicationFacts['employment']>): void => onChange({ ...facts, employment: { ...e, ...patch } })
  return (
    <Block title="Employment and hours" hint="Forms ask whether you want full time, contract and so on.">
      <Field label="Types of work you accept" hint="Select every type you accept. These answer form questions. The filter for which jobs jobpls shows you is in Settings.">
        <EmploymentTypeChips value={e.types} onChange={(v) => set({ types: v })} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Hours per week" hint="Empty means not answered.">
          <NumberInput value={e.hoursPerWeek} min={0} max={168} placeholder="40" onChange={(v) => set({ hoursPerWeek: v })} />
        </Field>
      </div>
    </Block>
  )
}

/** Current employment, the title you want and what to say about current pay. */
export function CurrentJobPayBlock({ facts, onChange, defaultCurrency = 'USD' }: FactsProps & { defaultCurrency?: string }): React.JSX.Element {
  const e = facts.employment
  const pay = e.currentPay
  const set = (patch: Partial<ApplicationFacts['employment']>): void => onChange({ ...facts, employment: { ...e, ...patch } })
  const setPay = (patch: Partial<ApplicationFacts['employment']['currentPay']>): void => set({ currentPay: { ...pay, ...patch } })
  return (
    <Block title="Current job and pay" hint="For questions about your current employer, the position you want and your current salary.">
      <div className="grid grid-cols-2 gap-3">
        <TriState label="Currently employed" value={e.currentlyEmployed} onChange={(v) => set({ currentlyEmployed: v })} />
        <Field label="Position you want" hint="Sent when a form asks for your desired position.">
          <Input value={e.desiredTitle} onChange={(ev) => set({ desiredTitle: ev.target.value })} placeholder="Gameplay Programmer" />
        </Field>
        <Field label="If a form asks your current pay" hint="Not answered makes jobpls ask you on the form.">
          <Select
            value={pay.stance}
            onChange={(ev) => {
              const stance = ev.target.value as CurrentPayStance
              setPay({ stance, currency: stance === 'amount' && !pay.currency ? defaultCurrency : pay.currency })
            }}
          >
            <option value="">Not answered</option>
            <option value="decline">Prefer not to say</option>
            <option value="amount">Give an amount</option>
          </Select>
        </Field>
      </div>
      {pay.stance === 'amount' && (
        <div className="grid grid-cols-[1fr_6rem_8rem] gap-3">
          <Field label="Current pay">
            <NumberInput value={pay.amount} min={0} step={1000} onChange={(v) => setPay({ amount: v })} />
          </Field>
          <Field label="Currency">
            <Select value={pay.currency} onChange={(ev) => setPay({ currency: ev.target.value })}>
              <option value="">Choose</option>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Period">
            <Select value={pay.period} onChange={(ev) => setPay({ period: ev.target.value as SalaryPeriod })}>
              {PAY_PERIODS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Block>
  )
}

/** Shifts, on-call work and time zones. */
export function ScheduleBlock({ facts, onChange }: FactsProps): React.JSX.Element {
  const s = facts.schedule
  const set = (patch: Partial<ApplicationFacts['schedule']>): void => onChange({ ...facts, schedule: { ...s, ...patch } })
  return (
    <Block title="Schedule" hint="Whether you can work outside the usual hours. Not answered makes jobpls ask you on the form.">
      <div className="grid grid-cols-3 gap-3">
        <TriState label="Evenings" value={s.evenings} onChange={(v) => set({ evenings: v })} />
        <TriState label="Weekends" value={s.weekends} onChange={(v) => set({ weekends: v })} />
        <TriState label="Nights" value={s.nights} onChange={(v) => set({ nights: v })} />
        <TriState label="On call" value={s.onCall} onChange={(v) => set({ onCall: v })} />
        <TriState label="Overtime or crunch" value={s.overtime} onChange={(v) => set({ overtime: v })} />
      </div>
      <Field label="Time zones you can work in" hint="For questions about overlap with a team's hours.">
        <TagInput value={s.timeZones} onChange={(v) => set({ timeZones: v })} placeholder="Pacific, UTC+1" />
      </Field>
    </Block>
  )
}

/** Willingness to go through a check. */
export function ScreeningBlock({ facts, onChange }: FactsProps): React.JSX.Element {
  const s = facts.screening
  const set = (patch: Partial<ApplicationFacts['screening']>): void => onChange({ ...facts, screening: { ...s, ...patch } })
  return (
    <Block title="Background screening" hint="Whether you agree to a check. These do not answer questions about your history.">
      <div className="grid grid-cols-3 gap-3">
        <TriState label="Background check" value={s.backgroundCheck} onChange={(v) => set({ backgroundCheck: v })} />
        <TriState label="Drug test" value={s.drugTest} onChange={(v) => set({ drugTest: v })} />
        <TriState label="Credit check" value={s.creditCheck} onChange={(v) => set({ creditCheck: v })} />
      </div>
    </Block>
  )
}

/** Employment, current pay, schedule and screening: the onboarding step "Work and availability", and part of the Applying tab. */
export function WorkAndAvailabilityEditor({ facts, onChange, defaultCurrency }: FactsProps & { defaultCurrency?: string }): React.JSX.Element {
  return (
    <div>
      <EmploymentBlock facts={facts} onChange={onChange} />
      <CurrentJobPayBlock facts={facts} onChange={onChange} defaultCurrency={defaultCurrency} />
      <ScheduleBlock facts={facts} onChange={onChange} />
      <ScreeningBlock facts={facts} onChange={onChange} />
    </div>
  )
}

/** Highest education, field of study and enrollment. */
export function EducationBlock({ facts, onChange }: FactsProps): React.JSX.Element {
  const e = facts.education
  const set = (patch: Partial<ApplicationFacts['education']>): void => onChange({ ...facts, education: { ...e, ...patch } })
  return (
    <Block title="Education details" hint={'Answers questions like "Do you have a bachelor\'s degree in computer science or a related field?"'}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Highest level completed">
          <Select value={e.highestCompleted ?? ''} onChange={(ev) => set({ highestCompleted: ev.target.value === '' ? null : (ev.target.value as EducationLevel) })}>
            <option value="">Not answered</option>
            {EDUCATION_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <TriState label="Currently enrolled" value={e.currentlyEnrolled} onChange={(v) => set({ currentlyEnrolled: v, expectedGraduation: v ? e.expectedGraduation : null })} />
        {e.currentlyEnrolled === true && (
          <Field label="Expected graduation">
            <Input type="month" value={e.expectedGraduation ?? ''} onChange={(ev) => set({ expectedGraduation: ev.target.value || null })} />
          </Field>
        )}
      </div>
      <Field label="Your fields of study" hint="For example Computer Science. Press Enter after each one.">
        <TagInput value={e.fields} onChange={(v) => set({ fields: v })} placeholder="Add a field" />
      </Field>
      <Field label="Related fields you would count" hint="A form that asks for a related field is answered Yes when it names one of these.">
        <TagInput value={e.relatedFields} onChange={(v) => set({ relatedFields: v })} placeholder="Add a field" />
      </Field>
    </Block>
  )
}

type CountKey = 'professionalSoftware' | 'gamesIndustry' | 'teamLead' | 'peopleManagement' | 'shippedTitles' | 'aaaTitles'

const EXPERIENCE_FIELDS: Array<{ key: CountKey; label: string; step: number }> = [
  { key: 'professionalSoftware', label: 'Years in professional software', step: 0.5 },
  { key: 'gamesIndustry', label: 'Years in the games industry', step: 0.5 },
  { key: 'teamLead', label: 'Years leading a team', step: 0.5 },
  { key: 'peopleManagement', label: 'Years managing people', step: 0.5 },
  { key: 'shippedTitles', label: 'Shipped titles', step: 1 },
  { key: 'aaaTitles', label: 'Shipped AAA titles', step: 1 }
]

/** Years per area, shipped titles and platforms. */
export function ExperienceBlock({ facts, onChange }: FactsProps): React.JSX.Element {
  const x = facts.experience
  const set = (patch: Partial<ApplicationFacts['experience']>): void => onChange({ ...facts, experience: { ...x, ...patch } })
  return (
    <Block title="Experience details" hint="Enter 0 when the answer is none. Empty means not answered, and jobpls asks you on the form.">
      <div className="grid grid-cols-3 gap-3">
        {EXPERIENCE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <NumberInput value={x[f.key]} min={0} max={60} step={f.step} onChange={(v) => set({ [f.key]: v })} />
          </Field>
        ))}
      </div>
      <Field label="Platforms you have shipped on">
        <div className="flex flex-wrap gap-1.5">
          {PLATFORMS.map((p) => (
            <Chip key={p.id} selected={x.platforms.includes(p.id)} onClick={() => set({ platforms: toggled<PlatformKind>(x.platforms, p.id) })}>
              {p.label}
            </Chip>
          ))}
        </div>
      </Field>
    </Block>
  )
}
