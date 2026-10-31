import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import './styles.css'
import { bridgeMissing } from './lib/api'
import { applyTheme, getStoredTheme } from './lib/theme'
import { ToastProvider } from './lib/toast'
import { AppProvider } from './lib/app'
import { router } from './router'

applyTheme(getStoredTheme())

function ConnectionError(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-bad/40 bg-bad-soft px-5 py-4" role="alert">
        <h1 className="text-base font-semibold text-fg">JobPilot couldn&apos;t connect to its background process</h1>
        <p className="mt-1.5 text-sm text-muted">Close the app and open it again.</p>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {bridgeMissing ? (
      <ConnectionError />
    ) : (
      <ToastProvider>
        <AppProvider>
          <RouterProvider router={router} />
        </AppProvider>
      </ToastProvider>
    )}
  </StrictMode>
)
