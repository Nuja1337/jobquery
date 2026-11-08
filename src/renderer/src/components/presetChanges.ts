import type { DeepPartial } from '@shared/api'
import type { Settings } from '@shared/types'

export interface PresetChange {
  /** Dotted path in Settings, for example "budget.dailyUsd". */
  path: string
  from: string
  to: string
  /** A full sentence for the dialog. */
  sentence: string
}

type Kind = 'bool' | 'number' | 'usd' | 'days' | 'ms' | 'text'

interface FieldInfo {
  label: string
  kind: Kind
  /** Plain words for values of a text field. */
  words?: Record<string, string>
}

/** How each setting a preset can touch is named and written. A test checks that every key in VOLUME_PRESET is here. */
export const PRESET_FIELDS: Record<string, FieldInfo> = {
  'thresholds.shortlistScore': { label: 'The fit score for the shortlist', kind: 'number' },
  'thresholds.autoPrepareScore': { label: 'The fit score to draft an application automatically', kind: 'number' },
  'thresholds.autoSubmitScore': { label: 'The fit score to submit automatically', kind: 'number' },
  'budget.dailyUsd': { label: 'The daily AI spend limit', kind: 'usd' },
  'budget.monthlyUsd': { label: 'The monthly AI spend limit', kind: 'usd' },
  'budget.maxTriagePerDay': { label: 'The number of jobs scored per day', kind: 'number' },
  'budget.maxPreparePerDay': { label: 'The number of applications prepared per day', kind: 'number' },
  'autopilot.enabled': { label: 'Autopilot', kind: 'bool' },
  'autopilot.mode': { label: 'The autopilot mode', kind: 'text', words: { interval: 'on a schedule', continuous: 'continuous' } },
  'autopilot.autoPrepare': { label: 'Drafting applications automatically', kind: 'bool' },
  'autopilot.autoSubmit': { label: 'Submitting applications automatically', kind: 'bool' },
  'autopilot.dryRun': { label: 'Dry run', kind: 'bool' },
  'autopilot.dailySubmitCap': { label: 'The most applications sent per day', kind: 'number' },
  'autopilot.hourlySubmitCap': { label: 'The most applications sent per hour', kind: 'number' },
  'autopilot.submitConcurrency': { label: 'The number of forms filled at once', kind: 'number' },
  'autopilot.requireNoFlags': { label: 'Skipping applications with flagged answers', kind: 'bool' },
  'autopilot.tickRequiredConsent': { label: 'Ticking required privacy and truthfulness boxes', kind: 'bool' },
  'autopilot.sendSavedUserAnswers': { label: 'Sending your saved answers to questions only you answer', kind: 'bool' },
  'preferences.perCompanyLimit': { label: 'The number of applications one company may get inside the cooldown', kind: 'number' },
  'preferences.companyCooldownDays': { label: 'The cooldown between applications to one company', kind: 'days' },
  'preferences.maxPostingAgeDays': { label: 'The oldest posting jobpls looks at', kind: 'days' },
  'browser.slowMoMs': { label: 'The pause between browser actions', kind: 'ms' },
  'writing.coverLetterLength': { label: 'The cover letter length', kind: 'text' },
  'writing.minLintScore': { label: 'The writing check score a draft needs', kind: 'number' },
  'writing.maxRevisions': { label: 'The most revisions of a draft', kind: 'number' },
  'discovery.autoWatchBoards': { label: 'Watching company boards that postings link to', kind: 'bool' },
  'discovery.maxWatchedBoards': { label: 'The most boards watched automatically', kind: 'number' },
  'discovery.boardsPerRun': { label: 'The most boards read per run', kind: 'number' },
  'system.keepAwake': { label: 'Keeping the computer awake while autopilot works', kind: 'bool' },
  'system.closeToTray': { label: 'Closing the window to the tray', kind: 'bool' },
  'system.notifications': { label: 'Notifications', kind: 'bool' }
}

function leaves(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [[prefix, value]]
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (v === undefined ? [] : leaves(v, prefix ? `${prefix}.${k}` : k)))
}

function read(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined), obj)
}

export function formatPresetValue(info: FieldInfo, value: unknown): string {
  switch (info.kind) {
    case 'bool':
      return value ? 'on' : 'off'
    case 'usd':
      return `$${Number(value).toLocaleString('en-US')}`
    case 'days':
      return `${value} ${value === 1 ? 'day' : 'days'}`
    case 'ms':
      return `${value} ms`
    case 'number':
      return Number(value).toLocaleString('en-US')
    default:
      return info.words?.[String(value)] ?? String(value)
  }
}

/** Every value the preset would change in `current`, as sentences. Values that already match are left out. */
export function presetChanges(current: Settings, preset: DeepPartial<Settings>): PresetChange[] {
  const out: PresetChange[] = []
  for (const [path, to] of leaves(preset)) {
    const from = read(current, path)
    if (from === to) continue
    const info = PRESET_FIELDS[path] ?? { label: path, kind: 'text' as const }
    const fromText = formatPresetValue(info, from)
    const toText = formatPresetValue(info, to)
    out.push({ path, from: fromText, to: toText, sentence: `${info.label} goes from ${fromText} to ${toText}.` })
  }
  return out
}
