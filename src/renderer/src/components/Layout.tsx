import { useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import { BarChart3, Briefcase, Download, FileText, Globe, Inbox, LayoutDashboard, Play, RefreshCw, Rocket, Send, Settings as SettingsIcon, Square, Wand2 } from 'lucide-react'
import { clsx } from 'clsx'
import { RELEASES_URL } from '@shared/defaults'
import { api, isDemo } from '@renderer/lib/api'
import { useApp } from '@renderer/lib/app'
import { formatUsd, plural } from '@renderer/lib/format'
import { useToast } from '@renderer/lib/toast'
import { RestartToUpdateDialog } from './RestartToUpdateDialog'
import { Badge, Button, ProgressBar } from './ui'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/jobs', label: 'Jobs', icon: Briefcase },
  { to: '/review', label: 'Review queue', icon: Inbox, badge: true },
  { to: '/applications', label: 'Applications', icon: Send },
  { to: '/profile', label: 'Profile and materials', icon: FileText },
  { to: '/sources', label: 'Sources', icon: Globe },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: SettingsIcon }
]

function Sidebar(): React.JSX.Element {
  const { reviewCount, settings } = useApp()
  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-line bg-surface" aria-label="Main">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-fg">
          <Rocket size={15} />
        </div>
        <span className="text-sm font-semibold tracking-tight text-fg">JobPilot</span>
      </div>
      <ul className="flex-1 space-y-0.5 px-2">
        {NAV.map(({ to, label, icon: Icon, end, badge }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors', isActive ? 'bg-hover text-fg' : 'text-muted hover:bg-hover/60 hover:text-fg')
              }
            >
              <Icon size={16} className="shrink-0" />
              <span className="flex-1 truncate">{label}</span>
              {badge && reviewCount > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium tabular-nums text-accent-fg">{reviewCount}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="space-y-1 border-t border-line p-2">
        <NavLink to="/onboarding" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-hover/60 hover:text-fg">
          <Wand2 size={16} />
          <span className="flex-1">Setup guide</span>
          {settings && !settings.onboardingDone && <Badge tone="warn">To do</Badge>}
        </NavLink>
      </div>
    </nav>
  )
}

/** Shows a button only when an update is ready to install or has to be downloaded by hand. */
function UpdateButton(): React.JSX.Element | null {
  const { updateStatus } = useApp()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  if (updateStatus?.state === 'ready') {
    return (
      <>
        <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => setConfirming(true)}>
          Restart to update
        </Button>
        {confirming && <RestartToUpdateDialog onClose={() => setConfirming(false)} />}
      </>
    )
  }
  if (updateStatus?.state === 'available') {
    return (
      <Button size="sm" icon={<Download size={13} />} onClick={() => void api.openExternal(updateStatus.downloadUrl ?? RELEASES_URL).catch(toast.error)} title={updateStatus.version ? `Version ${updateStatus.version} is available. This opens the download page.` : undefined}>
        Update available
      </Button>
    )
  }
  return null
}

function TopBar(): React.JSX.Element {
  const { progress, running, starting, runNow, cancelRun, usage } = useApp()
  const noLimit = !!usage && usage.dailyBudgetUsd <= 0
  const spendRatio = usage && usage.dailyBudgetUsd > 0 ? usage.todayUsd / usage.dailyBudgetUsd : 0
  return (
    <div className="flex h-12 shrink-0 items-center gap-6 border-b border-line bg-surface px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className={clsx('h-2 w-2 shrink-0 rounded-full', running ? 'animate-pulse bg-accent' : 'bg-faint')} />
        <div className="min-w-0">
          <p className="truncate text-sm text-fg">{running ? progress.message : 'Pipeline idle'}</p>
          {running && progress.total > 0 && (
            <div className="mt-1 flex items-center gap-2">
              <div className="w-40">
                <ProgressBar value={progress.done / progress.total} />
              </div>
              <span className="text-xs tabular-nums text-faint">
                {progress.done} of {progress.total}
              </span>
            </div>
          )}
        </div>
      </div>
      {isDemo && (
        <Badge tone="warn" title="The app is open in a browser without the backend. Everything shown is sample data.">
          Demo data
        </Badge>
      )}
      {usage && usage.freeCallsToday > 0 && (
        <span className="shrink-0 text-xs tabular-nums text-muted" title="Calls made today through free or local providers. They cost nothing and don't count toward your budget.">
          {plural(usage.freeCallsToday, 'free call')} today
        </span>
      )}
      {usage && (
        <div className="w-52 shrink-0" title={`${noLimit ? `About ${formatUsd(usage.todayUsd)} spent today by JobPilot's estimate. No daily limit is set.` : `About ${formatUsd(usage.todayUsd)} spent today of a ${formatUsd(usage.dailyBudgetUsd)} daily budget, by JobPilot's estimate.`} The figure comes from the prices in Settings. Your provider's bill is the real cost.`}>
          <div className="mb-1 flex justify-between gap-2 whitespace-nowrap text-xs">
            <span className="text-muted">Today, estimated</span>
            <span className="tabular-nums text-fg">
              {formatUsd(usage.todayUsd)} <span className="text-faint">{noLimit ? 'No limit' : `of ${formatUsd(usage.dailyBudgetUsd)}`}</span>
            </span>
          </div>
          {noLimit ? <div className="h-1.5 w-full rounded-full border border-dashed border-line-strong" aria-hidden="true" /> : <ProgressBar value={spendRatio} tone={spendRatio >= 1 ? 'bad' : spendRatio >= 0.8 ? 'warn' : 'accent'} />}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2">
        <UpdateButton />
        {running ? (
          <Button onClick={() => void cancelRun()} icon={<Square size={13} />}>
            Cancel run
          </Button>
        ) : (
          <Button variant="primary" loading={starting} disabled={starting} onClick={() => void runNow()} icon={<Play size={13} />}>
            Run now
          </Button>
        )}
      </div>
    </div>
  )
}

export function Layout(): React.JSX.Element {
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
