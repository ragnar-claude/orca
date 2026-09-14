import { describe, expect, it } from 'vitest'
import {
  EXACT_ORCA_PATH,
  CHECKPOINT_TASK_STATUSES,
  CONTEXT_REMAINING_ROTATION_THRESHOLD_PERCENT,
  CONTEXT_USED_ROTATION_THRESHOLD_PERCENT,
  LOCAL_MODEL_INPUT_BUDGET_TOKENS,
  MODULE_ROOT,
  SERVING_PROMOTION_CONTRACT,
  SERVING_PROMOTION_HOOK,
  WORKTREE,
  assertSoleSourceOwner,
  admitPrelaunchContext,
  closeThenArchive,
  fenceGeneration,
  enumerateCheckpointTasks,
  evaluateRotationTelemetry,
  parseContextTelemetry,
  planCheckpointNotification,
  planMailboxPreflight,
  replacementLaunchCommand,
  selectCoordinatorReplacement,
  tokenTrigger,
  verifyFreshTakeover,
  workersPreserved
} from './rotation-watchdog-adapter'

const peek = (
  ids: string[],
  generation = 7
): {
  messageIds: string[]
  acknowledged: false
  consumerGeneration: number
} => ({
  messageIds: ids,
  acknowledged: false,
  consumerGeneration: generation
})

describe('serving promotion contract', () => {
  it('names the exact One path and coordinator-loop hook', () => {
    expect(EXACT_ORCA_PATH).toBe('/root')
    expect(MODULE_ROOT).toBe('/root/orca-control/rotation-watchdog')
    expect(SERVING_PROMOTION_HOOK).toBe(
      'src/main/runtime/orchestration/rotation-watchdog-adapter.ts'
    )
    expect(SERVING_PROMOTION_CONTRACT.coordinator_loop).toBe(
      'src/main/runtime/orchestration/coordinator.ts'
    )
    expect(SERVING_PROMOTION_CONTRACT.stop_on_source_ownership_overlap).toBe(true)
    expect(SERVING_PROMOTION_CONTRACT.close_precedes_archive).toBe(true)
    expect(WORKTREE).toContain('/root')
    expect(replacementLaunchCommand('explicit-model')[0]).toBe('codex')
  })
})

describe('quota-aware replacement selection', () => {
  it('avoids exhausted Kimi and selects the next live capable provider', () => {
    expect(
      selectCoordinatorReplacement([
        {
          agent: 'kimi',
          model: 'k3',
          available: true,
          coordinatorCapable: true,
          quotaStatus: 'exhausted'
        },
        {
          agent: 'codex',
          model: 'gpt-5.6',
          available: true,
          coordinatorCapable: true
        }
      ])
    ).toMatchObject({ agent: 'codex', model: 'gpt-5.6' })
  })

  it('fails closed when Kimi quota is unknown and no alternative is admissible', () => {
    expect(() =>
      selectCoordinatorReplacement([
        {
          agent: 'kimi',
          model: 'k3',
          available: true,
          coordinatorCapable: true,
          quotaStatus: 'unknown'
        }
      ])
    ).toThrow(/no live coordinator-capable provider/)
  })
})

describe('mailbox preflight', () => {
  it('allows newly arrived mail and never acks', () => {
    const result = planMailboxPreflight({
      checkpointMessageIds: ['msg_preserved'],
      checkpointAcknowledged: false,
      checkpointGeneration: 7,
      firstPeek: peek(['msg_preserved']),
      secondPeek: peek(['msg_preserved', 'msg_raced'])
    })
    expect(result.ok).toBe(true)
    expect(result.acknowledgementPerformed).toBe(false)
    expect(result.mailArrivedDuringPreflight).toEqual(['msg_raced'])
  })

  it('goes red when checkpointed mail disappears', () => {
    expect(() =>
      planMailboxPreflight({
        checkpointMessageIds: ['msg_preserved'],
        checkpointAcknowledged: false,
        checkpointGeneration: 7,
        firstPeek: peek(['different']),
        secondPeek: peek(['different'])
      })
    ).toThrow(/not preserved/)
  })

  it('goes red on generation drift', () => {
    expect(() =>
      planMailboxPreflight({
        checkpointMessageIds: ['msg_preserved'],
        checkpointAcknowledged: false,
        checkpointGeneration: 7,
        firstPeek: peek(['msg_preserved'], 7),
        secondPeek: peek(['msg_preserved'], 8)
      })
    ).toThrow(/generation/)
  })
})

describe('generation fence and takeover', () => {
  it('fences before execution', () => {
    expect(fenceGeneration(7, 7)).toBe(7)
    expect(() => fenceGeneration(8, 7)).toThrow(/generation fence/)
  })

  it('requires a strictly newer replacement coordinator', () => {
    const ok = verifyFreshTakeover({
      runId: 'run_test',
      expectedRunId: 'run_test',
      replacementHandle: 'term_new',
      liveHandle: 'term_new',
      priorGeneration: 7,
      liveGeneration: 8
    })
    expect(ok.consumerGeneration).toBe(8)
    expect(() =>
      verifyFreshTakeover({
        runId: 'run_test',
        expectedRunId: 'run_test',
        replacementHandle: 'term_new',
        liveHandle: 'term_new',
        priorGeneration: 7,
        liveGeneration: 7
      })
    ).toThrow(/generation/)
  })
})

describe('handoff, archive, overlap, workers', () => {
  it('emits a handoff checkpoint notification', () => {
    const note = planCheckpointNotification({
      triggered: true,
      reasons: ['token_threshold'],
      recipient: 'term_old'
    })
    expect(note.type).toBe('handoff')
    expect(note.planned).toBe(true)
  })

  it('closes then archives and refuses archive-first', () => {
    expect(
      closeThenArchive({
        oldHandle: 'term_old',
        closed: true,
        stillListed: false
      })
    ).toEqual({
      closed: true,
      archived: true,
      closePrecededArchive: true
    })
    expect(() =>
      closeThenArchive({
        oldHandle: 'term_old',
        closed: false,
        stillListed: true
      })
    ).toThrow(/close must precede archive/)
  })

  it('stops on source ownership overlap', () => {
    expect(() =>
      assertSoleSourceOwner({
        owner: 'task_7a1e3b9380bc',
        lockOwner: 'someone_else',
        foreignAdapterExists: false
      })
    ).toThrow(/overlap/)
    expect(
      assertSoleSourceOwner({
        owner: 'task_7a1e3b9380bc',
        lockOwner: 'task_7a1e3b9380bc',
        foreignAdapterExists: false
      }).ok
    ).toBe(true)
  })

  it('preserves active workers', () => {
    expect(workersPreserved(['ctx_live'], ['ctx_live']).ok).toBe(true)
    expect(() => workersPreserved(['ctx_live'], ['ctx_other'])).toThrow(/workers/)
  })
})

describe('provider-neutral rotation telemetry', () => {
  it('preserves Qwen numeric and Claude percentage evidence', () => {
    expect(parseContextTelemetry('footer 12.5K / 65.536K')).toMatchObject({
      telemetryStatus: 'available',
      telemetrySource: 'qwen_numeric_footer',
      currentInputTokens: 12_500,
      contextWindowTokens: 65_536
    })
    expect(parseContextTelemetry('Context left until auto-compact: 19%')).toMatchObject({
      telemetryStatus: 'available',
      telemetrySource: 'claude_context_remaining_footer',
      contextRemainingPercent: 19
    })
    expect(CONTEXT_REMAINING_ROTATION_THRESHOLD_PERCENT).toBe(50)
    expect(CONTEXT_USED_ROTATION_THRESHOLD_PERCENT).toBe(50)
  })

  it('does not rotate at 120000 used tokens in a 500K window', () => {
    expect(tokenTrigger(120_000, 500_000)).toBe(false)
    expect(
      evaluateRotationTelemetry({
        newInputTokens: 120_000,
        contextWindowTokens: 500_000,
        telemetryStatus: 'available',
        telemetrySource: '500k_fixture'
      })
    ).toMatchObject({
      shouldRotate: false,
      triggeredReasons: [],
      observations: { contextPressure: false, telemetryUnavailable: false }
    })
  })

  it('rotates at exactly 50 percent used and stays quiet immediately below', () => {
    expect(tokenTrigger(250_000, 500_000)).toBe(true)
    expect(tokenTrigger(249_999, 500_000)).toBe(false)
    expect(
      evaluateRotationTelemetry({
        newInputTokens: 250_000,
        contextWindowTokens: 500_000,
        telemetryStatus: 'available',
        telemetrySource: '500k_boundary_fixture'
      })
    ).toMatchObject({
      shouldRotate: true,
      triggeredReasons: ['context_pressure']
    })
  })

  it('preserves telemetry, connection, compaction, refusal, and stall emergencies', () => {
    const baseline = {
      newInputTokens: 120_000,
      contextWindowTokens: 500_000,
      telemetryStatus: 'available' as const,
      telemetrySource: 'emergency_fixture'
    }
    const cases = {
      telemetry_unavailable: {
        telemetryStatus: 'unavailable' as const,
        telemetrySource: 'terminal_footer'
      },
      disconnect: { ...baseline, connectionLost: true },
      post_compaction: { ...baseline, postCompaction: true },
      refusal: { ...baseline, refusal: true },
      stall: { ...baseline, stall: true }
    }
    for (const [reason, metrics] of Object.entries(cases)) {
      expect(evaluateRotationTelemetry(metrics), reason).toMatchObject({
        shouldRotate: true,
        triggeredReasons: [reason]
      })
    }
  })

  it('rotates at exactly 50 percent remaining but not immediately above it', () => {
    expect(
      evaluateRotationTelemetry({
        contextRemainingPercent: CONTEXT_REMAINING_ROTATION_THRESHOLD_PERCENT,
        telemetryStatus: 'available',
        telemetrySource: 'boundary_fixture'
      })
    ).toMatchObject({
      shouldRotate: true,
      triggeredReasons: ['context_pressure'],
      observations: { contextPressure: true }
    })
    expect(
      evaluateRotationTelemetry({
        contextRemainingPercent: CONTEXT_REMAINING_ROTATION_THRESHOLD_PERCENT + 0.01,
        telemetryStatus: 'available',
        telemetrySource: 'boundary_fixture'
      })
    ).toMatchObject({
      shouldRotate: false,
      triggeredReasons: [],
      observations: {
        contextPressure: false,
        telemetryUnavailable: false
      }
    })
  })

  it('fails closed without manufacturing a false zero', () => {
    const telemetry = parseContextTelemetry('Codex footer without a numeric context signal')
    expect(telemetry).toMatchObject({
      telemetryStatus: 'unavailable',
      currentInputTokens: null,
      telemetryEvidence: null
    })
    expect(
      evaluateRotationTelemetry({
        newInputTokens: telemetry.currentInputTokens,
        contextRemainingPercent: telemetry.contextRemainingPercent,
        telemetryStatus: telemetry.telemetryStatus,
        telemetrySource: telemetry.telemetrySource
      })
    ).toMatchObject({
      shouldRotate: true,
      triggeredReasons: ['telemetry_unavailable'],
      observations: { telemetryUnavailable: true, contextPressure: false }
    })
  })

  it('upgrades a legacy zero without source to unavailable', () => {
    expect(evaluateRotationTelemetry({ newInputTokens: 0 })).toMatchObject({
      shouldRotate: true,
      triggeredReasons: ['telemetry_unavailable']
    })
  })
})

describe('prelaunch context admission', () => {
  const loaded = [
    {
      id: 'qwen/qwen3-coder-30b',
      state: 'loaded',
      loadedContextLength: 65_536
    }
  ]

  it('preserves tool/output headroom before admitting a loaded model', () => {
    expect(LOCAL_MODEL_INPUT_BUDGET_TOKENS).toBe(49_152)
    expect(
      admitPrelaunchContext({
        inventoryStatus: 'available',
        records: loaded,
        spec: 'bounded'
      })
    ).toMatchObject({
      ok: true,
      selectedModel: 'qwen/qwen3-coder-30b',
      effectsApplied: false,
      splitRequired: false
    })
  })

  it('fails before effects on unavailable inventory and unsafe context', () => {
    expect(
      admitPrelaunchContext({
        inventoryStatus: 'endpoint_unreachable',
        records: null
      })
    ).toMatchObject({
      ok: false,
      status: 'endpoint_unreachable',
      effectsApplied: false
    })
    expect(
      admitPrelaunchContext({
        model: 'qwen/qwen3-coder-30b',
        inventoryStatus: 'available',
        records: loaded,
        spec: 'x'.repeat(LOCAL_MODEL_INPUT_BUDGET_TOKENS * 4 + 1)
      })
    ).toMatchObject({
      ok: false,
      status: 'context_unsafe',
      effectsApplied: false,
      splitRequired: true,
      requiredChunks: 2
    })
  })
})

describe('bounded checkpoint task enumeration', () => {
  it('falls back to complete status shards and deduplicates more than 500 rows', () => {
    const pending = Array.from({ length: 250 }, (_, index) => ({
      id: `pending_${index}`
    }))
    const ready = Array.from({ length: 200 }, (_, index) => ({
      id: `ready_${index}`
    }))
    const blocked = Array.from({ length: 151 }, (_, index) => ({
      id: `blocked_${index}`
    }))
    ready.push(pending[0])
    const rows = enumerateCheckpointTasks({
      aggregate: { tasks: [], truncated: true },
      shards: {
        pending: { tasks: pending },
        ready: { tasks: ready },
        blocked: { tasks: blocked }
      }
    })
    expect(CHECKPOINT_TASK_STATUSES).toEqual(['pending', 'ready', 'blocked'])
    expect(rows).toHaveLength(601)
    expect(new Set(rows.map((row) => row.id)).size).toBe(601)
  })

  it('goes red on a missing or truncated shard', () => {
    expect(() =>
      enumerateCheckpointTasks({
        aggregate: null,
        shards: {
          pending: { tasks: [] },
          ready: { tasks: [] },
          blocked: { tasks: [], truncated: true }
        }
      })
    ).toThrow(/incomplete task-list shard/)
  })
})
