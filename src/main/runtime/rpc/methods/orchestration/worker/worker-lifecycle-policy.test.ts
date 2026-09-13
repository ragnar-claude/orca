import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  EXACT_ORCA_PATH,
  ENV_INCARNATION,
  ENV_SESSION,
  MODULE_ROOT,
  SERVING_PROMOTION_CONTRACT,
  SERVING_PROMOTION_HOOK,
  SIGTERM,
  WorkerLifecyclePolicy,
  asCheckpointWriterKwargs,
  evaluateThresholds,
  identityComplete,
  readLinuxProcessTable,
  reapFromProcessCount,
  reconcileOrphans,
  type Limits,
  type PositiveIdentity,
  type ProcRecord,
  type ResidualHandoff
} from './worker-lifecycle-policy'

function identity(overrides: Partial<PositiveIdentity> = {}): PositiveIdentity {
  return {
    cwd: '/root',
    sessionId: 'sess_test_1',
    incarnation: 'inc_test_1',
    pgid: 4242,
    ...overrides
  }
}

const TEST_LIMITS: Limits = {
  ...DEFAULT_LIMITS,
  contextWindowTokens: 1000,
  maxAgeSeconds: 100,
  cpuPercentCap: 100,
  ramBytesCap: 1000
}

function policy(
  overrides: Partial<ConstructorParameters<typeof WorkerLifecyclePolicy>[0]> = {}
): WorkerLifecyclePolicy {
  return new WorkerLifecyclePolicy({
    workerId: 'worker_test',
    terminalHandle: 'term_test',
    identity: identity(),
    limits: TEST_LIMITS,
    clock: () => 0,
    dispatchId: 'ctx_test',
    runId: 'run_test',
    processTable: [],
    liveParentPids: [],
    ...overrides
  })
}

function writeProc(
  procRoot: string,
  args: {
    pid: number
    ppid: number
    pgid: number
    cwd: string | null
    sessionId: string | null
    incarnation: string | null
    comm?: string
  }
): void {
  const dir = join(procRoot, String(args.pid))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'stat'),
    `${args.pid} (${args.comm ?? 'worker'}) S ${args.ppid} ${args.pgid} ${args.pgid} 0 0 0 0 0 0 0 0 0\n`
  )
  if (args.cwd) {
    mkdirSync(args.cwd, { recursive: true })
    symlinkSync(args.cwd, join(dir, 'cwd'))
  }
  const env: string[] = []
  if (args.sessionId) {
    env.push(`${ENV_SESSION}=${args.sessionId}`)
  }
  if (args.incarnation) {
    env.push(`${ENV_INCARNATION}=${args.incarnation}`)
  }
  env.push('PATH=/usr/bin')
  writeFileSync(join(dir, 'environ'), Buffer.from(`${env.join('\0')}\0`))
}

describe('serving promotion contract', () => {
  it('names the exact One path and hook', () => {
    expect(EXACT_ORCA_PATH).toBe('/root')
    expect(MODULE_ROOT).toBe('/root/orca-control/worker-lifecycle-policy')
    expect(SERVING_PROMOTION_HOOK).toBe(
      'src/main/runtime/rpc/methods/orchestration/worker/worker-lifecycle-policy.ts'
    )
    expect(SERVING_PROMOTION_CONTRACT.exact_orca_path).toBe('/root')
    expect(SERVING_PROMOTION_CONTRACT.one_bounded_task_per_worker).toBe(true)
    expect(SERVING_PROMOTION_CONTRACT.checkpoint_before_limits).toBe(true)
  })
})

describe('thresholds', () => {
  it('under threshold is ok', () => {
    const ev = evaluateThresholds(
      { contextTokens: 100, ageSeconds: 10, cpuPercent: 10, ramBytes: 100 },
      TEST_LIMITS
    )
    expect(ev.worst).toBe('ok')
    expect(ev.hard).toEqual([])
    expect(ev.approaching).toEqual([])
  })

  it('context checkpoint band', () => {
    const ev = evaluateThresholds(
      { contextTokens: 800, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 },
      TEST_LIMITS
    )
    expect(ev.worst).toBe('checkpoint')
    expect(ev.approaching).toEqual(['context'])
  })

  it('age cpu ram checkpoint bands', () => {
    expect(
      evaluateThresholds(
        { contextTokens: 0, ageSeconds: 80, cpuPercent: 0, ramBytes: 0 },
        TEST_LIMITS
      ).approaching
    ).toContain('age')
    expect(
      evaluateThresholds(
        { contextTokens: 0, ageSeconds: 0, cpuPercent: 80, ramBytes: 0 },
        TEST_LIMITS
      ).approaching
    ).toContain('cpu')
    expect(
      evaluateThresholds(
        { contextTokens: 0, ageSeconds: 0, cpuPercent: 0, ramBytes: 800 },
        TEST_LIMITS
      ).approaching
    ).toContain('ram')
  })

  it('hard beats checkpoint', () => {
    const ev = evaluateThresholds(
      { contextTokens: 950, ageSeconds: 80, cpuPercent: 0, ramBytes: 0 },
      TEST_LIMITS
    )
    expect(ev.worst).toBe('hard')
    expect(ev.hard).toEqual(['context'])
    expect(ev.approaching).toEqual(['age'])
  })
})

describe('one bounded task per worker', () => {
  it('idle bind start running', () => {
    const p = policy()
    expect(p.state).toBe('idle')
    expect(p.bind('task_one').allowed).toBe(true)
    expect(p.state).toBe('bound')
    expect(p.start().allowed).toBe(true)
    expect(p.state).toBe('running')
  })

  it('second bind refused', () => {
    const p = policy()
    p.bind('task_one')
    const d = p.bind('task_two')
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('one bounded task')
    expect(p.taskId).toBe('task_one')
  })

  it('start without bind refused', () => {
    expect(policy().start().allowed).toBe(false)
  })

  it('empty task id refused', () => {
    const p = policy()
    expect(p.bind('').allowed).toBe(false)
    expect(p.state).toBe('idle')
  })

  it('cannot rebind after archive', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.receiveWorkerDone({ taskId: 'task_one', dispatchId: 'ctx_test', outcome: 'succeeded' })
    p.release()
    p.close()
    p.archive()
    expect(p.bind('task_two').allowed).toBe(false)
  })

  it('is provider agnostic', () => {
    const p = policy()
    expect(p.bind('task_one').allowed).toBe(true)
    expect(p.start().allowed).toBe(true)
    expect(identityComplete(identity())).toBe(true)
    expect(identityComplete(identity({ cwd: '' }))).toBe(false)
  })

  it('incomplete identity cannot construct policy', () => {
    expect(
      () =>
        new WorkerLifecyclePolicy({
          workerId: 'w',
          terminalHandle: 't',
          identity: identity({ pgid: 0 })
        })
    ).toThrow(/identity/)
  })
})

describe('checkpoint before limits', () => {
  it('under threshold stays running with no checkpoint', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.observe({ contextTokens: 10, ageSeconds: 1, cpuPercent: 1, ramBytes: 10 })
    expect(d.allowed).toBe(true)
    expect(p.state).toBe('running')
    expect(p.checkpoints).toEqual([])
    expect(d.effects).toEqual([])
  })

  it('approaching context checkpoints then keeps running', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.observe({ contextTokens: 800, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 })
    expect(d.allowed).toBe(true)
    expect(p.state).toBe('running')
    expect(d.effects).toEqual(['checkpointed'])
    expect(p.checkpoints).toHaveLength(1)
    expect(d.reason).toContain('approaching limit')
    expect(d.checkpointId).toBeTruthy()
  })

  it('hard limit checkpoints then awaits worker_done', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.observe({ contextTokens: 960, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 })
    expect(d.allowed).toBe(true)
    expect(p.state).toBe('awaiting_worker_done')
    expect(d.effects).toContain('checkpointed')
    expect(d.effects).toContain('drain')
    expect(p.checkpoints).toHaveLength(1)
  })

  it('hard without prior checkpoint still checkpoints first', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.observe({ contextTokens: 0, ageSeconds: 0, cpuPercent: 100, ramBytes: 0 })
    expect(p.state).toBe('awaiting_worker_done')
    expect(p.checkpoints.length).toBeGreaterThan(0)
    expect(d.checkpointId).toBeTruthy()
  })

  it('age and ram approaching checkpoint', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.observe({ contextTokens: 0, ageSeconds: 85, cpuPercent: 0, ramBytes: 850 })
    expect(p.state).toBe('running')
    expect(new Set(d.extra.approaching as string[])).toEqual(new Set(['age', 'ram']))
    expect(p.checkpoints).toHaveLength(1)
  })

  it('observe after hard drain refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.observe({ contextTokens: 999, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 })
    const d = p.observe({ contextTokens: 10, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 })
    expect(d.allowed).toBe(false)
    expect(p.state).toBe('awaiting_worker_done')
  })

  it('duplicate same band does not double checkpoint', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.observe({ contextTokens: 810, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 })
    p.observe({ contextTokens: 820, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 })
    expect(p.checkpoints).toHaveLength(1)
  })
})

describe('worker_done then release close archive', () => {
  it('happy path order', () => {
    const p = policy()
    expect(p.bind('task_one').state).toBe('bound')
    expect(p.start().state).toBe('running')
    expect(
      p.receiveWorkerDone({ taskId: 'task_one', dispatchId: 'ctx_test', outcome: 'succeeded' })
        .state
    ).toBe('worker_done')
    expect(p.release().state).toBe('releasing')
    expect(p.close().state).toBe('closing')
    expect(p.archive().state).toBe('archived')
    expect(p.history.filter((row) => row.allowed).map((row) => row.action)).toEqual([
      'bind',
      'start',
      'worker_done',
      'release',
      'close',
      'archive'
    ])
  })

  it('release without worker_done refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.release()
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('worker_done required')
  })

  it('close before release refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.receiveWorkerDone({ taskId: 'task_one', dispatchId: 'ctx_test', outcome: 'succeeded' })
    const d = p.close()
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('release must precede close')
  })

  it('archive before close refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.receiveWorkerDone({ taskId: 'task_one', dispatchId: 'ctx_test', outcome: 'succeeded' })
    p.release()
    const d = p.archive()
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('close must precede archive')
  })

  it('worker_done task mismatch refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.receiveWorkerDone({
      taskId: 'task_other',
      dispatchId: 'ctx_test',
      outcome: 'succeeded'
    })
    expect(d.allowed).toBe(false)
    expect(p.state).toBe('running')
  })

  it('worker_done dispatch mismatch refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    expect(
      p.receiveWorkerDone({ taskId: 'task_one', dispatchId: 'ctx_other', outcome: 'succeeded' })
        .allowed
    ).toBe(false)
  })

  it('worker_done from awaiting accepted', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.observe({ contextTokens: 999, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 })
    const d = p.receiveWorkerDone({
      taskId: 'task_one',
      dispatchId: 'ctx_test',
      outcome: 'succeeded'
    })
    expect(d.allowed).toBe(true)
    expect(p.state).toBe('worker_done')
  })

  it('release close archive order is strict', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.receiveWorkerDone({ taskId: 'task_one', dispatchId: 'ctx_test', outcome: 'failed' })
    expect(p.release().allowed).toBe(true)
    expect(p.release().allowed).toBe(false)
    expect(p.close().allowed).toBe(true)
    expect(p.close().allowed).toBe(false)
    expect(p.archive().allowed).toBe(true)
    expect(p.state).toBe('archived')
    expect(p.released && p.closed && p.archived).toBe(true)
  })
})

describe('explicit residual handoff', () => {
  const residual: ResidualHandoff = {
    sourceTaskId: 'task_one',
    successorTaskId: 'task_followup',
    summary: 'finish report file',
    declaredBy: 'worker_done'
  }

  it('leftover without explicit handoff blocks release', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.receiveWorkerDone({
      taskId: 'task_one',
      dispatchId: 'ctx_test',
      outcome: 'succeeded',
      leftover: true
    })
    expect(d.allowed).toBe(true)
    expect(p.state).toBe('worker_done')
    const rel = p.release()
    expect(rel.allowed).toBe(false)
    expect(rel.reason).toContain('explicit residual')
  })

  it('explicit residual on worker_done allows release', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    const d = p.receiveWorkerDone({
      taskId: 'task_one',
      dispatchId: 'ctx_test',
      outcome: 'succeeded',
      leftover: true,
      residual
    })
    expect(d.state).toBe('residual_handoff')
    expect(d.effects).toContain('explicit_residual_handoff')
    expect(p.release().allowed).toBe(true)
  })

  it('declare residual after leftover worker_done', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.receiveWorkerDone({
      taskId: 'task_one',
      dispatchId: 'ctx_test',
      outcome: 'succeeded',
      leftover: true
    })
    const d = p.declareResidual({
      sourceTaskId: 'task_one',
      successorTaskId: 'task_followup',
      summary: 'handoff remaining files',
      declaredBy: 'coordinator'
    })
    expect(d.allowed).toBe(true)
    expect(p.state).toBe('residual_handoff')
    expect(p.release().allowed).toBe(true)
  })

  it('implicit residual without leftover refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.receiveWorkerDone({ taskId: 'task_one', dispatchId: 'ctx_test', outcome: 'succeeded' })
    const d = p.declareResidual({
      sourceTaskId: 'task_one',
      successorTaskId: 'task_followup',
      summary: 'invented leftover',
      declaredBy: 'worker'
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('implicit residual')
  })

  it('invalid residual same successor refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    expect(
      p.receiveWorkerDone({
        taskId: 'task_one',
        dispatchId: 'ctx_test',
        outcome: 'succeeded',
        leftover: true,
        residual: {
          sourceTaskId: 'task_one',
          successorTaskId: 'task_one',
          summary: 'loop',
          declaredBy: 'worker_done'
        }
      }).allowed
    ).toBe(false)
  })

  it('declare residual before worker_done refused', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    expect(
      p.declareResidual({
        sourceTaskId: 'task_one',
        successorTaskId: 'task_two',
        summary: 'too early',
        declaredBy: 'worker'
      }).allowed
    ).toBe(false)
  })
})

describe('positive-identity-only orphan reap', () => {
  const matched: ProcRecord = {
    pid: 10,
    pgid: 4242,
    ppid: 1,
    cwd: '/root',
    sessionId: 'sess_test_1',
    incarnation: 'inc_test_1',
    comm: 'x'
  }

  it('process count never authorizes reap', () => {
    const v = reapFromProcessCount(12)
    expect(v.action).toBe('refuse')
    expect(v.reason).toContain('process count')
  })

  it('incomplete claimed identity refused', () => {
    const v = reconcileOrphans({
      claimed: identity({ cwd: '' }),
      table: [],
      workerState: 'archived'
    })
    expect(v.action).toBe('refuse')
    expect(v.reason).toContain('incomplete')
  })

  it('cwd-only match refused', () => {
    const v = reconcileOrphans({
      claimed: identity(),
      table: [{ ...matched, sessionId: null, incarnation: null }],
      workerState: 'archived'
    })
    expect(v.action).toBe('refuse')
    expect(v.reason).toContain('unverifiable')
  })

  it('session-only refused', () => {
    const v = reconcileOrphans({
      claimed: identity(),
      table: [{ ...matched, cwd: null, incarnation: null }],
      workerState: 'archived'
    })
    expect(v.action).toBe('refuse')
  })

  it('incarnation-only refused', () => {
    const v = reconcileOrphans({
      claimed: identity(),
      table: [{ ...matched, cwd: null, sessionId: null }],
      workerState: 'archived'
    })
    expect(v.action).toBe('refuse')
  })

  it('pgid-only refused', () => {
    const v = reconcileOrphans({
      claimed: identity(),
      table: [{ ...matched, cwd: null, sessionId: null, incarnation: null }],
      workerState: 'archived'
    })
    expect(v.action).toBe('refuse')
    expect(v.reason).toContain('unverifiable')
  })

  it('live worker never reaped', () => {
    const v = reconcileOrphans({
      claimed: identity(),
      table: [matched],
      workerState: 'running'
    })
    expect(v.action).toBe('refuse')
    expect(v.reason).toContain('still live')
  })

  it('positive orphan pgid reap', () => {
    const v = reconcileOrphans({
      claimed: identity(),
      table: [matched],
      workerState: 'archived'
    })
    expect(v.action).toBe('reap')
    expect(v.pgid).toBe(4242)
    expect(v.matchedPids).toEqual([10])
  })

  it('pgid members disagree unverifiable', () => {
    const v = reconcileOrphans({
      claimed: identity(),
      table: [matched, { ...matched, pid: 11, cwd: '/tmp' }],
      workerState: 'archived'
    })
    expect(v.action).toBe('refuse')
    expect(v.reason).toContain('disagree')
  })

  it('wrong pgid not reaped', () => {
    const v = reconcileOrphans({
      claimed: identity(),
      table: [{ ...matched, pgid: 9999 }],
      workerState: 'archived'
    })
    expect(v.action).toBe('refuse')
    expect(v.reason).toContain('no process positively matched')
  })

  it('policy reconcile sends killpg only on positive orphan', () => {
    const killed: [number, number][] = []
    const p = policy({
      processTable: [matched],
      killpg: (pgid, signal) => {
        killed.push([pgid, signal])
      }
    })
    p.bind('task_one')
    p.start()
    p.receiveWorkerDone({ taskId: 'task_one', dispatchId: 'ctx_test', outcome: 'succeeded' })
    p.release()
    p.close()
    p.archive()
    const v = p.reconcile()
    expect(v.action).toBe('reap')
    expect(killed).toEqual([[4242, SIGTERM]])
  })

  it('policy reconcile does not kill while running', () => {
    const killed: [number, number][] = []
    const p = policy({
      processTable: [matched],
      killpg: (pgid, signal) => {
        killed.push([pgid, signal])
      }
    })
    p.bind('task_one')
    p.start()
    expect(p.reconcile().action).toBe('refuse')
    expect(killed).toEqual([])
  })
})

describe('linux process table', () => {
  it('reads fake proc and refuses missing cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'wl-proc-'))
    writeProc(root, {
      pid: 21,
      ppid: 1,
      pgid: 4242,
      cwd: null,
      sessionId: 'sess_test_1',
      incarnation: 'inc_test_1'
    })
    const table = readLinuxProcessTable(root)
    expect(table).toHaveLength(1)
    expect(table[0]?.cwd).toBeNull()
    const v = reconcileOrphans({
      claimed: identity(),
      table,
      workerState: 'archived'
    })
    expect(v.action).toBe('refuse')
  })

  it('positive identity from fake proc', () => {
    const root = mkdtempSync(join(tmpdir(), 'wl-proc-'))
    const cwd = join(root, 'cwd-root')
    writeProc(root, {
      pid: 22,
      ppid: 1,
      pgid: 4242,
      cwd,
      sessionId: 'sess_test_1',
      incarnation: 'inc_test_1'
    })
    const table = readLinuxProcessTable(root)
    expect(table[0]?.sessionId).toBe('sess_test_1')
    expect(table[0]?.incarnation).toBe('inc_test_1')
    expect(table[0]?.pgid).toBe(4242)
    const v = reconcileOrphans({
      claimed: identity({ cwd: table[0]!.cwd! }),
      table,
      workerState: 'archived'
    })
    expect(v.action).toBe('reap')
  })
})

describe('checkpoint writer adapter kwargs', () => {
  it('hard limit adapter asks for worker_done', () => {
    const p = policy()
    p.bind('task_one')
    p.start()
    p.observe({ contextTokens: 999, ageSeconds: 0, cpuPercent: 0, ramBytes: 0 })
    const kwargs = asCheckpointWriterKwargs(p.checkpoints.at(-1)!, {
      runId: 'run_contract',
      coordinatorHandle: 'term_c'
    })
    const actions = (kwargs.exact_next_actions as { action: string }[]).map((row) => row.action)
    expect(actions).toContain('await_worker_done')
    expect((kwargs.metadata as { exact_orca_path: string }).exact_orca_path).toBe('/root')
  })
})
