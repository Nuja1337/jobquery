import {
  GENDER_LABELS,
  HOUSEHOLD_OCCUPATION_LABELS,
  MIN_BIRTH_YEAR,
  PRONOUNS_LABELS,
  RACE_LABELS,
  RELIGION_LABELS,
  SCHOOL_TYPE_LABELS,
  SEXUAL_ORIENTATION_LABELS,
  UK_ETHNICITY_LABELS,
  VETERAN_CATEGORY_LABELS,
  VETERAN_LABELS,
  YES_NO_DECLINE_LABELS
} from '@shared/eeo'
import type { EeoSettings } from '@shared/types'
import { toggled } from './workFactsHelpers'
import { Card, CardHeader, Chip, Field, Input, NumberInput, Select } from './ui'

// The self-identification answers behind the voluntary EEO questions on US forms. Every family starts
// on Decline. The ids saved here are mapped to each form's own option text when a form is filled.

type Patch = (patch: Partial<EeoSettings>) => void

/** The ids with Decline first, since it is the default. */
function declineFirst<T extends string>(labels: Record<T, string>): T[] {
  const all = Object.keys(labels) as T[]
  return [...all.filter((id) => id === 'decline'), ...all.filter((id) => id !== 'decline')]
}

function ChoiceSelect<T extends string>({ value, labels, onChange }: { value: T; labels: Record<T, string>; onChange: (v: T) => void }): React.JSX.Element {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as T)}>
      {declineFirst(labels).map((id) => (
        <option key={id} value={id}>
          {labels[id]}
        </option>
      ))}
    </Select>
  )
}

function ChipGroup<T extends string>({ value, labels, onChange }: { value: T[]; labels: Record<T, string>; onChange: (v: T[]) => void }): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.keys(labels) as T[]).map((id) => (
        <Chip key={id} selected={value.includes(id)} onClick={() => onChange(toggled(value, id))}>
          {labels[id]}
        </Chip>
      ))}
    </div>
  )
}

const YesNoField = ({ label, hint, value, onChange }: { label: string; hint?: string; value: EeoSettings['disability']; onChange: (v: EeoSettings['disability']) => void }): React.JSX.Element => (
  <Field label={label} hint={hint}>
    <ChoiceSelect value={value} labels={YES_NO_DECLINE_LABELS} onChange={onChange} />
  </Field>
)

/** The UK and EU questions. Collapsed by default, since most forms the owner meets are US forms. */
function UkEuSection({ eeo, onChange }: { eeo: EeoSettings; onChange: Patch }): React.JSX.Element {
  const social = eeo.socioeconomic
  const setSocial = (patch: Partial<EeoSettings['socioeconomic']>): void => onChange({ socioeconomic: { ...social, ...patch } })
  return (
    <details className="col-span-2 rounded-md border border-line">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-fg">UK and EU</summary>
      <div className="grid grid-cols-2 gap-4 border-t border-line p-3">
        <p className="col-span-2 text-xs text-muted">
          These answer the diversity questions on UK and EU forms. Age bands use the birth year below. Marital status and pregnancy questions always get the form&apos;s decline option.
        </p>
        <Field label="Ethnic group" hint="Uses the 2021 ONS groups. A form that asks for the group first gets the matching group." className="col-span-2">
          <ChoiceSelect value={eeo.ukEthnicity} labels={UK_ETHNICITY_LABELS} onChange={(v) => onChange({ ukEthnicity: v })} />
        </Field>
        <Field label="Religion or belief">
          <ChoiceSelect value={eeo.religion} labels={RELIGION_LABELS} onChange={(v) => onChange({ religion: v })} />
        </Field>
        <YesNoField label="Caring responsibilities" value={eeo.caring} onChange={(v) => onChange({ caring: v })} />
        <YesNoField label="Neurodivergent" hint="A question about one named condition is answered only when this is No." value={eeo.neurodivergent} onChange={(v) => onChange({ neurodivergent: v })} />
        <Field label="Main household earner's job at age 14">
          <ChoiceSelect value={social.householdOccupation} labels={HOUSEHOLD_OCCUPATION_LABELS} onChange={(v) => setSocial({ householdOccupation: v })} />
        </Field>
        <Field label="Type of school">
          <ChoiceSelect value={social.schoolType} labels={SCHOOL_TYPE_LABELS} onChange={(v) => setSocial({ schoolType: v })} />
        </Field>
        <YesNoField label="Free school meals" value={social.freeSchoolMeals} onChange={(v) => setSocial({ freeSchoolMeals: v })} />
        <YesNoField label="A parent has a degree" hint="Also answers first-generation questions." value={social.parentDegree} onChange={(v) => setSocial({ parentDegree: v })} />
      </div>
    </details>
  )
}

const thisYear = (): number => new Date().getFullYear()

export function DiversityCard({ eeo, onChange }: { eeo: EeoSettings; onChange: Patch }): React.JSX.Element {
  const yearBad = eeo.birthYear !== null && (eeo.birthYear < MIN_BIRTH_YEAR || eeo.birthYear > thisYear())
  return (
    <Card id="settings-eeo">
      <CardHeader title="Self-identification" hint="Voluntary questions on US, UK and EU forms. Every answer starts as Decline." />
      <p className="px-4 pt-3 text-xs text-muted">
        These answers go only into the matching self-identification questions on a form. They are never sent to the AI. Decline picks the form&apos;s own decline option.
      </p>
      <div className="grid grid-cols-2 gap-4 p-4">
        <Field label="Gender">
          <ChoiceSelect value={eeo.gender} labels={GENDER_LABELS} onChange={(v) => onChange({ gender: v })} />
          {eeo.gender === 'self_describe' && <Input className="mt-2" value={eeo.genderText} placeholder="In your own words" onChange={(e) => onChange({ genderText: e.target.value })} />}
        </Field>
        <Field label="Pronouns" hint="Used only when a form asks.">
          <ChoiceSelect value={eeo.pronouns} labels={PRONOUNS_LABELS} onChange={(v) => onChange({ pronouns: v })} />
          {eeo.pronouns === 'custom' && <Input className="mt-2" value={eeo.pronounsText} placeholder="xe/xem" onChange={(e) => onChange({ pronounsText: e.target.value })} />}
        </Field>
        <YesNoField label="Transgender" value={eeo.transgender} onChange={(v) => onChange({ transgender: v })} />
        <YesNoField label="Hispanic or Latino" value={eeo.hispanicLatino} onChange={(v) => onChange({ hispanicLatino: v })} />

        <Field label="Race or ethnicity" hint="Pick all that apply. Picking none declines." className="col-span-2">
          <ChipGroup value={eeo.race} labels={RACE_LABELS} onChange={(v) => onChange({ race: v })} />
        </Field>

        <Field label="Veteran status">
          <ChoiceSelect value={eeo.veteran} labels={VETERAN_LABELS} onChange={(v) => onChange({ veteran: v })} />
        </Field>
        <YesNoField label="Served in the military" value={eeo.militaryService} onChange={(v) => onChange({ militaryService: v })} />
        {eeo.veteran === 'protected' && (
          <Field label="Protected veteran categories" hint="Pick all that apply." className="col-span-2">
            <ChipGroup value={eeo.veteranCategories} labels={VETERAN_CATEGORY_LABELS} onChange={(v) => onChange({ veteranCategories: v })} />
          </Field>
        )}
        <YesNoField label="Military spouse" value={eeo.militarySpouse} onChange={(v) => onChange({ militarySpouse: v })} />
        <YesNoField label="Disability" value={eeo.disability} onChange={(v) => onChange({ disability: v })} />

        <Field label="Sexual orientation" hint="Pick all that apply. Picking none declines." className="col-span-2">
          <ChipGroup value={eeo.sexualOrientation} labels={SEXUAL_ORIENTATION_LABELS} onChange={(v) => onChange({ sexualOrientation: v })} />
          {eeo.sexualOrientation.includes('self_describe') && (
            <Input className="mt-2" value={eeo.sexualOrientationText} placeholder="In your own words" onChange={(e) => onChange({ sexualOrientationText: e.target.value })} />
          )}
        </Field>
        <YesNoField label="LGBTQ+" value={eeo.lgbtq} onChange={(v) => onChange({ lgbtq: v })} />

        <Field
          label="Birth year (optional)"
          hint={yearBad ? `Enter a year from ${MIN_BIRTH_YEAR} to ${thisYear()}, or leave this empty.` : 'Leaving it empty declines age questions.'}
        >
          <NumberInput value={eeo.birthYear} min={MIN_BIRTH_YEAR} max={thisYear()} placeholder="1990" onChange={(v) => onChange({ birthYear: v })} />
        </Field>

        <UkEuSection eeo={eeo} onChange={onChange} />
      </div>
    </Card>
  )
}
