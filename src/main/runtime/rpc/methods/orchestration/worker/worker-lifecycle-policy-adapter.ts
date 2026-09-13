import { EXACT_ORCA_PATH, SCHEMA } from './worker-lifecycle-policy-model'

export function asCheckpointWriterKwargs(
  workerCheckpoint: Record<string, unknown>,
  args: { runId: string; coordinatorHandle: string }
): Record<string, unknown> {
  const taskId = String(workerCheckpoint.task_id ?? '')
  const dispatchId = String(workerCheckpoint.dispatch_id ?? '')
  const handle = String(workerCheckpoint.terminal_handle ?? '')
  const state = String(workerCheckpoint.state ?? '')
  const draining = Boolean(workerCheckpoint.drain) || state === 'awaiting_worker_done'
  const nextActions: Record<string, unknown>[] = []
  if (draining || state === 'awaiting_worker_done') {
    nextActions.push({ action: 'await_worker_done', task_id: taskId, dispatch_id: dispatchId })
  }
  return {
    active_dispatches: [
      {
        dispatch_id: dispatchId || 'ctx_unbound',
        task_id: taskId || 'task_unbound',
        terminal_handle: handle || 'term_unbound',
        liveness: state === 'archived' ? 'exited' : 'live',
        worker_state: state,
        activity: draining ? 'checkpointing' : 'working',
        provider: 'agnostic',
        scopes: [EXACT_ORCA_PATH]
      }
    ],
    unacknowledged_delivery: { delivery_id: null, messages: [], count: 0, acknowledged: true },
    tasks: {
      ready: [],
      pending: taskId ? [{ id: taskId, status: 'pending' }] : [],
      blocked: []
    },
    decision_gates: [],
    write_lane_locks: [],
    owner_authorizations: [],
    last_completed_action: {
      action: 'worker_checkpoint',
      reason: workerCheckpoint.reason,
      task_id: taskId,
      dispatch_id: dispatchId,
      outcome: 'succeeded'
    },
    exact_next_actions: nextActions,
    rotation_metrics: {
      current_input_tokens: Number(workerCheckpoint.context_tokens ?? 0),
      baseline_input_tokens: 0
    },
    metadata: {
      schema: SCHEMA,
      source: 'worker-lifecycle-policy',
      worker_checkpoint: { ...workerCheckpoint },
      run_id: args.runId,
      coordinator_handle: args.coordinatorHandle,
      exact_orca_path: EXACT_ORCA_PATH
    }
  }
}
