import { describe, expect, it, vi } from 'vitest'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  agentHasStandaloneSubmitRecovery,
  isStandaloneSubmitDraftVisible,
  submitAgentPromptWithStandaloneRecovery
} from './tui-agent-standalone-submit'

describe('standalone submit recovery', () => {
  it('is enabled only for OpenCode and DeepSeek Draft composers', () => {
    expect(agentHasStandaloneSubmitRecovery('opencode')).toBe(true)
    expect(agentHasStandaloneSubmitRecovery('deepseek')).toBe(true)
    expect(agentHasStandaloneSubmitRecovery('codex')).toBe(false)
    expect(agentHasStandaloneSubmitRecovery('mimo-code')).toBe(false)
    expect(TUI_AGENT_CONFIG.deepseek.launchCmd).toBe('deepseek --skip-onboarding')
  })

  it('treats DeepSeek Draft chrome as unsent composer text', () => {
    expect(isStandaloneSubmitDraftVisible('┌Draft\nyolo · auto: deepseek-v4-flash · draft')).toBe(
      true
    )
    expect(isStandaloneSubmitDraftVisible('Write a task or use /.\nyolo · auto')).toBe(false)
    expect(isStandaloneSubmitDraftVisible('You are a dispatched worker')).toBe(false)
  })

  it('sends a recovery Enter only while Draft remains visible', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    let waitText = '┌Draft\n· draft'
    const pending = submitAgentPromptWithStandaloneRecovery({
      agent: 'deepseek',
      writeSubmit: () => {
        writes.push('\r')
        if (writes.length === 2) {
          waitText = 'Write a task or use /.'
        }
        return true
      },
      readWaitText: () => waitText,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      assertStillWritable: () => undefined
    })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe(2)
    expect(writes).toEqual(['\r', '\r'])
    vi.useRealTimers()
  })

  it('does not send a second Enter after the first submit clears Draft', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    let waitText = '┌Draft\n· draft'
    const pending = submitAgentPromptWithStandaloneRecovery({
      agent: 'opencode',
      writeSubmit: () => {
        writes.push('\r')
        waitText = 'Build · Qwen3 Coder'
        return true
      },
      readWaitText: () => waitText,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      assertStillWritable: () => undefined
    })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe(1)
    expect(writes).toEqual(['\r'])
    vi.useRealTimers()
  })
})
