import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { startFederatedWorker } from './federated-worker-start'

const LIVEWELL_KEY = 'github.com/livewell/hub'

describe('federated worker start remote placement mapping', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
    vi.restoreAllMocks()
  })

  it('translates One visible /root to the M5 checkout instead of Hermes or path:/root', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'm5 placement',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'm5-mac',
      name: 'M5',
      peerFingerprint: 'm5_peer',
      pairingRevision: 11
    })
    vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
      worktrees: [
        {
          id: 'root-folder::/root',
          path: '/root',
          repoId: 'root-folder',
          hostId: 'local',
          displayName: 'root'
        },
        {
          id: 'hermes::/root/.hermes',
          path: '/root/.hermes',
          repoId: 'hermes',
          hostId: 'local',
          displayName: 'Hermes'
        }
      ],
      totalCount: 2,
      truncated: false
    } as never)
    vi.spyOn(runtime, 'listRepos').mockReturnValue([
      { id: 'root-folder', path: '/root', displayName: 'root', kind: 'folder' },
      {
        id: 'hermes',
        path: '/root/.hermes',
        displayName: 'Hermes',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/hermes-agent/hermes',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/hermes-agent/hermes.git'
        }
      }
    ] as never)
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        if (method === 'worktree.list') {
          return {
            worktrees: [
              {
                id: 'hub-m5::/Users/oliver/hub',
                path: '/Users/oliver/hub',
                repoId: 'hub-m5',
                hostId: 'local',
                displayName: 'hub'
              },
              {
                id: 'hermes-m5::/Users/oliver/.hermes',
                path: '/Users/oliver/.hermes',
                repoId: 'hermes-m5',
                hostId: 'local',
                displayName: 'Hermes'
              }
            ]
          }
        }
        if (method === 'repo.list') {
          return {
            repos: [
              {
                id: 'hub-m5',
                path: '/Users/oliver/hub',
                displayName: 'hub',
                gitRemoteIdentity: {
                  canonicalKey: LIVEWELL_KEY,
                  remoteName: 'origin',
                  remoteUrl: `https://${LIVEWELL_KEY}.git`
                }
              },
              {
                id: 'hermes-m5',
                path: '/Users/oliver/.hermes',
                displayName: 'Hermes',
                gitRemoteIdentity: {
                  canonicalKey: 'github.com/hermes-agent/hermes',
                  remoteName: 'origin',
                  remoteUrl: 'https://github.com/hermes-agent/hermes.git'
                }
              }
            ]
          }
        }
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          state: 'ready',
          runtimeEpoch: 'm5-runtime',
          worktreeId: 'hub-m5::/Users/oliver/hub',
          terminalHandle: 'term_m5',
          launch: {
            requested: { agent: 'codex', model: null, effort: null },
            effective: { agent: 'codex', model: null, effort: null }
          }
        }
      })

    const result = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'M5',
        worktree: 'path:/root',
        agent: 'codex'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'm5_root_map',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })) as { state: string }

    expect(result.state).toBe('ready')
    const attach = remoteCall.mock.calls.find((call) => call[1] === 'orchestration.federationAttachStart')
    expect(attach?.[2]).toMatchObject({
      worktree: 'id:hub-m5::/Users/oliver/hub'
    })
    expect(JSON.stringify(attach?.[2])).not.toContain('path:/root')
    expect(JSON.stringify(attach?.[2])).not.toMatch(/hermes/i)
  })
})
