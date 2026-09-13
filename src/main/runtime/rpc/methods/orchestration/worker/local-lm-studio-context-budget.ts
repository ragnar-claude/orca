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
}

export function estimateTokens(text: string | undefined): number {
  if (!text) {
    return 0
  }
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

export function recordContextWindow(item: LocalLmStudioContextRecord): number {
  for (const value of [item.loaded_context_length, item.context_length]) {
    if (typeof value === 'number' && value > 0) {
      return value
    }
  }
  return 0
}

export function localLmStudioPromptSplitPlan(
  prompt = '',
  spec = ''
): {
  contextWindowTokens: number
  inputBudgetTokens: number
  reservedToolTokens: number
  reservedOutputTokens: number
  estimatedInputTokens: number
  splitRequired: boolean
  requiredChunks: number
} {
  const estimatedInputTokens = estimateTokens(prompt) + estimateTokens(spec)
  const requiredChunks = Math.max(1, Math.ceil(estimatedInputTokens / LOCAL_LM_STUDIO_INPUT_BUDGET))
  return {
    contextWindowTokens: LOCAL_LM_STUDIO_CONTEXT,
    inputBudgetTokens: LOCAL_LM_STUDIO_INPUT_BUDGET,
    reservedToolTokens: LOCAL_LM_STUDIO_RESERVED_TOOL_TOKENS,
    reservedOutputTokens: LOCAL_LM_STUDIO_RESERVED_OUTPUT_TOKENS,
    estimatedInputTokens,
    splitRequired: requiredChunks > 1,
    requiredChunks
  }
}

export function isContextUnsafe(item: LocalLmStudioContextRecord, prompt = '', spec = ''): boolean {
  if (item.state !== undefined && item.state !== 'loaded') {
    return true
  }
  if (recordContextWindow(item) !== LOCAL_LM_STUDIO_CONTEXT) {
    return true
  }
  return localLmStudioPromptSplitPlan(prompt, spec).splitRequired
}
