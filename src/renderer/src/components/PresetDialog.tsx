import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { VOLUME_PRESET, applyPreset } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { useApp } from '@renderer/lib/app'
import { useToast } from '@renderer/lib/toast'
import { presetChanges } from './presetChanges'
import { Button, Modal, Notice } from './ui'

/** Shown before the volume preset is applied. Lists every value that changes, then asks for confirmation. */
export function PresetDialog({ current, onClose, onApplied }: { current: Settings; onClose: () => void; onApplied?: (next: Settings) => void }): React.JSX.Element {
  const { updateSettings } = useApp()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const changes = useMemo(() => presetChanges(current, VOLUME_PRESET), [current])

  async function confirm(): Promise<void> {
    setBusy(true)
    try {
      const next = await updateSettings(applyPreset(current, VOLUME_PRESET))
      if (next) {
        toast.success('Settings are set up for volume. Dry run is on.')
        onApplied?.(next)
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Set up for volume"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void confirm()}>
            Apply these settings
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-muted">
        <p>This sets JobPilot up to find, score, prepare and send hundreds of applications a day. Nothing changes until you confirm.</p>

        <Notice tone="warn" title="Auto-submit and dry run">
          <p>Auto-submit will be on, and so will dry run. In a dry run JobPilot fills each form and takes a screenshot, and never clicks Submit. It stays that way until you turn dry run off in Settings.</p>
        </Notice>

        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
          <div className="space-y-1">
            <p className="text-fg">Two consent options will be on.</p>
            <p>
              &ldquo;Tick required privacy and truthfulness boxes&rdquo; agrees to required boxes that only let the employer handle your application data or say your answers are true. It does not cover terms, waivers, arbitration, background checks or questions about AI use.
            </p>
            <p>&ldquo;Send my saved answers to questions only I answer&rdquo; lets autopilot send a form where a question about AI use, consent or legal terms was filled from an answer you wrote yourself.</p>
            <p>These apply once you turn dry run off.</p>
          </div>
        </div>

        <div>
          <p className="mb-1.5 font-medium text-fg">{changes.length === 0 ? 'Nothing else changes' : `${changes.length} ${changes.length === 1 ? 'setting changes' : 'settings change'}`}</p>
          {changes.length === 0 ? (
            <p>Your settings already match this preset.</p>
          ) : (
            <ul className="max-h-64 list-inside list-disc space-y-1 overflow-y-auto rounded-md border border-line bg-bg p-3">
              {changes.map((c) => (
                <li key={c.path}>{c.sentence}</li>
              ))}
            </ul>
          )}
        </div>

        <p>Your job titles, locations, resume, answers and providers stay as they are.</p>
      </div>
    </Modal>
  )
}
