import { hasFlag } from './agent-cli-flag-detection'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import { parseAntigravityModels } from './commit-message-model-parsers'

function parseAntigravityCatalogModels(stdout: string): CatalogModel[] {
  return parseAntigravityModels(stdout).map((model) => ({
    id: model.id,
    label: model.label,
    options: []
  }))
}

/** Antigravity's signed-in account owns the catalog. The seed is intentionally empty:
 * `agy models` is the only source of selectable ids and explicit worker launches forward
 * the exact id through `--model` while returning requested/effective launch receipts. */
export const ANTIGRAVITY_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model'])
  },
  listModels: { command: 'agy models', parse: parseAntigravityCatalogModels }
}
