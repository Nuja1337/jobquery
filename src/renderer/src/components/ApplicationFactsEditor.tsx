import { useId, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ApplicationFacts, AuthorizationStatus, LanguageLevel, Profile, SalaryAnswerStyle, SalaryPeriod, TravelWillingness } from '@shared/types'
import { CLEARANCES, COUNTRIES, CURRENCIES, LANGUAGE_LEVELS, languageRows, skillRows, withLanguageLevel, withSkillYears } from './applicationFactsHelpers'
import { Block } from './ProfileEditor'
import { Button, Checkbox, Field, IconButton, Input, NumberInput, Select, TagInput, Textarea } from './ui'

// The interview: what application forms ask again and again, collected once.

interface FactsProps {
  facts: ApplicationFacts
  onChange: (next: ApplicationFacts) => void
}

const STATUS: Array<{ id: AuthorizationStatus; label: string }> = [
  { id: 'citizen', label: 'Citizen' },
  { id: 'permanent_resident', label: 'Permanent resident' },
  { id: 'visa', label: 'Work visa' },
  { id: 'none', label: 'No right to work' }
]

const PERIODS: Array<{ id: SalaryPeriod; label: string }> = [
  { id: 'year', label: 'Per year' },
  { id: 'month', label: 'Per month' },
  { id: 'hour', label: 'Per hour' }
]

const STYLES: Array<{ id: SalaryAnswerStyle; label: string }> = [
  { id: 'number', label: 'One number' },
  { id: 'range', label: 'A range' },
  { id: 'negotiable', label: 'Negotiable' }
]

const TRAVEL: Array<{ id: TravelWillingness; label: string }> = [
  { id: 'none', label: 'No travel' },
  { id: 'some', label: 'Some, up to 25 percent' },
  { id: 'frequent', label: 'Frequent, up to 75 percent' }
]

const triValue = (v: boolean | null): string => (v === null ? '' : v ? 'yes' : 'no')
const triParse = (s: string): boolean | null => (s === '' ? null : s === 'yes')

function TriState({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean | null; onChange: (v: boolean | null) => void }): React.JSX.Element {
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

/** The first step: where you live, where you may work, what you expect and when you can start. */
export function ApplyingEditor({
  facts,
  onChange,
  defaultCurrency = 'USD',
  authorizedCountries = []
}: FactsProps & { defaultCurrency?: string; authorizedCountries?: string[] }): React.JSX.Element {
  const listId = useId()
  const set = <K extends keyof ApplicationFacts>(key: K, v: ApplicationFacts[K]): void => onChange({ ...facts, [key]: v })
  const setAddress = (patch: Partial<ApplicationFacts['address']>): void => set('address', { ...facts.address, ...patch })
  const replace = <T,>(list: T[], i: number, next: T): T[] => list.map((x, j) => (j === i ? next : x))
  const known = new Set(facts.authorization.map((a) => a.country.trim().toLowerCase()))
  const suggestions = authorizedCountries.filter((c) => c.trim() && !known.has(c.trim().toLowerCase()))

  return (
    <div>
      <datalist id={listId}>
        {COUNTRIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <Block title="Address" hint="Used for street, city, region, postal code and phone code fields.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Street address" className="col-span-2">
            <Input value={facts.address.street} onChange={(e) => setAddress({ street: e.target.value })} />
          </Field>
          <Field label="City">
            <Input value={facts.address.city} onChange={(e) => setAddress({ city: e.target.value })} />
          </Field>
          <Field label="State or region">
            <Input value={facts.address.region} onChange={(e) => setAddress({ region: e.target.value })} />
          </Field>
          <Field label="Postal code">
            <Input value={facts.address.postalCode} onChange={(e) => setAddress({ postalCode: e.target.value })} />
          </Field>
          <Field label="Country">
            <Input list={listId} value={facts.address.country} onChange={(e) => setAddress({ country: e.target.value })} />
          </Field>
          <Field label="Phone country code" hint="For example +1 or +49.">
            <Input value={facts.phoneCountryCode} onChange={(e) => set('phoneCountryCode', e.target.value)} placeholder="+1" />
          </Field>
        </div>
      </Block>

      <Block
        title="Work authorization by country"
        hint="Forms ask whether you may work in a country and whether you need sponsorship. Check each row."
        actions={
          <Button
            size="sm"
            icon={<Plus size={13} />}
            onClick={() => set('authorization', [...facts.authorization, { country: '', status: facts.authorization.length === 0 ? 'citizen' : 'visa', needsSponsorship: false, notes: '' }])}
          >
            Add country
          </Button>
        }
      >
        {facts.authorization.length === 0 && <p className="text-sm text-muted">No countries yet. Add each country you apply in.</p>}
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            From your profile
            {suggestions.map((c) => (
              <Button key={c} size="sm" onClick={() => set('authorization', [...facts.authorization, { country: c, status: 'citizen', needsSponsorship: false, notes: '' }])}>
                Add {c}
              </Button>
            ))}
          </div>
        )}
        {facts.authorization.map((a, i) => (
          <div key={i} className="grid grid-cols-[1.2fr_1fr_auto_1.2fr_auto] items-end gap-2">
            <Field label={i === 0 ? 'Country' : undefined}>
              <Input list={listId} value={a.country} onChange={(e) => set('authorization', replace(facts.authorization, i, { ...a, country: e.target.value }))} aria-label="Country" />
            </Field>
            <Field label={i === 0 ? 'Status' : undefined}>
              <Select
                value={a.status}
                aria-label="Status"
                onChange={(e) => {
                  const status = e.target.value as AuthorizationStatus
                  set('authorization', replace(facts.authorization, i, { ...a, status, needsSponsorship: status === 'none' ? true : status === 'visa' ? a.needsSponsorship : false }))
                }}
              >
                {STATUS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="pb-1.5">
              <Checkbox
                label="Needs sponsorship"
                checked={a.status === 'none' || (a.status === 'visa' && a.needsSponsorship)}
                disabled={a.status !== 'visa'}
                onChange={(v) => set('authorization', replace(facts.authorization, i, { ...a, needsSponsorship: v }))}
              />
            </div>
            <Field label={i === 0 ? 'Notes' : undefined}>
              <Input value={a.notes} onChange={(e) => set('authorization', replace(facts.authorization, i, { ...a, notes: e.target.value }))} aria-label="Notes" />
            </Field>
            <IconButton label="Remove country" onClick={() => set('authorization', facts.authorization.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </Block>

      <Block
        title="Salary expectations"
        hint="Add a row for each currency. jobpls uses the row that matches the job's currency or country."
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => set('salary', [...facts.salary, { currency: facts.salary.length === 0 ? defaultCurrency : '', min: null, target: null, period: 'year', answerStyle: 'range' }])}>
            Add currency
          </Button>
        }
      >
        {facts.salary.length === 0 && <p className="text-sm text-muted">No salary yet. Forms that ask for it will wait for you.</p>}
        {facts.salary.map((s, i) => (
          <div key={i} className="grid grid-cols-[5.5rem_1fr_1fr_7rem_8.5rem_auto] items-end gap-2">
            <Field label={i === 0 ? 'Currency' : undefined}>
              <Select value={s.currency} aria-label="Currency" onChange={(e) => set('salary', replace(facts.salary, i, { ...s, currency: e.target.value }))}>
                <option value="">Choose</option>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <Field label={i === 0 ? 'Minimum' : undefined}>
              <NumberInput value={s.min} min={0} step={1000} onChange={(v) => set('salary', replace(facts.salary, i, { ...s, min: v }))} />
            </Field>
            <Field label={i === 0 ? 'Target' : undefined}>
              <NumberInput value={s.target} min={0} step={1000} onChange={(v) => set('salary', replace(facts.salary, i, { ...s, target: v }))} />
            </Field>
            <Field label={i === 0 ? 'Period' : undefined}>
              <Select value={s.period} aria-label="Period" onChange={(e) => set('salary', replace(facts.salary, i, { ...s, period: e.target.value as SalaryPeriod }))}>
                {PERIODS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={i === 0 ? 'How to answer' : undefined}>
              <Select value={s.answerStyle} aria-label="How to answer" onChange={(e) => set('salary', replace(facts.salary, i, { ...s, answerStyle: e.target.value as SalaryAnswerStyle }))}>
                {STYLES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <IconButton label="Remove currency" onClick={() => set('salary', facts.salary.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </Block>

      <Block title="Notice period and start date" hint="Used for notice period and earliest start date questions.">
        <div className="grid grid-cols-2 items-end gap-3">
          <Field label="Notice period in weeks" hint="Enter 0 if you can start right away.">
            <NumberInput value={facts.noticeWeeks} min={0} max={52} onChange={(v) => set('noticeWeeks', v)} />
          </Field>
          <div className="space-y-2">
            <Checkbox label="I can start as soon as my notice ends" checked={facts.earliestStart === null} onChange={(v) => set('earliestStart', v ? null : new Date().toISOString().slice(0, 10))} />
            {facts.earliestStart !== null && (
              <Field label="Earliest start date">
                <Input type="date" value={facts.earliestStart} onChange={(e) => set('earliestStart', e.target.value || null)} />
              </Field>
            )}
          </div>
        </div>
      </Block>

      <Block title="Relocation and travel">
        <div className="grid grid-cols-2 gap-3">
          <TriState label="Willing to relocate" value={facts.relocation.willing} onChange={(v) => set('relocation', { ...facts.relocation, willing: v })} />
          <Field label="Willing to travel">
            <Select value={facts.travel ?? ''} onChange={(e) => set('travel', e.target.value === '' ? null : (e.target.value as TravelWillingness))}>
              <option value="">Not answered</option>
              {TRAVEL.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {facts.relocation.willing && (
          <Field label="Places you would move to" hint="Leave empty for anywhere. A question about a place that is not here waits for you.">
            <TagInput value={facts.relocation.places} onChange={(v) => set('relocation', { ...facts.relocation, places: v })} placeholder="Add a city or country" />
          </Field>
        )}
      </Block>
    </div>
  )
}

function AddName({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (name: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const add = (): void => {
    if (!name.trim()) return
    onAdd(name.trim())
    setName('')
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        className="max-w-60"
        value={name}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
      />
      <Button size="sm" icon={<Plus size={13} />} disabled={!name.trim()} onClick={add}>
        {label}
      </Button>
    </div>
  )
}

/** The second step: years per skill, language levels and the other questions forms repeat. */
export function QuestionFormsEditor({ facts, onChange, skills, languages }: FactsProps & { skills: string[]; languages: string[] }): React.JSX.Element {
  const set = <K extends keyof ApplicationFacts>(key: K, v: ApplicationFacts[K]): void => onChange({ ...facts, [key]: v })
  // Names added by hand get a row but no value until the person enters one.
  const [extraSkills, setExtraSkills] = useState<string[]>([])
  const [extraLanguages, setExtraLanguages] = useState<string[]>([])
  const rows = (base: string[], extra: string[]): string[] => [...base, ...extra.filter((e) => !base.some((b) => b.toLowerCase() === e.toLowerCase()))]
  const skillList = rows(skillRows(skills, facts.skillYears), extraSkills)
  const languageList = rows(languageRows(languages, facts.languageLevels), extraLanguages)
  const clearanceChoice = facts.clearance === '' ? '' : CLEARANCES.includes(facts.clearance) ? facts.clearance : 'other'

  return (
    <div>
      <Block title="Years of experience by skill" hint="Forms ask how many years you have used a tool. A skill left empty waits for you each time.">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {skillList.map((skill) => (
            <div key={skill} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-fg">{skill}</span>
              <NumberInput className="w-24" value={facts.skillYears[skill] ?? null} min={0} max={60} step={0.5} placeholder="Years" onChange={(v) => set('skillYears', withSkillYears(facts.skillYears, skill, v))} />
            </div>
          ))}
        </div>
        <AddName label="Add skill" placeholder="Another skill" onAdd={(name) => setExtraSkills([...extraSkills, name])} />
      </Block>

      <Block title="Language levels" hint="Forms ask how well you speak a language.">
        {languageList.length === 0 && <p className="text-sm text-muted">Add languages to your profile, or add one here.</p>}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {languageList.map((language) => (
            <div key={language} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-fg">{language}</span>
              <Select
                className="w-40"
                aria-label={`${language} level`}
                value={Object.entries(facts.languageLevels).find(([k]) => k.toLowerCase() === language.toLowerCase())?.[1] ?? ''}
                onChange={(e) => set('languageLevels', withLanguageLevel(facts.languageLevels, language, e.target.value === '' ? null : (e.target.value as LanguageLevel)))}
              >
                <option value="">Not answered</option>
                {LANGUAGE_LEVELS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
        <AddName label="Add language" placeholder="Another language" onAdd={(name) => setExtraLanguages([...extraLanguages, name])} />
      </Block>

      <Block title="Other questions forms ask">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Security clearance" hint="Choose None if you hold no clearance.">
            <Select
              value={clearanceChoice}
              onChange={(e) => set('clearance', e.target.value === 'other' ? 'Other' : e.target.value)}
            >
              <option value="">Not answered</option>
              {CLEARANCES.map((c) => (
                <option key={c}>{c}</option>
              ))}
              <option value="other">Other</option>
            </Select>
          </Field>
          {clearanceChoice === 'other' && (
            <Field label="Clearance name">
              <Input value={facts.clearance === 'Other' ? '' : facts.clearance} onChange={(e) => set('clearance', e.target.value.trim() === '' ? 'Other' : e.target.value)} />
            </Field>
          )}
          <TriState label="Driver's license" value={facts.driversLicense} onChange={(v) => set('driversLicense', v)} />
          <TriState label="Over 18" value={facts.over18} onChange={(v) => set('over18', v)} />
          <Field label="GPA" hint="Leave empty if you would rather not say.">
            <Input value={facts.gpa} onChange={(e) => set('gpa', e.target.value)} placeholder="3.7" />
          </Field>
          <Field label="How you hear about jobs" hint="Used when a form asks how you found the job and the source gives no answer.">
            <Input value={facts.heardAbout} onChange={(e) => set('heardAbout', e.target.value)} placeholder="Job board" />
          </Field>
        </div>
        <Field label="References" hint="Sent when a form asks for references in a text box.">
          <Textarea rows={2} value={facts.references} onChange={(e) => set('references', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <TriState
            label="Family or friends at employers"
            hint="Choose No if no relative, friend or partner of yours works at the companies you apply to, and forms that ask are answered No."
            value={facts.relativesAtEmployers ?? null}
            onChange={(v) => set('relativesAtEmployers', v)}
          />
          <Field label="Referrals" hint="Choose this if you apply without a referral, and forms that ask who referred you are answered for you.">
            <Select value={facts.referrals ?? ''} onChange={(e) => set('referrals', e.target.value === 'none' ? 'none' : '')}>
              <option value="">Not answered</option>
              <option value="none">I apply without a referral</option>
            </Select>
          </Field>
        </div>
      </Block>
    </div>
  )
}

/** Both sections together, for the Applying tab on the Profile page. */
export function ApplicationFactsEditor({ profile, onChange, defaultCurrency }: { profile: Profile; onChange: (next: Profile) => void; defaultCurrency?: string }): React.JSX.Element {
  const setFacts = (application: ApplicationFacts): void => onChange({ ...profile, application })
  return (
    <div>
      <ApplyingEditor facts={profile.application} onChange={setFacts} defaultCurrency={defaultCurrency} authorizedCountries={profile.workAuthorization.authorizedCountries} />
      <QuestionFormsEditor facts={profile.application} onChange={setFacts} skills={profile.skills} languages={profile.languages} />
    </div>
  )
}
