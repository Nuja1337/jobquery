import type { AtsKind, CompanyOrigin } from '@shared/types'
import { SOURCE_LABELS } from '@renderer/lib/format'

export const ORIGIN_LABELS: Record<CompanyOrigin, string> = {
  manual: 'Added by you',
  posting_link: 'From a posting',
  starter: 'Starter pack',
  import: 'Imported'
}

const EXTRA_LABELS: Partial<Record<AtsKind, string>> = { workday: 'Workday', recruitee: 'Recruitee', unknown: 'Not recognized' }

/** The name of an application system as people know it. */
export function atsLabel(ats: AtsKind): string {
  return EXTRA_LABELS[ats] ?? (SOURCE_LABELS as Record<string, string>)[ats] ?? ats
}

export const ATS_FILTER: AtsKind[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'rippling', 'breezy', 'personio', 'workday', 'recruitee', 'unknown']
