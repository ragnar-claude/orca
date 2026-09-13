import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { LocalLmStudioAdmission } from './local-lm-studio-admission'

vi.mock('./worker-start-validation', () => ({
  prepareLocalWorkerStart: () => ({
    agent: 'opencode',
    launch: {
      receipt: {
        requested: { agent: 'opencode', model: null, effort: null },
        effective: { agent: 'opencode', model: null, effort: null }
      },
      preferences: undefined
    }
  })
}))

vi.mock('../../orchestration-caller-workspace', () => ({
  resolveDispatchCallerWorktreeId: async () => {
    throw new Error('worktree lookup must not run after admission refusal')
  }
}))

const { startLocalWorker } = await import('./local-worker-start')

function fakes() {
  const createStartingWorkerDispatch = vi.fn(() => ({
    dispatch: { id: 'd_should_not_exist' },
    task: { id: 't1', spec: 'do the thing' }
  }))
  const runtime = {
    showManagedTerminalWorkspace: vi.fn(async () => {
      throw new Error('worktree must not be resolved after admission refusal')
    }),
    getNestedWorkerMaxDepth: () => 3,
    getRuntimeId: () => 'epoch-1',
    getTerminalProcessIncarnation: () => 'inc_1',
    validateOrchestrationAgentLauncher: vi.fn()
  } as unknown as OrcaRuntimeService
  const db = {
    createStartingWorkerDispatch
  } as unknown as OrchestrationDb
  return { runtime, db, createStartingWorkerDispatch }
}

function refusal(status: LocalLmStudioAdmission['status']): LocalLmStudioAdmission {
  return {
    ok: false,
    status,
    selectedModel: null,
    fallbacks: ['qwen/qwen3-coder-30b', 'qwen/qwen3-coder-next'],
    inventoryFetches: 1,
    effectsApplied: false,
    contextWindowTokens: 65_536,
    inputBudgetTokens: 49_152,
    reservedToolTokens: 8_192,
    reservedOutputTokens: 8_192,
    estimatedInputTokens: 0,
    splitRequired: false,
    requiredChunks: 1
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('local worker-start LM Studio admission runs before resource allocation', () => {
  async function expectNoAllocation(status: LocalLmStudioAdmission['status']) {
    const { runtime, db, createStartingWorkerDispatch } = fakes()
    const admitLocalLmStudio = vi.fn(async () => {
      throw new OrchestrationError(
        status,
        `LM Studio admission refused worker-start (${status}). No Dispatch, worktree, or terminal effects were applied.`,
        { effectsApplied: false }
      )
    })

    await expect(
      startLocalWorker({
        params: { from: 'term_c', timeoutMs: 1_000, agent: 'opencode' } as never,
        mode: {
          mode: 'structured',
          preferred: 'structured',
          reason: 'user_default',
          detail: 'structured by default'
        } as const,
        runtime,
        db,
        run: { id: 'run_1' } as never,
        existingTask: { id: 't1', spec: 'do the thing' } as never,
        coordinatorPane: null,
        admitLocalLmStudio
      })
    ).rejects.toMatchObject({ code: status, data: { effectsApplied: false } })

    expect(createStartingWorkerDispatch).not.toHaveBeenCalled()
    expect(admitLocalLmStudio).toHaveBeenCalledTimes(1)
    return { createStartingWorkerDispatch, admitLocalLmStudio }
  }

  it('does not call createStartingWorkerDispatch on endpoint_unreachable', async () => {
    await expectNoAllocation('endpoint_unreachable')
  })

  it('does not call createStartingWorkerDispatch on malformed_response', async () => {
    await expectNoAllocation('malformed_response')
  })

  it('does not call createStartingWorkerDispatch on model_absent', async () => {
    await expectNoAllocation('model_absent')
  })

  it('does not call createStartingWorkerDispatch on context_unsafe', async () => {
    await expectNoAllocation('context_unsafe')
  })

  it('uses injected inventory-less refusal without touching worktree APIs', async () => {
    const { runtime, db, createStartingWorkerDispatch } = fakes()
    await expect(
      startLocalWorker({
        params: {
          from: 'term_c',
          timeoutMs: 1_000,
          agent: 'opencode',
          model: 'lmstudio/qwen/qwen3-coder-30b'
        } as never,
        mode: {
          mode: 'terminal',
          preferred: 'terminal',
          reason: 'user_default',
          detail: 'terminal'
        } as const,
        runtime,
        db,
        run: { id: 'run_1' } as never,
        coordinatorPane: null,
        admitLocalLmStudio: async () => {
          throw new OrchestrationError('endpoint_unreachable', 'down', {
            effectsApplied: false
          })
        }
      })
    ).rejects.toMatchObject({ code: 'endpoint_unreachable' })
    expect(createStartingWorkerDispatch).not.toHaveBeenCalled()
    expect(runtime.showManagedTerminalWorkspace).not.toHaveBeenCalled()
    expect(refusal('endpoint_unreachable').effectsApplied).toBe(false)
  })
})
