import { createHashRouter, Navigate, useLocation } from 'react-router'
import { Layout } from './components/Layout'
import { ErrorBlock, Loading } from './components/ui'
import { useApp } from './lib/app'
import { onboardingSkipped } from './lib/theme'
import { Dashboard } from './pages/Dashboard'
import { Jobs } from './pages/Jobs'
import { JobDetail } from './pages/JobDetail'
import { Review } from './pages/Review'
import { Applications } from './pages/Applications'
import { ProfilePage } from './pages/Profile'
import { Sources } from './pages/Sources'
import { Analytics } from './pages/Analytics'
import { SettingsPage } from './pages/Settings'
import { Onboarding } from './pages/Onboarding'

/** Waits for settings, then sends first-time users to onboarding unless they skipped it. */
function Gate(): React.JSX.Element {
  const { settings, loadError } = useApp()
  const location = useLocation()
  if (loadError) {
    return (
      <div className="p-8">
        <ErrorBlock message={loadError} />
      </div>
    )
  }
  if (!settings) return <Loading label="Starting" />
  if (!settings.onboardingDone && !onboardingSkipped()) return <Navigate to="/onboarding" replace state={{ from: location.pathname }} />
  return <Layout />
}

export const router = createHashRouter([
  { path: '/onboarding', element: <Onboarding /> },
  {
    element: <Gate />,
    children: [
      { path: '/', element: <Dashboard /> },
      { path: '/jobs', element: <Jobs /> },
      { path: '/jobs/:id', element: <JobDetail /> },
      { path: '/review', element: <Review /> },
      { path: '/review/:id', element: <Review /> },
      { path: '/applications', element: <Applications /> },
      { path: '/profile', element: <ProfilePage /> },
      { path: '/sources', element: <Sources /> },
      { path: '/analytics', element: <Analytics /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> }
    ]
  }
])
