import { useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router'
import { Wand2 } from 'lucide-react'
import type { Profile, ProfileRecord } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { relativeTime } from '@renderer/lib/format'
import { AnswerBank } from '@renderer/components/AnswerBank'
import { DocumentSection } from '@renderer/components/DocumentSection'
import { ProfileEditor, cleanProfile } from '@renderer/components/ProfileEditor'
import { VoiceCard } from '@renderer/components/VoiceCard'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { Button, Card, ErrorBlock, Loading, Page, PageHeader, Tabs } from '@renderer/components/ui'

type TabId = 'profile' | 'documents' | 'voice' | 'answers'

export function ProfilePage(): React.JSX.Element {
  const toast = useToast()
  const [tab, setTab] = useState<TabId>('profile')
  const rec = useAsync(() => api.getProfile(), [])
  const [draft, setDraft] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
  const [confirmRead, setConfirmRead] = useState(false)
  const resumes = useAsync(() => api.listDocuments('resume'), [tab])
  const resumeId = (resumes.data?.find((d) => d.isPrimary) ?? resumes.data?.[0])?.id ?? null

  useEffect(() => {
    if (rec.data) setDraft((cur) => cur ?? rec.data?.profile ?? null)
  }, [rec.data])

  const saved: ProfileRecord | null = rec.data
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

  async function readResume(): Promise<void> {
    if (!resumeId) return
    setReading(true)
    try {
      const read = await api.extractProfileFromResume(resumeId)
      setDraft(read)
      toast.success('Read your resume. Check the draft, then press Save profile.')
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
        intro="What JobPilot knows about you and writes from."
        actions={
          tab === 'profile' && <span className="text-xs text-faint">{saved.updatedAt ? `Saved ${relativeTime(saved.updatedAt)}` : 'Not saved yet'}</span>
        }
      />

      {tab === 'profile' && dirty && (
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
                {resumeId ? 'Uses your Reading model and replaces the fields below with a draft. Nothing is saved until you press Save profile.' : 'Upload a resume on the Documents tab first.'}
              </p>
            </div>
            <Button icon={<Wand2 size={14} />} loading={reading} disabled={!resumeId} onClick={() => (draft.fullName.trim() ? setConfirmRead(true) : void readResume())}>
              Read my resume
            </Button>
          </Card>
          <ProfileEditor value={draft} onChange={setDraft} />
        </>
      )}

      {tab === 'documents' && (
        <>
          <DocumentSection kind="resume" title="Resumes" hint="The primary resume is attached to applications." emptyText="No resume yet. Upload a PDF or Word file, then press Read my resume on the Profile tab to fill in your details." />
          <DocumentSection kind="cover_letter_sample" title="Sample cover letters" hint="Past letters you were happy with." emptyText="No sample letters. Add one so drafts match how you open and close." />
          <DocumentSection kind="writing_sample" title="Writing samples" hint="Emails, posts or notes in your own words." allowPaste emptyText="No writing samples. A few pages of your own writing is enough to learn your voice." />
          <DocumentSection kind="portfolio" title="Portfolio links" allowLink emptyText="No portfolio links yet." />
          <DocumentSection kind="other" title="Other documents" emptyText="Anything else you want available, such as a certificate." />
        </>
      )}

      {tab === 'voice' && <VoiceTab voice={draft.voice} onBuilt={(voice) => { setDraft({ ...draft, voice }); rec.reload() }} />}

      {tab === 'answers' && <AnswerBank />}

      {confirmRead && (
        <ConfirmDialog
          title="Replace the profile fields?"
          message="The fields on this page will be replaced with a draft read from your resume, including anything you have not saved. Nothing is saved until you press Save profile."
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
