import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_QUICK_COMMAND_LIST_SPEC: CommandSpec = {
  path: ['terminal', 'quick-command', 'list'],
  aliases: [['terminal', 'quick-commands']],
  summary: 'List configured terminal quick commands',
  usage: 'orca terminal quick-command list [--json]',
  allowedFlags: [...GLOBAL_FLAGS],
  notes: [
    'Returns the live host settings inventory; command and prompt bodies are included in JSON so automation can enumerate exact actions.'
  ]
}
