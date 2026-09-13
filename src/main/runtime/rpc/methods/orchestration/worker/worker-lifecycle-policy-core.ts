import {
  DEFAULT_LIMITS,
  EXACT_ORCA_PATH,
  MemoryCheckpointSink,
  SCHEMA,
  evaluateThresholds,
  identityComplete,
  type CheckpointSink,
  type Decision,
  type KillPg,
  type Limits,
  type PositiveIdentity,
  type ProcRecord,
  type ReapVerdict,
  type ResidualHandoff,
  type ResourceMetrics,
  type WorkerLifecycleState
} from './worker-lifecycle-policy-model'

export type WorkerDoneRecord = {
  taskId: string
  dispatchId: string
  outcome: string
  leftover: boolean
  residualDeclared: boolean
}

export class WorkerLifecyclePolicyCore {
  readonly workerId: string
  readonly terminalHandle: string
  readonly identity: PositiveIdentity
  readonly limits: Limits
  readonly checkpointSink: CheckpointSink
  readonly clock: () => number
  readonly killpg: KillPg | null
  readonly procRoot: string | null
  readonly liveParentPids: readonly number[]
  runId: string
  dispatchId: string
  state: WorkerLifecycleState = 'idle'
  taskId: string | null = null
  startedAt: number | null = null
  history: Decision[] = []
  checkpoints: Record<string, unknown>[] = []
  residual: ResidualHandoff | null = null
  workerDone: WorkerDoneRecord | null = null
  lastMetrics: ResourceMetrics | null = null
  released = false
  closed = false
  archived = false
  reapLog: ReapVerdict[] = []
  protected readonly injectedTable: ProcRecord[] | null
  private readonly checkpointBandsSeen = new Set<string>()

  constructor(args: {
    workerId: string
    terminalHandle: string
    identity: PositiveIdentity
    limits?: Limits
    checkpointSink?: CheckpointSink
    clock?: () => number
    killpg?: KillPg | null
    procRoot?: string | null
    processTable?: readonly ProcRecord[] | null
    liveParentPids?: readonly number[]
    runId?: string
    dispatchId?: string
  }) {
    if (!identityComplete(args.identity)) {
      throw new Error('worker identity must include cwd, session_id, incarnation, pgid')
    }
    this.workerId = args.workerId
    this.terminalHandle = args.terminalHandle
    this.identity = args.identity
    this.limits = args.limits ?? DEFAULT_LIMITS
    this.checkpointSink = args.checkpointSink ?? new MemoryCheckpointSink()
    this.clock = args.clock ?? (() => Date.now() / 1000)
    this.killpg = args.killpg ?? null
    this.procRoot = args.procRoot ?? null
    this.injectedTable = args.processTable ? [...args.processTable] : null
    this.liveParentPids = args.liveParentPids ?? []
    this.runId = args.runId ?? ''
    this.dispatchId = args.dispatchId ?? ''
  }

  protected decide(
    allowed: boolean,
    action: string,
    reason: string,
    opts: {
      state?: WorkerLifecycleState
      effects?: readonly string[]
      checkpointId?: string | null
      extra?: Record<string, unknown>
    } = {}
  ): Decision {
    if (allowed && opts.state) {
      this.state = opts.state
    }
    const decision: Decision = {
      allowed,
      action,
      state: this.state,
      reason,
      effects: opts.effects ?? [],
      checkpointId: opts.checkpointId ?? null,
      extra: opts.extra ?? {}
    }
    this.history.push(decision)
    return decision
  }

  bind(taskId: string, opts: { dispatchId?: string } = {}): Decision {
    if (!taskId.trim()) {
      return this.decide(false, 'bind', 'task_id required')
    }
    if (this.state !== 'idle') {
      return this.decide(
        false,
        'bind',
        `one bounded task per worker: already ${this.state} task=${this.taskId}`
      )
    }
    this.taskId = taskId.trim()
    if (opts.dispatchId) {
      this.dispatchId = opts.dispatchId
    }
    return this.decide(true, 'bind', 'bound one task', { state: 'bound' })
  }

  start(): Decision {
    if (this.state !== 'bound') {
      return this.decide(false, 'start', `cannot start from ${this.state}`)
    }
    this.startedAt = this.clock()
    return this.decide(true, 'start', 'worker running', { state: 'running' })
  }

  private checkpoint(
    metrics: ResourceMetrics,
    reason: string,
    bands: readonly string[],
    drain: boolean
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      schema: SCHEMA,
      worker_id: this.workerId,
      terminal_handle: this.terminalHandle,
      task_id: this.taskId,
      dispatch_id: this.dispatchId,
      state: this.state,
      reason,
      bands: [...bands],
      drain,
      context_tokens: metrics.contextTokens,
      age_seconds: metrics.ageSeconds,
      cpu_percent: metrics.cpuPercent,
      ram_bytes: metrics.ramBytes,
      identity: {
        cwd: this.identity.cwd,
        session_id: this.identity.sessionId,
        incarnation: this.identity.incarnation,
        pgid: this.identity.pgid
      },
      exact_orca_path: EXACT_ORCA_PATH
    }
    const receipt = this.checkpointSink.persist(payload)
    const record = { ...payload, ...receipt }
    this.checkpoints.push(record)
    return record
  }

  observe(metrics: ResourceMetrics): Decision {
    this.lastMetrics = metrics
    if (this.state !== 'running' && this.state !== 'checkpointing') {
      return this.decide(false, 'observe', `cannot observe resource metrics in state ${this.state}`)
    }
    const evaluation = evaluateThresholds(metrics, this.limits)
    if (evaluation.worst === 'ok') {
      return this.decide(true, 'observe', 'metrics under checkpoint thresholds', {
        extra: evaluation
      })
    }
    const bands = [...new Set([...evaluation.approaching, ...evaluation.hard])]
    const bandKey = `${bands.join('+')}:${evaluation.worst}`
    const needCheckpoint = !this.checkpointBandsSeen.has(bandKey)
    let checkpointId: string | null = null
    const effects: string[] = []
    if (needCheckpoint) {
      this.state = 'checkpointing'
      const record = this.checkpoint(
        metrics,
        evaluation.worst === 'hard'
          ? 'hard limit reached; checkpoint before drain'
          : 'approaching limit; checkpoint before hard cap',
        bands,
        evaluation.worst === 'hard'
      )
      checkpointId = String(record.checkpoint_id ?? '')
      this.checkpointBandsSeen.add(bandKey)
      effects.push('checkpointed')
    }
    if (evaluation.worst === 'hard') {
      return this.decide(true, 'observe', 'hard limit: checkpointed and awaiting worker_done', {
        state: 'awaiting_worker_done',
        effects: [...effects, 'drain'],
        checkpointId,
        extra: evaluation
      })
    }
    return this.decide(true, 'observe', 'approaching limit: checkpointed; still running', {
      state: 'running',
      effects,
      checkpointId,
      extra: evaluation
    })
  }
}
