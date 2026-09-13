import { describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { startFederatedWorker } from './federated-worker-start'

describe('federated worker-start LM Studio admission', () => {
  it.each(['endpoint_unreachable', 'model_absent', 'context_unsafe'])(
    'refuses %s before the home Dispatch or any remote/worktree/terminal call',
    async (status) => {
      const createStartingWorkerDispatch = vi.fn()
      const resolveOrchestrationWorkerServer = vi.fn()
      const callOrchestrationWorkerServer = vi.fn()
      const runtime = {
        getNestedWorkerMaxDepth: () => 3,
        getRuntimeId: () => 'epoch-1',
        validateOrchestrationAgentLauncher: vi.fn(),
        resolveOrchestrationWorkerServer,
        callOrchestrationWorkerServer
      } as unknown as OrcaRuntimeService
      const db = { createStartingWorkerDispatch } as unknown as OrchestrationDb

      await expect(
        startFederatedWorker({
          params: {
            from: 'term_coordinator',
            on: 'm5max',
            worktree: 'id:one::/root',
            agent: 'opencode',
            model: 'lmstudio/qwen/qwen3-coder-30b',
            timeoutMs: 60_000
          } as never,
          runtime,
          db,
          runId: 'run_1',
          task: { id: 'task_1', spec: 'bounded task', status: 'pending' },
          orchestrationMutation: {
            callerFingerprint: 'peer-1',
            requestId: 'request-1',
            method: 'orchestration.workerStart',
            payloadHash: 'payload-1'
          },
          admitLocalLmStudio: async () => {
            throw new OrchestrationError(status, 'refused before allocation', {
              effectsApplied: false
            })
          }
        })
      ).rejects.toMatchObject({ code: status, data: { effectsApplied: false } })

      expect(createStartingWorkerDispatch).not.toHaveBeenCalled()
      expect(resolveOrchestrationWorkerServer).not.toHaveBeenCalled()
      expect(callOrchestrationWorkerServer).not.toHaveBeenCalled()
    }
  )
})
