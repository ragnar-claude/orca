export const EXACT_ORCA_PATH = '/root'
export const MODULE_ROOT = '/root/orca-control/worker-lifecycle-policy'
export const SERVING_PROMOTION_HOOK =
  'src/main/runtime/rpc/methods/orchestration/worker/worker-lifecycle-policy.ts'
export const ENV_SESSION = 'ORCA_SESSION_ID'
export const ENV_INCARNATION = 'ORCA_WORKER_INCARNATION'
export const SCHEMA = 'livewell.orca.worker_lifecycle_policy.v1'
export const SIGTERM = 15

export const SERVING_PROMOTION_CONTRACT = {
  schema: SCHEMA,
  exact_orca_path: EXACT_ORCA_PATH,
  module_root: MODULE_ROOT,
  serving_hook: SERVING_PROMOTION_HOOK,
  public_api: [
    'WorkerLifecyclePolicy',
    'Limits',
    'ResourceMetrics',
    'PositiveIdentity',
    'ResidualHandoff',
    'Decision',
    'ReapVerdict',
    'readLinuxProcessTable',
    'reconcileOrphans',
    'asCheckpointWriterKwargs',
    'evaluateThresholds',
    'SERVING_PROMOTION_CONTRACT'
  ],
  forbidden_imports: ['launch_guard', 'local_model_guard', 'oliver_persona', 'SOUL'],
  does_not: [
    'edit checkpoint-writer',
    'admit worker-start',
    'mutate serving Orca runtime',
    'kill from process counts',
    'reap without cwd/session/incarnation/PGID positive identity',
    'close before release',
    'archive before close',
    'release without worker_done',
    'implicit residual handoff'
  ],
  checkpoint_before_limits: true,
  one_bounded_task_per_worker: true
} as const

export type WorkerLifecycleState =
  | 'idle'
  | 'bound'
  | 'running'
  | 'checkpointing'
  | 'awaiting_worker_done'
  | 'worker_done'
  | 'residual_handoff'
  | 'releasing'
  | 'closing'
  | 'archiving'
  | 'archived'

export const TERMINAL_LIVE_STATES: ReadonlySet<WorkerLifecycleState> = new Set([
  'bound',
  'running',
  'checkpointing',
  'awaiting_worker_done',
  'worker_done',
  'residual_handoff'
])

export type ThresholdBand = 'ok' | 'checkpoint' | 'hard'

export type Limits = {
  contextWindowTokens: number
  contextCheckpointRatio: number
  contextHardRatio: number
  maxAgeSeconds: number
  ageCheckpointRatio: number
  cpuPercentCap: number
  cpuCheckpointRatio: number
  ramBytesCap: number
  ramCheckpointRatio: number
}

export const DEFAULT_LIMITS: Limits = {
  contextWindowTokens: 128_000,
  contextCheckpointRatio: 0.8,
  contextHardRatio: 0.95,
  maxAgeSeconds: 4 * 3600,
  ageCheckpointRatio: 0.8,
  cpuPercentCap: 100,
  cpuCheckpointRatio: 0.8,
  ramBytesCap: 8 * 1024 ** 3,
  ramCheckpointRatio: 0.8
}

export function contextCheckpoint(limits: Limits): number {
  return limits.contextWindowTokens * limits.contextCheckpointRatio
}
export function contextHard(limits: Limits): number {
  return limits.contextWindowTokens * limits.contextHardRatio
}
export function ageCheckpoint(limits: Limits): number {
  return limits.maxAgeSeconds * limits.ageCheckpointRatio
}
export function cpuCheckpoint(limits: Limits): number {
  return limits.cpuPercentCap * limits.cpuCheckpointRatio
}
export function ramCheckpoint(limits: Limits): number {
  return limits.ramBytesCap * limits.ramCheckpointRatio
}

export type ResourceMetrics = {
  contextTokens: number
  ageSeconds: number
  cpuPercent: number
  ramBytes: number
}

export type PositiveIdentity = {
  cwd: string
  sessionId: string
  incarnation: string
  pgid: number
}

export function identityComplete(identity: PositiveIdentity): boolean {
  return Boolean(
    identity.cwd.trim() &&
    identity.sessionId.trim() &&
    identity.incarnation.trim() &&
    Number.isInteger(identity.pgid) &&
    identity.pgid > 0
  )
}

export function identitiesEqual(a: PositiveIdentity, b: PositiveIdentity): boolean {
  return (
    a.cwd === b.cwd &&
    a.sessionId === b.sessionId &&
    a.incarnation === b.incarnation &&
    a.pgid === b.pgid
  )
}

export type ProcRecord = {
  pid: number
  pgid: number
  ppid: number
  cwd: string | null
  sessionId: string | null
  incarnation: string | null
  comm: string
}

export type ResidualHandoff = {
  sourceTaskId: string
  successorTaskId: string
  summary: string
  declaredBy: string
}

export function residualValid(residual: ResidualHandoff): boolean {
  return Boolean(
    residual.sourceTaskId &&
    residual.successorTaskId &&
    residual.successorTaskId !== residual.sourceTaskId &&
    residual.summary.trim() &&
    residual.declaredBy.trim()
  )
}

export type Decision = {
  allowed: boolean
  action: string
  state: WorkerLifecycleState
  reason: string
  effects: readonly string[]
  checkpointId: string | null
  extra: Record<string, unknown>
}

export type ReapVerdict = {
  action: 'reap' | 'refuse'
  reason: string
  pgid: number | null
  identity: PositiveIdentity | null
  matchedPids: readonly number[]
}

export type CheckpointSink = {
  persist(payload: Record<string, unknown>): Record<string, unknown>
}

export type KillPg = (pgid: number, signal: number) => void

export class MemoryCheckpointSink implements CheckpointSink {
  payloads: Record<string, unknown>[] = []

  persist(payload: Record<string, unknown>): Record<string, unknown> {
    const sequence = this.payloads.length + 1
    const record = {
      ...payload,
      checkpoint_id: payload.checkpoint_id ?? `wchk_${String(sequence).padStart(4, '0')}`,
      sequence
    }
    this.payloads.push(record)
    return record
  }
}

type DimensionEval = {
  value: number
  checkpointAt: number
  hardAt: number
  band: ThresholdBand
}

export type ThresholdEvaluation = {
  dimensions: Record<string, DimensionEval>
  hard: readonly string[]
  approaching: readonly string[]
  worst: ThresholdBand
}

function bandFor(value: number, checkpointAt: number, hardAt: number): ThresholdBand {
  if (value >= hardAt) {
    return 'hard'
  }
  if (value >= checkpointAt) {
    return 'checkpoint'
  }
  return 'ok'
}

export function evaluateThresholds(metrics: ResourceMetrics, limits: Limits): ThresholdEvaluation {
  const dimensions: Record<string, DimensionEval> = {
    context: {
      value: metrics.contextTokens,
      checkpointAt: contextCheckpoint(limits),
      hardAt: contextHard(limits),
      band: bandFor(metrics.contextTokens, contextCheckpoint(limits), contextHard(limits))
    },
    age: {
      value: metrics.ageSeconds,
      checkpointAt: ageCheckpoint(limits),
      hardAt: limits.maxAgeSeconds,
      band: bandFor(metrics.ageSeconds, ageCheckpoint(limits), limits.maxAgeSeconds)
    },
    cpu: {
      value: metrics.cpuPercent,
      checkpointAt: cpuCheckpoint(limits),
      hardAt: limits.cpuPercentCap,
      band: bandFor(metrics.cpuPercent, cpuCheckpoint(limits), limits.cpuPercentCap)
    },
    ram: {
      value: metrics.ramBytes,
      checkpointAt: ramCheckpoint(limits),
      hardAt: limits.ramBytesCap,
      band: bandFor(metrics.ramBytes, ramCheckpoint(limits), limits.ramBytesCap)
    }
  }
  const hard = Object.entries(dimensions)
    .filter(([, info]) => info.band === 'hard')
    .map(([name]) => name)
  const approaching = Object.entries(dimensions)
    .filter(([, info]) => info.band === 'checkpoint')
    .map(([name]) => name)
  return {
    dimensions,
    hard,
    approaching,
    worst: hard.length ? 'hard' : approaching.length ? 'checkpoint' : 'ok'
  }
}
