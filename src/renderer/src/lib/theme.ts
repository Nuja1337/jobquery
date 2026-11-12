export type Theme = 'dark' | 'light'

const KEY = 'jobquery.theme'
// The app was called jobpls before. Its saved choices are still read, so the rename doesn't reset them.
const OLD_KEY = 'jobpls.theme'

export function getStoredTheme(): Theme {
  try {
    return (localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY)) === 'light' ? 'light' : 'dark'
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

const SKIP_KEY = 'jobquery.onboardingSkipped'
const OLD_SKIP_KEY = 'jobpls.onboardingSkipped'

export function onboardingSkipped(): boolean {
  try {
    return (localStorage.getItem(SKIP_KEY) ?? localStorage.getItem(OLD_SKIP_KEY)) === '1'
  } catch {
    return false
  }
}

export function setOnboardingSkipped(skipped: boolean): void {
  try {
    if (skipped) localStorage.setItem(SKIP_KEY, '1')
    else {
      localStorage.removeItem(SKIP_KEY)
      localStorage.removeItem(OLD_SKIP_KEY)
    }
  } catch {
    // ignore
  }
}
