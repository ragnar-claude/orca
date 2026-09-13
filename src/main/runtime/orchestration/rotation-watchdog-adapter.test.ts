import { describe, expect, it } from 'vitest'
import {
  EXACT_ORCA_PATH,
  MODULE_ROOT,
  SERVING_PROMOTION_CONTRACT,
  SERVING_PROMOTION_HOOK,
  TOKEN_ROTATION_THRESHOLD,
  WORKTREE,
  assertSoleSourceOwner,
  closeThenArchive,
  fenceGeneration,
  planCheckpointNotification,
  planMailboxPreflight,
  replacementLaunchCommand,
  tokenTrigger,
  verifyFreshTakeover,
  workersPreserved
} from './rotation-watchdog-adapter'

const peek = (
  ids: string[],
  generation = 7
): { messageIds: string[]; acknowledged: false; consumerGeneration: number } => ({
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
    expect(tokenTrigger(TOKEN_ROTATION_THRESHOLD)).toBe(true)
    expect(tokenTrigger(TOKEN_ROTATION_THRESHOLD - 1)).toBe(false)
  })

  it('closes then archives and refuses archive-first', () => {
    expect(closeThenArchive({ oldHandle: 'term_old', closed: true, stillListed: false })).toEqual({
      closed: true,
      archived: true,
      closePrecededArchive: true
    })
    expect(() =>
      closeThenArchive({ oldHandle: 'term_old', closed: false, stillListed: true })
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
