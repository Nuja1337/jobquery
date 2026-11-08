import { useState } from 'react'
import { Rocket } from 'lucide-react'
import type { BoardAddCounts } from '@shared/api'
import { api } from '@renderer/lib/api'
import { plural } from '@renderer/lib/format'
import { useToast } from '@renderer/lib/toast'
import { Button, Card, CardHeader } from '@renderer/components/ui'
import { starterPack, type StarterBoard } from '../../../main/sources/starterPack'

type Group = 'games' | 'tech' | 'all'

const PACKS: Record<Group, StarterBoard[]> = { games: starterPack('games'), tech: starterPack('tech'), all: starterPack() }

const LABELS: Record<Group, string> = {
  games: `Add ${PACKS.games.length} game studios`,
  tech: `Add ${PACKS.tech.length} tech companies`,
  all: `Add all ${PACKS.all.length}`
}

/** The first eight names, so the person can see what the button adds. */
function hint(group: Group): string {
  const boards = PACKS[group]
  const shown = boards.slice(0, 8).map((b) => b.name)
  const more = boards.length - shown.length
  return more > 0 ? `${shown.join(', ')}, and ${more} more.` : `${shown.join(', ')}.`
}

export function addedMessage(counts: BoardAddCounts): string {
  if (counts.added === 0) return counts.skipped === 0 ? 'Nothing to add.' : 'Every board in this list was already on your list.'
  const known = counts.skipped > 0 ? ` ${counts.skipped} ${counts.skipped === 1 ? 'was' : 'were'} already on your list.` : ''
  return `Added ${plural(counts.added, 'board')}. They are checked on the next run.${known}`
}

/** One-click start with boards that are known to answer. Compact once the person has boards. */
export function StartFast({ compact, onAdded }: { compact: boolean; onAdded: () => void }): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState<Group | null>(null)

  async function add(group: Group): Promise<void> {
    setBusy(group)
    try {
      toast.success(addedMessage(await api.addStarterPack(group)))
      onAdded()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const button = (group: Group, variant: 'primary' | 'secondary'): React.JSX.Element => (
    <Button size={compact ? 'sm' : 'md'} variant={variant} loading={busy === group} disabled={busy !== null && busy !== group} onClick={() => void add(group)} title={compact ? hint(group) : undefined}>
      {LABELS[group]}
    </Button>
  )

  if (compact) {
    return (
      <Card className="mb-4 flex flex-wrap items-center gap-2 px-4 py-2.5">
        <Rocket size={14} className="text-faint" />
        <span className="mr-1 text-sm font-medium text-fg">Start fast</span>
        {button('games', 'secondary')}
        {button('tech', 'secondary')}
        {button('all', 'secondary')}
        <span className="text-xs text-faint">Boards you already have keep their settings.</span>
      </Card>
    )
  }

  return (
    <Card className="mb-4">
      <CardHeader title="Start fast" hint="Each board in these lists answered on its public job page when the lists were made. They are checked on every run." />
      <div className="grid gap-4 p-4 sm:grid-cols-3">
        {(['games', 'tech', 'all'] as const).map((group) => (
          <div key={group} className="flex flex-col items-start gap-2">
            {button(group, group === 'all' ? 'primary' : 'secondary')}
            <p className="text-xs text-faint">{group === 'all' ? 'Both lists together.' : hint(group)}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}
