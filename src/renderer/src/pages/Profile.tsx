import { useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router'
import { Wand2 } from 'lucide-react'
import type { Profile, ProfileRecord } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { relativeTime } from '@renderer/lib/format'
import { AnswerBank } from '@renderer/components/AnswerBank'
import { ApplicationFactsEditor } from '@renderer/components/ApplicationFactsEditor'
import { DocumentSection } from '@renderer/components/DocumentSection'
import { ProfileEditor, cleanProfile } from '@renderer/components/ProfileEditor'
import { VoiceCard } from '@renderer/components/VoiceCard'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { Button, Card, ErrorBlock, Loading, Page, PageHeader, Tabs } from '@renderer/components/ui'

type TabId = 'profile' | 'applying' | 'documents' | 'voice' | 'answers'

export function ProfilePage(): React.JSX.Element {
  const toast = useToast()
  const { settings } = useApp()
  const [tab, setTab] = useState<TabId>('profile')
  const rec = useAsync(() => api.getProfile(), [])
  const [draft, setDraft] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
  const [confirmRead, setConfirmRead] = useState(false)
  const resumes = useAsync(() => api.listDocuments('resume'), [tab])
  const resume = resumes.data?.find((d) => d.isPrimary) ?? resumes.data?.[0] ?? null
  const resumeId = resume?.id ?? null
  const resumeName = resume?.name ?? 'your resume'

  useEffect(() => {
    if (rec.data) setDraft((cur) => cur ?? rec.data?.profile ?? null)
  }, [rec.data])

  const saved: ProfileRecord | null = rec.data
  const savedRef = useRef(saved)
  savedRef.current = saved
  const dirty = !!(draft && saved && JSON.stringify(cleanProfile(draft)) !== JSON.stringify(saved.profile))
  const leaving = useRef(false)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)

  async function save(): Promise<void> {
    if (!draft) return
    setSaving(true)
    try {
      const next = await api.saveProfile(cleanProfile(draft))
      rec.setData(next)
      setDraft(next.profile)
      toast.success('Profile saved.')
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }

  /** Adding a portfolio link may have filled the profile's empty portfolio field. Take that in without losing unsaved edits. */
  async function pullPortfolio(): Promise<void> {
    try {
      const next = await api.getProfile()
      const portfolio = next.profile.links.portfolio
      if (!portfolio || portfolio === savedRef.current?.profile.links.portfolio) return
      rec.setData(next)
      setDraft((cur) => (cur && !cur.links.portfolio.trim() ? { ...cur, links: { ...cur.links, portfolio } } : cur))
    } catch {
      // The profile tab loads it again when it is opened.
    }
  }

  async function readResume(): Promise<void> {
    if (!resumeId) return
    setReading(true)
    try {
      const read = await api.extractProfileFromResume(resumeId)
      setDraft(read)
      toast.success(`Read ${resumeName}. Check the draft, then press Save profile.`)
    } catch (e) {
      toast.error(e)
    } finally {
      setReading(false)
    }
  }

  if (rec.error) {
    return (
      <Page narrow>
        <PageHeader title="Profile and materials" />
        <ErrorBlock message={rec.error} onRetry={rec.reload} />
      </Page>
    )
  }
  if (!draft || !saved) {
    return (
      <Page narrow>
        <PageHeader title="Profile and materials" />
        <Loading />
      </Page>
    )
  }

  return (
    <Page narrow>
      <PageHeader
        title="Profile and materials"
        intro="What JobQuery knows about you and writes from."
        actions={
          (tab === 'profile' || tab === 'applying') && <span className="text-xs text-faint">{saved.updatedAt ? `Saved ${relativeTime(saved.updatedAt)}` : 'Not saved yet'}</span>
        }
      />

      {(tab === 'profile' || tab === 'applying') && dirty && (
        <div className="sticky top-0 z-20 -mx-2 mb-4 flex items-center justify-between rounded-lg border border-accent/50 bg-surface px-4 py-2.5 shadow-lg">
          <p className="text-sm text-fg">You have unsaved changes.</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setDraft(saved.profile)}>
              Discard
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save profile
            </Button>
          </div>
        </div>
      )}

      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="Leave without saving?"
          message="Your changes on this page aren't saved. If you leave now, they're lost."
          confirmLabel="Leave without saving"
          danger
          onClose={() => {
            if (!leaving.current) blocker.reset?.()
          }}
          onConfirm={() => {
            leaving.current = true
            blocker.proceed?.()
          }}
        />
      )}
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { id: 'profile', label: 'Profile' },
            { id: 'applying', label: 'Applying' },
            { id: 'documents', label: 'Documents' },
            { id: 'voice', label: 'Voice' },
            { id: 'answers', label: 'Answer bank' }
          ]}
        />
      </div>

      {tab === 'profile' && (
        <>
          <Card className="mb-4 flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">Fill this in from your resume</p>
              <p className="text-xs text-faint">
                {resumeId ? `Reads ${resumeName} with your Reading model and replaces the fields below with a draft. Nothing is saved until you press Save profile.` : 'Upload a resume on the Documents tab first.'}
              </p>
            </div>
            <Button icon={<Wand2 size={14} />} loading={reading} disabled={!resumeId} onClick={() => (draft.fullName.trim() ? setConfirmRead(true) : void readResume())}>
              Read my resume
            </Button>
          </Card>
          <ProfileEditor value={draft} onChange={setDraft} />
        </>
      )}

      {tab === 'applying' && (
        <>
          <Card className="mb-4 p-4">
            <p className="text-sm font-medium text-fg">Answers for application forms</p>
            <p className="text-xs text-faint">Forms ask for these again and again. JobQuery answers from here, and a form waits for you only when a fact is missing.</p>
          </Card>
          <ApplicationFactsEditor profile={draft} onChange={setDraft} defaultCurrency={settings?.preferences.salaryCurrency} />
        </>
      )}

      {tab === 'documents' && (
        <>
          <DocumentSection kind="resume" title="Resumes" hint="The primary resume is attached to applications." emptyText="No resume yet. Upload a PDF or Word file, then press Read my resume on the Profile tab to fill in your details." />
          <DocumentSection kind="cover_letter_sample" title="Sample cover letters" hint="Past letters you were happy with." emptyText="No sample letters. Add one so drafts match how you open and close." />
          <DocumentSection kind="writing_sample" title="Writing samples" hint="Emails, posts or notes in your own words." allowPaste emptyText="No writing samples. A few pages of your own writing is enough to learn your voice." />
          <DocumentSection kind="portfolio" title="Portfolio links" hint="The first link also fills the portfolio field in your profile when that field is empty." allowLink emptyText="No portfolio links yet." onChange={() => void pullPortfolio()} />
          <DocumentSection kind="other" title="Other documents" emptyText="Anything else you want available, such as a certificate." />
        </>
      )}

      {tab === 'voice' && <VoiceTab voice={draft.voice} onBuilt={(voice) => { setDraft({ ...draft, voice }); rec.reload() }} />}

      {tab === 'answers' && <AnswerBank />}

      {confirmRead && (
        <ConfirmDialog
          title="Replace the profile fields?"
          message={`The fields on this page will be replaced with a draft read from ${resumeName}, including anything you have not saved. Nothing is saved until you press Save profile.`}
          confirmLabel="Read my resume"
          onClose={() => setConfirmRead(false)}
          onConfirm={readResume}
        />
      )}
    </Page>
  )
}

/** Counts samples itself so the voice tab works without visiting Documents first. */
function VoiceTab({ voice, onBuilt }: { voice: Profile['voice']; onBuilt: (v: Profile['voice']) => void }): React.JSX.Element {
  const count = useAsync(async () => (await api.listDocuments('writing_sample')).length + (await api.listDocuments('cover_letter_sample')).length, [])
  return <VoiceCard voice={voice} sampleCount={count.data ?? 0} onBuilt={onBuilt} />
}
