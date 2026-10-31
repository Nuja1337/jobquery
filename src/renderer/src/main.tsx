import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import './styles.css'
import { applyTheme, getStoredTheme } from './lib/theme'
import { ToastProvider } from './lib/toast'
import { AppProvider } from './lib/app'
import { router } from './router'

applyTheme(getStoredTheme())

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ToastProvider>
      <AppProvider>
        <RouterProvider router={router} />
      </AppProvider>
    </ToastProvider>
  </StrictMode>
)
