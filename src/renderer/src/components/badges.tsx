import { BUCKET_LABELS } from '@shared/defaults'
import type { AnswerSource, ApplicationOutcome, ApplicationStatus, FitBucket, JobStage, SubmitMode } from '@shared/types'
import { billingLabel, billingTitle } from '@renderer/lib/providers'
import type { ProviderInfo } from '@shared/types'
import { Badge, type Tone } from './ui'

/** What a provider costs, with the same wording everywhere. */
export function ProviderBillingBadge({ provider }: { provider: Pick<ProviderInfo, 'kind' | 'billing'> }): React.JSX.Element {
  return (
    <Badge tone={provider.kind === 'openrouter' || provider.billing === 'free' ? 'info' : 'neutral'} title={billingTitle(provider)}>
      {billingLabel(provider)}
    </Badge>
  )
}

const BUCKET_TONE: Record<FitBucket, Tone> = { perfect: 'good', great: 'info', good: 'accent', weak: 'neutral' }

export function FitBadge({ bucket, score, compact }: { bucket: FitBucket | null; score: number | null; compact?: boolean }): React.JSX.Element {
  if (bucket == null || score == null) return <span className="text-xs text-faint">Not scored</span>
  return (
    <Badge tone={BUCKET_TONE[bucket]} title={`${BUCKET_LABELS[bucket]}, score ${score}`}>
      <span className="tabular-nums">{score}</span>
      {!compact && <span>{BUCKET_LABELS[bucket]}</span>}
    </Badge>
  )
}

export const STAGE_LABELS: Record<JobStage, string> = {
  new: 'New',
  filtered_out: 'Filtered out',
  prescored_out: 'Low keyword match',
  duplicate: 'Duplicate',
  scored: 'Not a fit',
  shortlisted: 'Shortlisted',
  dismissed: 'Dismissed',
  preparing: 'Preparing',
  ready: 'Ready to review',
  applied: 'Applied',
  closed: 'Closed'
}

const STAGE_TONE: Record<JobStage, Tone> = {
  new: 'info',
  filtered_out: 'neutral',
  prescored_out: 'neutral',
  duplicate: 'neutral',
  scored: 'neutral',
  shortlisted: 'accent',
  dismissed: 'neutral',
  preparing: 'warn',
  ready: 'good',
  applied: 'good',
  closed: 'neutral'
}

export function StageBadge({ stage }: { stage: JobStage }): React.JSX.Element {
  return <Badge tone={STAGE_TONE[stage]}>{STAGE_LABELS[stage]}</Badge>
}

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  draft: 'Drafting',
  ready: 'Ready',
  needs_attention: 'Needs you',
  submitting: 'Submitting',
  submitted: 'Submitted',
  failed: 'Failed',
  withdrawn: 'Withdrawn'
}

const STATUS_TONE: Record<ApplicationStatus, Tone> = { draft: 'neutral', ready: 'good', needs_attention: 'warn', submitting: 'info', submitted: 'accent', failed: 'bad', withdrawn: 'neutral' }

export function StatusBadge({ status }: { status: ApplicationStatus }): React.JSX.Element {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>
}

export const OUTCOME_LABELS: Record<ApplicationOutcome, string> = {
  none: 'No reply yet',
  screen: 'Screening call',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  ghosted: 'Ghosted',
  accepted: 'Accepted',
  declined: 'Declined'
}

export const OUTCOME_ORDER: ApplicationOutcome[] = ['none', 'screen', 'interview', 'offer', 'rejected', 'ghosted', 'accepted', 'declined']

export const OUTCOME_TONE: Record<ApplicationOutcome, Tone> = { none: 'neutral', screen: 'info', interview: 'accent', offer: 'good', rejected: 'bad', ghosted: 'neutral', accepted: 'good', declined: 'warn' }

export function OutcomeBadge({ outcome }: { outcome: ApplicationOutcome }): React.JSX.Element {
  return <Badge tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABELS[outcome]}</Badge>
}

export const SOURCE_BADGES: Record<AnswerSource, { label: string; tone: Tone }> = {
  profile: { label: 'Profile', tone: 'info' },
  answer_bank: { label: 'Saved answer', tone: 'accent' },
  settings: { label: 'Settings', tone: 'neutral' },
  ai: { label: 'AI', tone: 'neutral' },
  user: { label: 'You', tone: 'good' },
  file: { label: 'File', tone: 'neutral' }
}

export function AnswerSourceBadge({ source }: { source: AnswerSource }): React.JSX.Element {
  const s = SOURCE_BADGES[source]
  return <Badge tone={s.tone}>{s.label}</Badge>
}

export const SUBMIT_MODE_LABELS: Record<SubmitMode, string> = { manual: 'By hand', assist: 'Assisted', auto: 'Automatic' }
