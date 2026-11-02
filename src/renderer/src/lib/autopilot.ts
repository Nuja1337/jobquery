import type { Settings } from '@shared/types'
import { plural } from './format'

/**
 * The warning shown before auto-submit can start sending applications on its own. Used by the
 * dashboard switch and by Settings. The first-run sentence only applies when autopilot is being turned on.
 */
export function autopilotConfirmMessage(settings: Pick<Settings, 'thresholds' | 'autopilot'>, firstRun: boolean): string {
  const { thresholds, autopilot } = settings
  const base = `Auto-submit is on and dry run is off, so the app will click Submit on applications by itself. It does that when the fit score is ${thresholds.autoSubmitScore} or higher, and it sends up to ${plural(autopilot.dailySubmitCap, 'application')} a day.`
  if (!firstRun) return base
  return `${base} If the last run was longer ago than ${autopilot.intervalHours === 1 ? 'an hour' : `${autopilot.intervalHours} hours`}, the first run starts in about a minute.`
}
