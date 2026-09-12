import type { OrchestrationDb } from '../../../../orchestration/db'
import type {
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../../../orchestration/worker-terminal-ownership'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

export async function settlePositivelyExitedMissingWorkerTerminal(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
}): Promise<WorkerTerminalResourceRow | null> {
  if (!args.resource.process_incarnation) {
    return null
  }
  const liveness = await args.runtime.inspectTerminalProcessIncarnationLiveness(
    args.resource.process_incarnation,
    args.resource.host_scope
  )
  if (liveness !== 'exited') {
    return null
  }
  const reconciled = args.db.settleDeadWorkerTerminalRelease({
    requestingDispatchId: args.dispatchId,
    resourceId: args.resource.id,
    processIncarnation: args.resource.process_incarnation,
    allowUnavailableArchive: true
  })
  if (reconciled.disposition !== 'released') {
    return null
  }
  args.runtime.notifyMessageArrived(`dispatch:${args.dispatchId}`, 'status')
  return reconciled.resource
}

export async function settlePositivelyExitedMissingRemoteAttachment(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
}): Promise<WorkerTerminalResourceRow | null> {
  const released = await settlePositivelyExitedMissingWorkerTerminal(args)
  if (released) {
    args.db.recordRemoteAttachmentStage({ dispatchId: args.dispatchId, stage: 'released' })
  }
  return released
}

export function workerTerminalRetainedReason(
  resource: WorkerTerminalResourceRow
): WorkerTerminalRetainedReason {
  if (resource.retained_reason) {
    return resource.retained_reason as WorkerTerminalRetainedReason
  }
  return resource.ownership_state === 'user_owned' ? 'user_takeover' : 'identity_unproven'
}
