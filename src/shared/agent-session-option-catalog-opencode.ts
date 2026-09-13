import { hasFlag } from './agent-cli-flag-detection'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'
import { removeAgentArgOption } from './agent-session-option-agent-args'

const hasModelFlag = (tokens: readonly string[]): boolean => hasFlag(tokens, ['-m', '--model'])

/** OpenCode takes an opaque `provider/model` id via `-m/--model` and ships no queryable model menu,
 *  so the launch record forwards the requested id verbatim — worker-start proves requested ===
 *  effective by passthrough. No `midSession`: launch-time selection only, no unverified `/model`. */
export const OPENCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: hasModelFlag,
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model'])
  }
}
