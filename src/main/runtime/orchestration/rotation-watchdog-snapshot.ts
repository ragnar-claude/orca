export const TOKEN_ROTATION_THRESHOLD = 120_000
export const CONTEXT_REMAINING_ROTATION_THRESHOLD_PERCENT = 20
export const LOCAL_MODEL_CONTEXT_WINDOW_TOKENS = 65_536
export const LOCAL_MODEL_RESERVED_OUTPUT_TOKENS = 8_192
export const LOCAL_MODEL_RESERVED_TOOL_TOKENS = 8_192
export const LOCAL_MODEL_INPUT_BUDGET_TOKENS =
  LOCAL_MODEL_CONTEXT_WINDOW_TOKENS -
  LOCAL_MODEL_RESERVED_OUTPUT_TOKENS -
  LOCAL_MODEL_RESERVED_TOOL_TOKENS
export const LOCAL_MODEL_FALLBACKS = ['qwen/qwen3-coder-30b', 'qwen/qwen3-coder-next'] as const
export const CHECKPOINT_TASK_STATUSES = ['pending', 'ready', 'blocked'] as const

export type ContextTelemetry = {
  telemetryStatus: 'available' | 'unavailable'
  telemetrySource: string
  currentInputTokens: number | null
  contextWindowTokens: number | null
  contextRemainingPercent: number | null
  telemetryEvidence: string | null
  telemetryReason?: string
}

const QWEN_TOKEN_FOOTER_RE = /(\d+(?:\.\d+)?)\s*[Kk]\s*\/\s*(\d+(?:\.\d+)?)\s*([KkMm])\b/
const CLAUDE_CONTEXT_REMAINING_RE =
  /context(?:\s+left)?(?:\s+until\s+auto[- ]?compact)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i

export function parseContextTelemetry(footer?: string | null): ContextTelemetry {
  const text = footer ?? ''
  const qwen = QWEN_TOKEN_FOOTER_RE.exec(text)
  if (qwen) {
    const used = Number(qwen[1]) * 1_000
    const total = Number(qwen[2]) * (qwen[3].toLowerCase() === 'm' ? 1_000_000 : 1_000)
    return {
      telemetryStatus: 'available',
      telemetrySource: 'qwen_numeric_footer',
      currentInputTokens: Math.trunc(used),
      contextWindowTokens: Math.trunc(total),
      contextRemainingPercent: Math.max(0, (100 * (total - used)) / total),
      telemetryEvidence: qwen[0]
    }
  }
  const claude = CLAUDE_CONTEXT_REMAINING_RE.exec(text)
  if (claude) {
    return {
      telemetryStatus: 'available',
      telemetrySource: 'claude_context_remaining_footer',
      currentInputTokens: null,
      contextWindowTokens: null,
      contextRemainingPercent: Number(claude[1]),
      telemetryEvidence: claude[0]
    }
  }
  return {
    telemetryStatus: 'unavailable',
    telemetrySource: 'terminal_footer',
    currentInputTokens: null,
    contextWindowTokens: null,
    contextRemainingPercent: null,
    telemetryEvidence: null,
    telemetryReason: 'no_bounded_numeric_context_signal'
  }
}

export type RotationTelemetryMetrics = {
  newInputTokens?: number | null
  contextRemainingPercent?: number | null
  telemetryStatus?: 'available' | 'unavailable' | null
  telemetrySource?: string | null
}

export function evaluateRotationTelemetry(metrics: RotationTelemetryMetrics): {
  shouldRotate: boolean
  triggeredReasons: readonly string[]
  observations: {
    tokenThreshold: boolean
    contextPressure: boolean
    telemetryUnavailable: boolean
  }
} {
  const tokenThreshold =
    metrics.newInputTokens != null && metrics.newInputTokens >= TOKEN_ROTATION_THRESHOLD
  const contextPressure =
    metrics.contextRemainingPercent != null &&
    metrics.contextRemainingPercent <= CONTEXT_REMAINING_ROTATION_THRESHOLD_PERCENT
  const telemetryUnavailable =
    metrics.telemetryStatus === 'unavailable' ||
    (metrics.telemetryStatus == null &&
      metrics.telemetrySource == null &&
      (metrics.newInputTokens == null || metrics.newInputTokens === 0) &&
      metrics.contextRemainingPercent == null)
  const triggeredReasons = [
    ...(tokenThreshold ? ['token_threshold'] : []),
    ...(contextPressure ? ['context_pressure'] : []),
    ...(telemetryUnavailable ? ['telemetry_unavailable'] : [])
  ]
  return {
    shouldRotate: triggeredReasons.length > 0,
    triggeredReasons,
    observations: { tokenThreshold, contextPressure, telemetryUnavailable }
  }
}

export type LocalModelInventoryRecord = {
  id: string
  state?: string
  loadedContextLength?: number
  contextLength?: number
}

export type PrelaunchContextAdmission = {
  ok: boolean
  status:
    | 'available'
    | 'endpoint_unreachable'
    | 'malformed_response'
    | 'model_absent'
    | 'context_unsafe'
  selectedModel: string | null
  fallbacks: readonly string[]
  contextWindowTokens: number
  inputBudgetTokens: number
  reservedToolTokens: number
  reservedOutputTokens: number
  estimatedInputTokens: number
  splitRequired: boolean
  requiredChunks: number
  effectsApplied: false
}

function normalizeLocalModelName(model: string): string {
  return model.startsWith('lmstudio/') ? model.slice('lmstudio/'.length) : model
}

function estimateInputTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

export function admitPrelaunchContext(args: {
  model?: string | null
  prompt?: string
  spec?: string
  inventoryStatus: 'available' | 'endpoint_unreachable' | 'malformed_response'
  records?: readonly LocalModelInventoryRecord[] | null
}): PrelaunchContextAdmission {
  const estimatedInputTokens =
    estimateInputTokens(args.prompt ?? '') + estimateInputTokens(args.spec ?? '')
  const requiredChunks = Math.max(
    1,
    Math.ceil(estimatedInputTokens / LOCAL_MODEL_INPUT_BUDGET_TOKENS)
  )
  const base = {
    fallbacks: LOCAL_MODEL_FALLBACKS,
    contextWindowTokens: LOCAL_MODEL_CONTEXT_WINDOW_TOKENS,
    inputBudgetTokens: LOCAL_MODEL_INPUT_BUDGET_TOKENS,
    reservedToolTokens: LOCAL_MODEL_RESERVED_TOOL_TOKENS,
    reservedOutputTokens: LOCAL_MODEL_RESERVED_OUTPUT_TOKENS,
    estimatedInputTokens,
    splitRequired: requiredChunks > 1,
    requiredChunks,
    effectsApplied: false as const
  }
  const fail = (status: PrelaunchContextAdmission['status']): PrelaunchContextAdmission => ({
    ...base,
    ok: false,
    status,
    selectedModel: null
  })
  if (args.inventoryStatus !== 'available') {
    return fail(args.inventoryStatus)
  }
  if (!Array.isArray(args.records)) {
    return fail('malformed_response')
  }

  const candidates = [
    ...(args.model ? [args.model] : []),
    ...LOCAL_MODEL_FALLBACKS.filter(
      (fallback) => !args.model || normalizeLocalModelName(args.model) !== fallback
    )
  ]
  for (const candidate of candidates) {
    const normalized = normalizeLocalModelName(candidate)
    const record = args.records.find((item) => item.id === normalized || item.id === candidate)
    if (!record) {
      continue
    }
    const window = record.loadedContextLength ?? record.contextLength
    const unsafe =
      (record.state != null && record.state !== 'loaded') ||
      window !== LOCAL_MODEL_CONTEXT_WINDOW_TOKENS ||
      base.splitRequired
    if (unsafe) {
      if (args.model && normalized === normalizeLocalModelName(args.model)) {
        return fail('context_unsafe')
      }
      continue
    }
    return { ...base, ok: true, status: 'available', selectedModel: candidate }
  }
  return fail('model_absent')
}

export type CheckpointTask = {
  id: string
  status?: string
  [key: string]: unknown
}
export type CheckpointTaskPage = { tasks?: unknown; truncated?: boolean }

export function enumerateCheckpointTasks(args: {
  aggregate: CheckpointTaskPage | null
  shards: Partial<Record<(typeof CHECKPOINT_TASK_STATUSES)[number], CheckpointTaskPage>>
}): CheckpointTask[] {
  if (Array.isArray(args.aggregate?.tasks) && !args.aggregate?.truncated) {
    return args.aggregate.tasks as CheckpointTask[]
  }
  const tasks: CheckpointTask[] = []
  const seen = new Set<string>()
  for (const status of CHECKPOINT_TASK_STATUSES) {
    const shard = args.shards[status]
    if (!shard || !Array.isArray(shard.tasks) || shard.truncated) {
      throw new Error(`incomplete task-list shard for status=${status}`)
    }
    for (const task of shard.tasks as CheckpointTask[]) {
      if (!task || typeof task.id !== 'string' || task.id.length === 0) {
        throw new Error(`task-list shard status=${status} contains row without id`)
      }
      if (!seen.has(task.id)) {
        seen.add(task.id)
        tasks.push(task)
      }
    }
  }
  return tasks
}
