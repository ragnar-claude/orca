import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../shared/agent-prompt-injection'
import { OrcaRuntimeService } from '../orca-runtime'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal'

vi.mock('../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-contract',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-contract',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

function request(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'test-token', method, params }
}

describe('OpenCode guarded terminal send', () => {
  afterEach(() => vi.useRealTimers())

  it('refuses a marker title left on a shell without writing notes', async () => {
    vi.useFakeTimers()
    const write = vi.fn(() => true)
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({
      write,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree',
          title: 'OC | zsh',
          activeLeafId: 'pane-1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree',
          leafId: 'pane-1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'OC | zsh'
        }
      ]
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await expect(
      dispatcher.dispatch(request('terminal.agentStatus', { terminal: terminal.handle }))
    ).resolves.toMatchObject({
      ok: true,
      result: { agentStatus: { isRunningAgent: false, status: null } }
    })

    const send = dispatcher.dispatch(
      request('terminal.send', {
        terminal: terminal.handle,
        text: '$(touch should-not-run)',
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )
    await vi.advanceTimersByTimeAsync(1_500)

    await expect(send).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0, refusedReason: 'no-agent' } }
    })
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['opencode', 'deepseek'] as const)(
    'refuses a combined guarded %s payload+Enter so submit stays a second RPC',
    async (agent) => {
      const runtime = new OrcaRuntimeService()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => agent
      })
      vi.spyOn(runtime, 'resolveLiveLeafForHandle').mockReturnValue({ ptyId: 'pty-1' } as never)
      vi.spyOn(runtime, 'getDriver').mockReturnValue({ kind: 'desktop' } as never)
      vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
        handle: 'term-1',
        isRunningAgent: true,
        status: 'idle'
      } as never)
      const sendTerminal = vi.spyOn(runtime, 'sendTerminal').mockResolvedValue({
        handle: 'term-1',
        accepted: true,
        bytesWritten: 1
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      await expect(
        dispatcher.dispatch(
          request('terminal.send', {
            terminal: 'term-1',
            text: 'do the work',
            enter: true,
            requireAgentStatus: 'sendable',
            client: { id: 'desktop-1', type: 'desktop' }
          })
        )
      ).resolves.toMatchObject({
        ok: true,
        result: { send: { accepted: false, bytesWritten: 0 } }
      })
      expect(sendTerminal).not.toHaveBeenCalled()
    }
  )

  it.each(['opencode', 'deepseek'] as const)(
    'submits a swallowed %s Draft exactly once via standalone recovery Enter',
    async (agent) => {
      vi.useFakeTimers()
      let submits = 0
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(
              () => runtime.onPtyData('pty-prompt', '┌Draft\nfooter · draft', Date.now()),
              200
            )
            return
          }
          if (data !== '\r') {
            return
          }
          submits += 1
          if (submits === 1) {
            runtime.onPtyData('pty-prompt', '┌Draft\nfooter · draft', Date.now())
            return
          }
          runtime.onPtyData('pty-prompt', 'Write a task or use /.\n', Date.now())
        },
        agent
      )

      const pending = runtime.sendTerminalAgentPrompt(handle, 'You are a dispatched worker', {
        acceptQueued: true,
        observationTimeoutMs: 0,
        requestId: `${agent}-standalone-submit-recovery`
      })
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ accepted: true })
      expect(writes.filter((data) => data.includes('\x1b[200~'))).toHaveLength(1)
      expect(writes.filter((data) => data === '\r')).toHaveLength(2)
      expect(submits).toBe(2)
    }
  )
})
