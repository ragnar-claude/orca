import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/** DeepSeek titles the composer `Draft` and adds a footer `· draft` while text is unsent.
 *  OpenCode recovery tests reuse the same chrome so the second Enter is gated, not blind. */
const DRAFT_COMPOSER_VISIBLE = /┌\s*Draft\b|(?:^|\s)(?:·|•|\u00b7)\s*draft\b/i

const STANDALONE_SUBMIT_POLL_MS = 50

export function agentHasStandaloneSubmitRecovery(
  agent: TuiAgent | null | undefined
): agent is TuiAgent {
  return Boolean(agent && TUI_AGENT_CONFIG[agent]?.standaloneSubmitRecovery === true)
}

export function getStandaloneSubmitRetryDelayMs(agent: TuiAgent): number {
  return TUI_AGENT_CONFIG[agent].submitRetryDelayMs ?? 800
}

export function isStandaloneSubmitDraftVisible(waitText: string | null | undefined): boolean {
  return typeof waitText === 'string' && DRAFT_COMPOSER_VISIBLE.test(waitText)
}

export async function submitAgentPromptWithStandaloneRecovery(args: {
  agent: TuiAgent | null
  signal?: AbortSignal
  writeSubmit: () => boolean
  readWaitText: () => string
  wait: (ms: number) => Promise<void>
  assertStillWritable: () => void
}): Promise<number> {
  const recovery = agentHasStandaloneSubmitRecovery(args.agent)
  if (recovery) {
    await waitForStandaloneSubmitDraft(args, getStandaloneSubmitRetryDelayMs(args.agent))
  }
  args.assertStillWritable()
  if (!args.writeSubmit()) {
    throw new Error('terminal_not_writable')
  }
  let submits = 1
  if (!recovery) {
    return submits
  }
  await args.wait(getStandaloneSubmitRetryDelayMs(args.agent))
  args.assertStillWritable()
  if (!isStandaloneSubmitDraftVisible(args.readWaitText())) {
    return submits
  }
  if (!args.writeSubmit()) {
    throw new Error('terminal_not_writable')
  }
  return 2
}

async function waitForStandaloneSubmitDraft(
  args: {
    signal?: AbortSignal
    readWaitText: () => string
    wait: (ms: number) => Promise<void>
    assertStillWritable: () => void
  },
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    args.assertStillWritable()
    if (isStandaloneSubmitDraftVisible(args.readWaitText())) {
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return
    }
    await args.wait(Math.min(STANDALONE_SUBMIT_POLL_MS, remaining))
  }
}
