import { useEffect, useState } from 'react'
import type { Profile, ProfileRecord } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { useToast } from '@renderer/lib/toast'
import { relativeTime } from '@renderer/lib/format'
import { AnswerBank } from '@renderer/components/AnswerBank'
import { DocumentSection } from '@renderer/components/DocumentSection'
import { ProfileEditor, cleanProfile } from '@renderer/components/ProfileEditor'
import { VoiceCard } from '@renderer/components/VoiceCard'
import { Button, ErrorBlock, Loading, Page, PageHeader, Tabs } from '@renderer/components/ui'

type TabId = 'profile' | 'documents' | 'voice' | 'answers'

export function ProfilePage(): React.JSX.Element {
  const toast = useToast()
  const [tab, setTab] = useState<TabId>('profile')
  const rec = useAsync(() => api.getProfile(), [])
  const [draft, setDraft] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (rec.data) setDraft((cur) => cur ?? rec.data?.profile ?? null)
  }, [rec.data])

  const saved: ProfileRecord | null = rec.data
  const dirty = !!(draft && saved && JSON.stringify(cleanProfile(draft)) !== JSON.stringify(saved.profile))

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
          tab === 'profile' && (
            <>
              <span className="text-xs text-faint">{dirty ? 'Unsaved changes' : saved.updatedAt ? `Saved ${relativeTime(saved.updatedAt)}` : 'Not saved yet'}</span>
              <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
                Save profile
              </Button>
            </>
          )
        }
      />
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

      {tab === 'profile' && <ProfileEditor value={draft} onChange={setDraft} />}

      {tab === 'documents' && (
        <>
          <DocumentSection kind="resume" title="Resumes" hint="The primary resume is attached to applications." emptyText="No resume yet. Upload a PDF or Word file, then read it on the Profile tab to fill in your details." />
          <DocumentSection kind="cover_letter_sample" title="Sample cover letters" hint="Past letters you were happy with." emptyText="No sample letters. Add one so drafts match how you open and close." />
          <DocumentSection kind="writing_sample" title="Writing samples" hint="Emails, posts or notes in your own words." allowPaste emptyText="No writing samples. A few pages of your own writing is enough to learn your voice." />
          <DocumentSection kind="portfolio" title="Portfolio links" allowLink emptyText="No portfolio links yet." />
          <DocumentSection kind="other" title="Other documents" emptyText="Anything else you want available, such as a certificate." />
        </>
      )}

      {tab === 'voice' && <VoiceTab voice={draft.voice} onBuilt={(voice) => { setDraft({ ...draft, voice }); rec.reload() }} />}

      {tab === 'answers' && <AnswerBank />}
    </Page>
  )
}

/** Counts samples itself so the voice tab works without visiting Documents first. */
function VoiceTab({ voice, onBuilt }: { voice: Profile['voice']; onBuilt: (v: Profile['voice']) => void }): React.JSX.Element {
  const count = useAsync(async () => (await api.listDocuments('writing_sample')).length + (await api.listDocuments('cover_letter_sample')).length, [])
  return <VoiceCard voice={voice} sampleCount={count.data ?? 0} onBuilt={onBuilt} />
}
