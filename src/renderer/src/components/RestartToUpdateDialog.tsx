import { useApp } from '@renderer/lib/app'
import { ConfirmDialog } from './ConfirmDialog'

/** Asks before closing the app to install a downloaded update. */
export function RestartToUpdateDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { updateStatus, installUpdate } = useApp()
  const version = updateStatus?.version
  return (
    <ConfirmDialog
      title="Restart to update?"
      message={`JobPilot saves your work, closes, installs ${version ? `version ${version}` : 'the update'} and opens again.`}
      confirmLabel="Restart now"
      onClose={onClose}
      onConfirm={installUpdate}
    />
  )
}
