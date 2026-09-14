import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../orchestration/worker-terminal-release-reconciliation'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

function codexMessage(id: string, text: string): string {
  return JSON.stringify({
    timestamp: '2026-08-03T12:00:00.000Z',
    type: 'event_msg',
    payload: { id, type: 'agent_message', message: text }
  })
}

describe('orchestration worker release archive', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  it('automatically archives and releases the exact terminal after successful worker_done', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    const dispatchCapability = h.db.mintDispatchCapability({
      dispatchId,
      paneKey: h.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1'
    })

    const completion = (await h.call(
      'orchestration.send',
      {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      },
      { orchestrationCapability: dispatchCapability }
    )) as { lifecycle: { action: string } }

    expect(completion.lifecycle.action).toBe('completed')
    expect(h.db.getTask(taskId)?.status).toBe('completed')
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    await vi.waitFor(() => {
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'released',
        release_state: 'released',
        archive_source: 'terminal',
        archive_status: 'captured'
      })
    })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'already_released', processAction: 'none' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps accepted worker_done completed when the federated ownership lookup throws', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    const dispatchCapability = h.db.mintDispatchCapability({
      dispatchId,
      paneKey: h.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1'
    })
    const getFederatedDispatch = vi
      .spyOn(h.db, 'getFederatedDispatch')
      .mockImplementationOnce(() => {
        throw new Error('federated lookup exploded')
      })
    const requestRelease = vi.spyOn(h.db, 'requestWorkerTerminalRelease')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      h.call(
        'orchestration.send',
        {
          from: 'term_worker',
          to: 'term_coord',
          subject: 'Done despite ownership lookup failure',
          type: 'worker_done',
          payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
        },
        { orchestrationCapability: dispatchCapability }
      )
    ).resolves.toMatchObject({ lifecycle: { action: 'completed' } })
    expect(h.db.getTask(taskId)?.status).toBe('completed')
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    expect(getFederatedDispatch).toHaveBeenCalledTimes(2)
    expect(requestRelease).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('records durable retry intent when the automatic release request initially throws', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    const dispatchCapability = h.db.mintDispatchCapability({
      dispatchId,
      paneKey: h.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1'
    })
    const requestRelease = vi
      .spyOn(h.db, 'requestWorkerTerminalRelease')
      .mockImplementationOnce(() => {
        throw new Error('release request exploded')
      })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const close = h.deferred<never>()
    vi.mocked(h.runtime.closeTerminal).mockImplementationOnce(() => close.promise)
    const params = {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'Done despite cleanup failure',
      type: 'worker_done' as const,
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    }

    await expect(
      h.call('orchestration.send', params, { orchestrationCapability: dispatchCapability })
    ).resolves.toMatchObject({ lifecycle: { action: 'completed' } })
    expect(h.db.getTask(taskId)?.status).toBe('completed')
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    expect(requestRelease).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => {
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'releasing',
        archive_source: 'terminal',
        archive_status: 'captured'
      })
    })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    close.resolve({ handle: 'term_worker', tabId: 'tab-worker', ptyKilled: true } as never)
    await vi.waitFor(() => {
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    })

    await expect(
      h.call('orchestration.send', params, { orchestrationCapability: dispatchCapability })
    ).resolves.toMatchObject({
      lifecycle: { action: 'rejected', code: 'dispatch_capability_invalid' }
    })
    expect(requestRelease).toHaveBeenCalledTimes(2)
    expect(h.db.getTask(taskId)?.status).toBe('completed')
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('leaves federated completion behind the durable worker-release request guard', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    const dispatchCapability = h.db.mintDispatchCapability({
      dispatchId,
      paneKey: h.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1'
    })
    vi.spyOn(h.db, 'getFederatedDispatch').mockReturnValue({ dispatch_id: dispatchId } as never)
    const requestRelease = vi.spyOn(h.db, 'requestWorkerTerminalRelease')

    await expect(
      h.call(
        'orchestration.send',
        {
          from: 'term_worker',
          to: 'term_coord',
          subject: 'Federated done',
          type: 'worker_done',
          payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
        },
        { orchestrationCapability: dispatchCapability }
      )
    ).resolves.toMatchObject({ lifecycle: { action: 'completed' } })
    expect(requestRelease).not.toHaveBeenCalled()
    await expect(h.call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      'Remote worker-release requires a durable retry request.'
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('reconciles a durable releasing row after automatic post-commit close failure', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    const dispatchCapability = h.db.mintDispatchCapability({
      dispatchId,
      paneKey: h.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1'
    })
    vi.mocked(h.runtime.closeTerminal).mockRejectedValueOnce(
      new Error('Remote terminal stream is not connected')
    )

    await expect(
      h.call(
        'orchestration.send',
        {
          from: 'term_worker',
          to: 'term_coord',
          subject: 'Done before restart recovery',
          type: 'worker_done',
          payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
        },
        { orchestrationCapability: dispatchCapability }
      )
    ).resolves.toMatchObject({ lifecycle: { action: 'completed' } })
    await vi.waitFor(() => {
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'releasing',
        archive_source: 'terminal',
        archive_status: 'captured'
      })
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    })
    vi.mocked(h.runtime.closeTerminal).mockImplementationOnce(async () => {
      expect(h.db.getWorkerTerminalArchive(dispatchId)).toBeDefined()
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')
      return { handle: 'term_worker', tabId: 'tab-worker', ptyKilled: true } as never
    })

    await expect(reconcileRequestedWorkerTerminalReleases(h.runtime)).resolves.toMatchObject({
      attempted: 1,
      released: 1,
      pending: 0
    })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released',
      archive_source: 'terminal',
      archive_status: 'captured'
    })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(2)
  })

  it('records an explicitly empty archive for an already-exited worker process', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.showTerminal).mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', connected: false }) as never
    )
    vi.mocked(h.runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'exited',
      tail: [],
      truncated: false,
      nextCursor: null
    })
    const receipt = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
      archive: { status: string | null } | null
    }
    expect(receipt).toMatchObject({
      state: 'released',
      processAction: 'closed_exited_terminal',
      archive: { status: 'empty' }
    })
  })

  it('keeps a bounded tail when one terminal line exceeds the archive budget', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const suffix = 'meaningful-tail'
    vi.mocked(h.runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: [`${'x'.repeat(300_000)}${suffix}`],
      truncated: false,
      nextCursor: '1'
    })

    const release = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      archive: { status: string | null } | null
    }
    const read = (await h.call('orchestration.workerRead', { dispatch: dispatchId })) as {
      terminal: { tail: string[]; truncated: boolean }
      warnings: string[]
    }

    expect(release.archive?.status).toBe('captured')
    expect(read.terminal.tail).toHaveLength(1)
    expect(read.terminal.tail[0]).toMatch(new RegExp(`${suffix}$`))
    expect(read.terminal.truncated).toBe(true)
    expect(read.warnings).not.toContain(
      'The live terminal buffer was empty at release; structured transcript output was unavailable.'
    )
  })

  it('serves the frozen redacted archive through worker-read after release, with cursors', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['first line', `capability dcap_${'a'.repeat(24)} leaked`, 'last line'],
      draft: `send --dispatch-capability dcap_${'b'.repeat(24)}`,
      truncated: false,
      nextCursor: '3'
    })
    await h.call('orchestration.workerRelease', { dispatch: dispatchId })
    vi.mocked(h.runtime.readTerminal).mockClear()

    const page1 = (await h.call('orchestration.workerRead', {
      dispatch: dispatchId,
      limit: 2
    })) as {
      archived?: boolean
      terminal: { tail: string[]; draft?: string }
      cursor: string | null
    }
    expect(page1.terminal.tail).toEqual([
      'first line',
      'capability [dispatch capability redacted] leaked'
    ])
    expect(page1.terminal.draft).toBe('send --dispatch-capability [dispatch capability redacted]')
    expect(page1.cursor).not.toBeNull()

    const page2 = (await h.call('orchestration.workerRead', {
      dispatch: dispatchId,
      cursor: page1.cursor as string
    })) as { terminal: { tail: string[]; draft?: string }; cursor: string | null }
    expect(page2.terminal.tail).toEqual(['last line'])
    expect(page2.terminal.draft).toBeUndefined()
    expect(page2.cursor).toBeNull()
    // The live terminal is never consulted after release.
    expect(h.runtime.readTerminal).not.toHaveBeenCalled()
  })

  it('reads an immutable transcript snapshot after the provider file disappears', async () => {
    h.setup()
    const directory = await mkdtemp(join(tmpdir(), 'orca-worker-release-snapshot-'))
    const transcriptPath = join(directory, 'rollout.jsonl')
    try {
      await writeFile(
        transcriptPath,
        `${codexMessage('snapshot-one', 'frozen first')}\n${codexMessage('snapshot-two', 'frozen second')}\n`
      )
      vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
        agent: 'codex',
        processIncarnation: 'runtime_test:term_worker:1',
        providerSession: {
          key: 'codex:snapshot-session',
          id: 'snapshot-session',
          transcriptPath
        }
      } as never)
      const { dispatchId } = await h.startSettledWorker()
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })
      await rm(transcriptPath)

      const page = (await h.call('orchestration.workerRead', {
        dispatch: dispatchId,
        limit: 1
      })) as { cursor: string }
      expect(page).toMatchObject({
        archived: true,
        source: 'transcript',
        transcript: {
          messages: [{ id: 'snapshot-one', blocks: [{ type: 'text', text: 'frozen first' }] }]
        }
      })
      await expect(
        h.call('orchestration.workerRead', { dispatch: dispatchId, cursor: page.cursor })
      ).resolves.toMatchObject({
        transcript: {
          messages: [{ id: 'snapshot-two', blocks: [{ type: 'text', text: 'frozen second' }] }]
        }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves payload clipping metadata in the released transcript snapshot', async () => {
    h.setup()
    const directory = await mkdtemp(join(tmpdir(), 'orca-worker-release-clipped-snapshot-'))
    const transcriptPath = join(directory, 'rollout.jsonl')
    try {
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          timestamp: '2026-08-03T12:00:00.000Z',
          type: 'event_msg',
          payload: { id: 'clipped-message', type: 'agent_message', message: 'x'.repeat(5_000) }
        })}\n`
      )
      vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
        agent: 'codex',
        processIncarnation: 'runtime_test:term_worker:1',
        providerSession: {
          key: 'codex:clipped-session',
          id: 'clipped-session',
          transcriptPath
        }
      } as never)
      const { dispatchId } = await h.startSettledWorker()
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })

      const read = (await h.call('orchestration.workerRead', { dispatch: dispatchId })) as {
        transcript: { limited: boolean }
        cursor: string
        contentComplete: boolean
        clipping: string[]
        warnings: string[]
      }

      expect(read).toMatchObject({
        transcript: { limited: true },
        contentComplete: false,
        clipping: ['transcript_payload'],
        warnings: ['Oversized transcript text was clipped.']
      })
      expect(read.cursor).toMatch(/^owr1_/)
      expect(read.warnings).not.toContain(
        'Older transcript messages were omitted from the bounded archive.'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a legacy live-terminal cursor after output moves to the archive', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    await h.call('orchestration.workerRelease', { dispatch: dispatchId })

    await expect(
      h.call('orchestration.workerRead', { dispatch: dispatchId, cursor: 1 })
    ).rejects.toThrow(/source changed/i)
  })

  it('recovers archive metadata when a prior attempt committed only the archive row', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const requested = h.db.requestWorkerTerminalRelease(dispatchId)
    expect(requested.disposition).toBe('requested')
    if (requested.disposition !== 'requested') {
      throw new Error('release request was not recorded')
    }
    h.db.storeWorkerTerminalArchive({
      dispatchId,
      resourceId: requested.resource.id,
      kind: 'terminal_tail',
      content: JSON.stringify({
        lines: ['archive survived the interrupted attempt'],
        truncated: false,
        terminalStatus: 'running',
        warnings: []
      })
    })

    const release = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      archive: { source: string | null; status: string | null } | null
    }

    expect(release.archive).toEqual({ source: 'terminal', status: 'captured' })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      archive_source: 'terminal',
      archive_status: 'captured'
    })
  })
})
