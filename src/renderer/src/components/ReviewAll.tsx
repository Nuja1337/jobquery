import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { api } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { relativeTime } from '@renderer/lib/format'
import { Badge, Button, Card, EmptyState, ErrorBlock, Loading } from './ui'
import { FitBadge } from './badges'

export const PAGE_SIZE = 50

/** Every application in the review queue, best fit first, one page at a time. */
export function ReviewAll(): React.JSX.Element {
  const [page, setPage] = useState(0)
  const list = useAsync(() => api.listApplications({ statuses: ['ready', 'needs_attention'], sort: 'fit', limit: PAGE_SIZE, offset: page * PAGE_SIZE }), [page], ['applications:changed'])
  const total = list.data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  // Answering from another tab can shorten the queue past the page being shown.
  useEffect(() => {
    if (list.data && page > lastPage) setPage(lastPage)
  }, [list.data, page, lastPage])

  if (list.error) return <ErrorBlock message={list.error} onRetry={list.reload} />
  if (!list.data) return <Loading />
  if (total === 0) return <EmptyState title="Nothing to review" text="When jobpls drafts an application, it shows up here." />

  const from = page * PAGE_SIZE + 1
  const to = Math.min(total, from + list.data.items.length - 1)
  return (
    <Card>
      <ul className="divide-y divide-line">
        {list.data.items.map((a) => (
          <li key={a.id}>
            <Link to={`/review/${a.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-hover">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-medium text-fg">{a.title}</p>
                <p className="truncate text-xs text-muted">
                  {a.company}
                  <span className="text-faint">, drafted {relativeTime(a.createdAt)}</span>
                </p>
              </div>
              <FitBadge bucket={a.fitBucket} score={a.fitScore} compact />
              {a.flaggedCount > 0 ? <Badge tone="warn">{a.flaggedCount} to fill</Badge> : a.guessCount > 0 ? <Badge tone="warn">{a.guessCount} to check</Badge> : <Badge tone="good">Ready</Badge>}
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
        <p className="text-xs text-muted" aria-live="polite">
          Showing {from} to {to} of {total}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<ArrowLeft size={13} />} disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button size="sm" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
            <span className="flex items-center gap-1.5">
              Next <ArrowRight size={13} />
            </span>
          </Button>
        </div>
      </div>
    </Card>
  )
}
