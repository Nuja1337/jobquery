export type Theme = 'dark' | 'light'

const KEY = 'jobpls.theme'

export function getStoredTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // the theme still applies for this session
  }
}

const SKIP_KEY = 'jobpls.onboardingSkipped'

export function onboardingSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1'
  } catch {
    return false
  }
}

export function setOnboardingSkipped(skipped: boolean): void {
  try {
    if (skipped) localStorage.setItem(SKIP_KEY, '1')
    else localStorage.removeItem(SKIP_KEY)
  } catch {
    // ignore
  }
}
