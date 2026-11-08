import { useEffect, useRef, useState } from 'react'
import type { AnswerBankEntry } from '@shared/types'
import { api } from '@renderer/lib/api'
import { type AnswerSlot } from './answerSlots'
import { Card, Field, Textarea } from './ui'

export type SlotDrafts = Record<string, string>

/**
 * The saved answers behind a set of slots. Loads what the answer bank already holds for each topic, so
 * coming back to the step shows the earlier text, and saves the changes when the step is left.
 */
export function useSlotDrafts(slots: AnswerSlot[]): {
  drafts: SlotDrafts
  setDrafts: (next: SlotDrafts) => void
  save: () => Promise<void>
} {
  const [drafts, setDrafts] = useState<SlotDrafts>({})
  const existing = useRef<Record<string, AnswerBankEntry>>({})
  const first = useRef<SlotDrafts>({})

  useEffect(() => {
    let live = true
    void api.listAnswers().then((list) => {
      if (!live) return
      const loaded: SlotDrafts = {}
      for (const slot of slots) {
        const entry = list.find((e) => e.topic === slot.topic && e.kind === slot.kind)
        if (entry) {
          existing.current[slot.topic] = entry
          loaded[slot.topic] = entry.answer
        }
      }
      first.current = loaded
      setDrafts((cur) => ({ ...loaded, ...cur }))
    })
    return () => {
      live = false
    }
    // The slots are constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(): Promise<void> {
    for (const slot of slots) {
      const text = (drafts[slot.topic] ?? '').trim()
      const before = (first.current[slot.topic] ?? '').trim()
      const entry = existing.current[slot.topic]
      if (text === before) continue
      if (text === '') {
        if (entry) await api.deleteAnswer(entry.id)
        delete existing.current[slot.topic]
        first.current[slot.topic] = ''
        continue
      }
      const saved = await api.saveAnswer({ id: entry?.id, question: entry?.question ?? slot.question, answer: text, kind: slot.kind, topic: slot.topic, scope: null })
      existing.current[slot.topic] = saved
      first.current[slot.topic] = text
    }
  }

  return { drafts, setDrafts, save }
}

/** One text box per slot. */
export function AnswerSlots({ slots, drafts, onChange }: { slots: AnswerSlot[]; drafts: SlotDrafts; onChange: (next: SlotDrafts) => void }): React.JSX.Element {
  return (
    <Card className="space-y-4 p-4">
      {slots.map((slot) => (
        <Field key={slot.topic} label={slot.label} hint={slot.hint}>
          <Textarea rows={slot.rows} value={drafts[slot.topic] ?? ''} onChange={(e) => onChange({ ...drafts, [slot.topic]: e.target.value })} />
        </Field>
      ))}
    </Card>
  )
}
