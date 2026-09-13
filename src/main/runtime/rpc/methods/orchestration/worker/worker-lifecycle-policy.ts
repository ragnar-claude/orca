/**
 * Provider-agnostic hard lifecycle for one bounded Orca worker task.
 * Serving promotion hook for /root/orca-control/worker-lifecycle-policy.
 * Does not start workers, admit local models, or call resource-admission.
 */
import {
  SIGTERM,
  residualValid,
  type Decision,
  type ReapVerdict,
  type ResidualHandoff,
  type ResourceMetrics,
  type WorkerLifecycleState
} from './worker-lifecycle-policy-model'
import { readLinuxProcessTable, reconcileOrphans } from './worker-lifecycle-policy-reap'
import { WorkerLifecyclePolicyCore } from './worker-lifecycle-policy-core'

export * from './worker-lifecycle-policy-model'
export { asCheckpointWriterKwargs } from './worker-lifecycle-policy-adapter'
export {
  readLinuxProcessTable,
  reconcileOrphans,
  reapFromProcessCount
} from './worker-lifecycle-policy-reap'
export type { WorkerDoneRecord } from './worker-lifecycle-policy-core'

export class WorkerLifecyclePolicy extends WorkerLifecyclePolicyCore {
  receiveWorkerDone(args: {
    taskId: string
    dispatchId: string
    outcome: string
    leftover?: boolean
    residual?: ResidualHandoff | null
  }): Decision {
    if (!['running', 'checkpointing', 'awaiting_worker_done'].includes(this.state)) {
      return this.decide(false, 'worker_done', `worker_done not accepted in state ${this.state}`)
    }
    if (args.taskId !== this.taskId) {
      return this.decide(
        false,
        'worker_done',
        `worker_done task_id ${JSON.stringify(args.taskId)} does not match bound ${JSON.stringify(this.taskId)}`
      )
    }
    if (args.dispatchId !== this.dispatchId) {
      return this.decide(
        false,
        'worker_done',
        `worker_done dispatch_id ${JSON.stringify(args.dispatchId)} does not match ${JSON.stringify(this.dispatchId)}`
      )
    }
    if (args.leftover && !args.residual) {
      this.workerDone = {
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        outcome: args.outcome,
        leftover: true,
        residualDeclared: false
      }
      return this.decide(
        true,
        'worker_done',
        'worker_done recorded with leftover; explicit residual handoff required before release',
        { state: 'worker_done', extra: { leftover: true, residual_required: true } }
      )
    }
    if (args.residual) {
      if (!residualValid(args.residual) || args.residual.sourceTaskId !== this.taskId) {
        return this.decide(
          false,
          'worker_done',
          'residual handoff invalid or source_task_id mismatch'
        )
      }
      this.residual = args.residual
      this.workerDone = {
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        outcome: args.outcome,
        leftover: true,
        residualDeclared: true
      }
      return this.decide(true, 'worker_done', 'worker_done with explicit residual handoff', {
        state: 'residual_handoff',
        effects: ['explicit_residual_handoff']
      })
    }
    this.workerDone = {
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      outcome: args.outcome,
      leftover: false,
      residualDeclared: false
    }
    return this.decide(true, 'worker_done', 'worker_done accepted; no residual', {
      state: 'worker_done'
    })
  }

  declareResidual(residual: ResidualHandoff): Decision {
    if (this.state !== 'worker_done') {
      return this.decide(
        false,
        'declare_residual',
        `explicit residual only after worker_done, not ${this.state}`
      )
    }
    if (!residualValid(residual) || residual.sourceTaskId !== this.taskId) {
      return this.decide(false, 'declare_residual', 'residual handoff must be explicit and valid')
    }
    if (!this.workerDone?.leftover) {
      return this.decide(
        false,
        'declare_residual',
        'no leftover declared on worker_done; refusing implicit residual'
      )
    }
    this.residual = residual
    this.workerDone.residualDeclared = true
    return this.decide(true, 'declare_residual', 'explicit residual handoff recorded', {
      state: 'residual_handoff',
      effects: ['explicit_residual_handoff']
    })
  }

  release(): Decision {
    if (!this.workerDone) {
      return this.decide(false, 'release', 'worker_done required before release')
    }
    if (this.state === 'worker_done' && this.workerDone.leftover && !this.residual) {
      return this.decide(
        false,
        'release',
        'leftover work present; explicit residual handoff required before release'
      )
    }
    if (this.state !== 'worker_done' && this.state !== 'residual_handoff') {
      return this.decide(false, 'release', `cannot release from ${this.state}`)
    }
    this.released = true
    return this.decide(true, 'release', 'resource released', {
      state: 'releasing',
      effects: ['released']
    })
  }

  close(): Decision {
    if (!this.released || this.state !== 'releasing') {
      return this.decide(false, 'close', 'release must precede close')
    }
    this.closed = true
    return this.decide(true, 'close', 'terminal closed', { state: 'closing', effects: ['closed'] })
  }

  archive(): Decision {
    if (!this.closed || this.state !== 'closing') {
      return this.decide(false, 'archive', 'close must precede archive')
    }
    this.archived = true
    return this.decide(true, 'archive', 'worker archived', {
      state: 'archived',
      effects: ['archived']
    })
  }

  processTable() {
    if (this.injectedTable) {
      return [...this.injectedTable]
    }
    return readLinuxProcessTable(this.procRoot ?? '/proc')
  }

  reconcile(): ReapVerdict {
    const verdict = reconcileOrphans({
      claimed: this.identity,
      table: this.processTable(),
      workerState: this.state,
      liveParentPids: this.liveParentPids
    })
    this.reapLog.push(verdict)
    if (verdict.action === 'reap' && verdict.pgid != null) {
      if (!this.killpg) {
        return { ...verdict, reason: `${verdict.reason} (signal not sent: no reaper bound)` }
      }
      this.killpg(verdict.pgid, SIGTERM)
    }
    return verdict
  }

  tick(metrics: ResourceMetrics): {
    observe: Decision
    reap: ReapVerdict
    state: WorkerLifecycleState
  } {
    return { observe: this.observe(metrics), reap: this.reconcile(), state: this.state }
  }
}
