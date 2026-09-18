export const LOCAL_LM_STUDIO_CONTEXT = 65_536
export const LOCAL_LM_STUDIO_RESERVED_TOOL_TOKENS = 8_192
export const LOCAL_LM_STUDIO_RESERVED_OUTPUT_TOKENS = 8_192
export const LOCAL_LM_STUDIO_INPUT_BUDGET =
  LOCAL_LM_STUDIO_CONTEXT -
  LOCAL_LM_STUDIO_RESERVED_TOOL_TOKENS -
  LOCAL_LM_STUDIO_RESERVED_OUTPUT_TOKENS
export const LOCAL_LM_STUDIO_SAFE_CONTEXT = LOCAL_LM_STUDIO_CONTEXT

export type LocalLmStudioContextRecord = {
  state?: string
  loaded_context_length?: number
  context_length?: number
  max_context_length?: number
  max_model_len?: number
}

export function estimateTokens(text: string | undefined): number {
  if (!text) {
    return 0
  }
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

export function recordContextWindow(item: LocalLmStudioContextRecord): number {
  for (const value of [
    item.loaded_context_length,
    item.context_length,
    item.max_context_length,
    item.max_model_len
  ]) {
    if (typeof value === 'number' && value > 0) {
      return value
    }
  }
  return 0
}

export function resolveContextReserves(contextWindow: number): {
  reservedToolTokens: number
  reservedOutputTokens: number
} {
  if (contextWindow >= 262_144) {
    return {
      reservedToolTokens: 16_384,
      reservedOutputTokens: 32_768
    }
  }
  return {
    reservedToolTokens: 8_192,
    reservedOutputTokens: 8_192
  }
}

export function localLmStudioPromptSplitPlan(
  prompt = '',
  spec = '',
  contextWindow?: number
): {
  contextWindowTokens: number
  inputBudgetTokens: number
  reservedToolTokens: number
  reservedOutputTokens: number
  estimatedInputTokens: number
  splitRequired: boolean
  requiredChunks: number
} {
  const window = contextWindow && contextWindow > 0 ? contextWindow : LOCAL_LM_STUDIO_CONTEXT
  const { reservedToolTokens, reservedOutputTokens } = resolveContextReserves(window)
  const inputBudgetTokens = Math.max(0, window - reservedToolTokens - reservedOutputTokens)
  const estimatedInputTokens = estimateTokens(prompt) + estimateTokens(spec)
  const requiredChunks =
    inputBudgetTokens > 0 ? Math.max(1, Math.ceil(estimatedInputTokens / inputBudgetTokens)) : 1
  return {
    contextWindowTokens: window,
    inputBudgetTokens,
    reservedToolTokens,
    reservedOutputTokens,
    estimatedInputTokens,
    splitRequired: inputBudgetTokens <= 0 || estimatedInputTokens > inputBudgetTokens,
    requiredChunks
  }
}

export function isContextUnsafe(item: LocalLmStudioContextRecord, prompt = '', spec = ''): boolean {
  const window = recordContextWindow(item)
  if (window <= 0) {
    return true
  }
  return localLmStudioPromptSplitPlan(prompt, spec, window).splitRequired
}
