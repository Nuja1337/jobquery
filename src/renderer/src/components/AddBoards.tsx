import { useState } from 'react'
import { Ban, Plus, Search } from 'lucide-react'
import type { AtsDetection } from '@shared/types'
import { api } from '@renderer/lib/api'
import { SOURCE_LABELS } from '@renderer/lib/format'
import { useToast } from '@renderer/lib/toast'
import { BoardImport } from '@renderer/components/BoardImport'
import { Button, Card, CardHeader, Field, Input } from '@renderer/components/ui'

/** Adds boards one careers address at a time, or many at once from a pasted list. */
export function AddBoards({ onAdded }: { onAdded: () => void }): React.JSX.Element {
  const toast = useToast()
  const [url, setUrl] = useState('')
  const [checking, setChecking] = useState(false)
  const [detected, setDetected] = useState<(AtsDetection & { url: string; name: string }) | null>(null)
  const [saving, setSaving] = useState(false)
  const [blockName, setBlockName] = useState('')

  async function check(): Promise<void> {
    setChecking(true)
    setDetected(null)
    try {
      const d = await api.detectAts(url.trim())
      if (!d) toast.error(new Error('That does not look like a web address.'))
      else setDetected({ ...d, url: url.trim(), name: d.companyName ?? '' })
    } catch (e) {
      toast.error(e)
    } finally {
      setChecking(false)
    }
  }

  async function saveDetected(): Promise<void> {
    if (!detected) return
    setSaving(true)
    try {
      await api.saveCompany({ name: detected.name.trim() || undefined, careersUrl: detected.url, ats: detected.ats, atsToken: detected.token ?? undefined, watch: true })
      toast.success(`Watching ${detected.name || 'the company'}.`)
      setDetected(null)
      setUrl('')
      onAdded()
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }

  async function block(): Promise<void> {
    try {
      await api.saveCompany({ name: blockName.trim(), blocked: true, watch: false })
      toast.success(`Blocked ${blockName.trim()}.`)
      setBlockName('')
      onAdded()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader title="Add boards" hint="Watched companies have their job boards checked on every run. Blocked ones are never shown." />
      <div className="space-y-4 p-4">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (url.trim()) void check()
          }}
        >
          <div className="flex items-end gap-2">
            <Field label="Careers page address" className="flex-1" hint="Paste a link to one company job board. Greenhouse, Lever, Ashby and others are recognized.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://boards.greenhouse.io/company" />
            </Field>
            <Button type="submit" loading={checking} disabled={!url.trim()} icon={<Search size={14} />} className="mb-[1.35rem]">
              Check
            </Button>
          </div>
          {detected && (
            <div className="rounded-lg border border-line bg-bg p-3">
              {detected.ats === 'unknown' ? (
                <p className="mb-3 text-sm text-warn">JobQuery could not recognize this job board. You can still save it, but it will not be checked automatically.</p>
              ) : (
                <p className="mb-3 text-sm text-good">
                  Recognized a {SOURCE_LABELS[detected.ats as keyof typeof SOURCE_LABELS] ?? detected.ats} job board{detected.token ? ` (${detected.token})` : ''}.
                </p>
              )}
              <div className="flex items-end gap-2">
                <Field label="Company name" className="flex-1">
                  <Input value={detected.name} onChange={(e) => setDetected({ ...detected, name: e.target.value })} />
                </Field>
                <Button variant="primary" loading={saving} disabled={!detected.name.trim()} onClick={() => void saveDetected()} icon={<Plus size={14} />}>
                  Watch this company
                </Button>
                <Button variant="ghost" onClick={() => setDetected(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </form>

        <div className="border-t border-line pt-4">
          <BoardImport onAdded={onAdded} />
        </div>

        <form
          className="flex items-center gap-2 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (blockName.trim()) void block()
          }}
        >
          <Input value={blockName} onChange={(e) => setBlockName(e.target.value)} placeholder="Block a company by name" aria-label="Company to block" className="max-w-xs" />
          <Button type="submit" icon={<Ban size={14} />} disabled={!blockName.trim()}>
            Block
          </Button>
        </form>
      </div>
    </Card>
  )
}
