import { useState } from 'react'
import { Mic } from 'lucide-react'
import type { VoiceProfile } from '@shared/types'
import { api } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { formatDate } from '@renderer/lib/format'
import { Button, Card, CardHeader, Chip } from './ui'

interface Props {
  voice: VoiceProfile | null
  /** Number of writing samples and sample cover letters on file. */
  sampleCount: number
  onBuilt: (voice: VoiceProfile | null) => void
}

export function VoiceCard({ voice, sampleCount, onBuilt }: Props): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function build(): Promise<void> {
    setBusy(true)
    try {
      const rec = await api.buildVoiceProfile()
      onBuilt(rec.profile.voice)
      toast.success('Built your voice profile.')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader
        title="Voice profile"
        hint="How you write, so drafts sound like you."
        actions={
          <Button size="sm" variant="primary" icon={<Mic size={13} />} loading={busy} disabled={sampleCount === 0} onClick={() => void build()}>
            {voice ? 'Rebuild from my samples' : 'Build from my samples'}
          </Button>
        }
      />
      <div className="p-4">
        {!voice ? (
          <p className="text-sm text-muted">{sampleCount === 0 ? 'Add a few writing samples or a past cover letter first. Then JobPilot can study how you write.' : 'No voice profile yet. Build one from your samples.'}</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-fg">{voice.summary}</p>
            <dl className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-xs text-muted">Tone</dt>
                <dd className="capitalize text-fg">{voice.formality}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Average sentence</dt>
                <dd className="text-fg">{voice.avgSentenceWords} words</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Built</dt>
                <dd className="text-fg">
                  {formatDate(voice.builtAt)} from {voice.builtFrom.length} {voice.builtFrom.length === 1 ? 'sample' : 'samples'}
                </dd>
              </div>
            </dl>
            <ChipRow label="Traits" items={voice.traits} />
            <ChipRow label="Phrases you use" items={voice.signaturePhrases} />
            <ChipRow label="Would sound wrong from you" items={voice.avoid} />
          </div>
        )}
      </div>
    </Card>
  )
}

function ChipRow({ label, items }: { label: string; items: string[] }): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div>
      <p className="mb-1.5 text-xs text-muted">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <Chip key={i}>{i}</Chip>
        ))}
      </div>
    </div>
  )
}
