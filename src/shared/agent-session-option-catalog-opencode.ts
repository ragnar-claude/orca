import { hasFlag } from './agent-cli-flag-detection'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import { parseLineModels } from './commit-message-model-parsers'

const hasModelFlag = (tokens: readonly string[]): boolean => hasFlag(tokens, ['-m', '--model'])

// `opencode models` prints one space-free `provider/model` id per line; reuse the exact parser
// the commit-message probe already ships for this command (commit-message-agent-specs-primary.ts).
// Drop the id-shape-inferred OpenAI thinking levels: OpenCode has no per-model effort menu, so a
// launch carries the id alone.
function parseOpencodeCatalogModels(stdout: string): CatalogModel[] {
  return parseLineModels(stdout).map((model) => ({ id: model.id, label: model.label, options: [] }))
}

/** OpenCode takes an opaque `provider/model` id via `-m/--model`; the launch record forwards the
 *  requested id verbatim, so worker-start proves requested === effective by passthrough. `listModels`
 *  fills the picker from `opencode models`, but is deliberately NOT authoritative: ids are opaque and
 *  launch forwards any id, so discovery never gates membership. No `midSession`: launch-time only. */
export const OPENCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: hasModelFlag,
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model'])
  },
  listModels: { command: 'opencode models', parse: parseOpencodeCatalogModels }
}
