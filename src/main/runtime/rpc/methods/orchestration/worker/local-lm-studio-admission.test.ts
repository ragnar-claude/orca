import { describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  LOCAL_LM_STUDIO_FALLBACKS,
  LOCAL_LM_STUDIO_CONTEXT,
  LOCAL_LM_STUDIO_INPUT_BUDGET,
  LOCAL_LM_STUDIO_RESERVED_OUTPUT_TOKENS,
  LOCAL_LM_STUDIO_RESERVED_TOOL_TOKENS,
  admitLocalLmStudio,
  assertLocalLmStudioAdmission,
  localLmStudioPromptSplitPlan,
  normalizeLmStudioModelName,
  shouldAdmitLocalLmStudio
} from './local-lm-studio-admission'

function inventory(
  records: (
    | string
    | {
        id: string
        state?: string
        loaded_context_length?: number
        context_length?: number
      }
  )[],
  status: 'available' | 'endpoint_unreachable' | 'malformed_response' | 'http_error' = 'available'
) {
  return {
    records:
      status === 'available'
        ? records.map((item) =>
            typeof item === 'string'
              ? { id: item, state: 'loaded', loaded_context_length: LOCAL_LM_STUDIO_CONTEXT }
              : item
          )
        : null,
    status
  }
}

describe('local LM Studio admission', () => {
  it('strips lmstudio/ only and preserves other provider prefixes', () => {
    expect(normalizeLmStudioModelName('lmstudio/qwen/qwen3-coder-30b')).toBe('qwen/qwen3-coder-30b')
    expect(normalizeLmStudioModelName('omniroute/qwen/qwen3-coder-30b')).toBe(
      'omniroute/qwen/qwen3-coder-30b'
    )
    expect(shouldAdmitLocalLmStudio({ agent: 'claude' })).toBe(false)
    expect(shouldAdmitLocalLmStudio({ agent: 'opencode' })).toBe(true)
    expect(
      shouldAdmitLocalLmStudio({ agent: 'claude', model: 'lmstudio/qwen/qwen3-coder-30b' })
    ).toBe(true)
  })

  it('does not treat an omniroute-qualified id as an LM Studio inventory hit', async () => {
    const admission = await admitLocalLmStudio({
      model: 'omniroute/qwen/qwen3-coder-30b',
      inventory: inventory(['qwen/qwen3-coder-30b'])
    })
    // omniroute id is not a fallback match; 30B fallback still admits because it is in inventory
    expect(admission.ok).toBe(true)
    expect(admission.selectedModel).toBe('qwen/qwen3-coder-30b')
    expect(admission.inventoryFetches).toBe(0)
  })

  it('fetches inventory once when walking 30B then Next fallbacks', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: { signal?: AbortSignal }) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 'qwen/qwen3-coder-next',
            state: 'loaded',
            loaded_context_length: LOCAL_LM_STUDIO_CONTEXT
          }
        ]
      })
    }))
    const admission = await admitLocalLmStudio({
      model: 'missing-model',
      fetchImpl
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/api\/v0\/models$/)
    expect(admission.ok).toBe(true)
    expect(admission.selectedModel).toBe('qwen/qwen3-coder-next')
    expect(admission.inventoryFetches).toBe(1)
    expect(admission.fallbacks).toEqual([...LOCAL_LM_STUDIO_FALLBACKS])
  })

  it('prefers Qwen 30B over Next when both are present', async () => {
    const admission = await admitLocalLmStudio({
      inventory: inventory(['qwen/qwen3-coder-next', 'qwen/qwen3-coder-30b'])
    })
    expect(admission.selectedModel).toBe('qwen/qwen3-coder-30b')
  })

  it('fails closed on endpoint_unreachable, malformed response, absent model, and unsafe context', async () => {
    await expect(
      admitLocalLmStudio({
        model: 'qwen/qwen3-coder-30b',
        inventory: inventory([], 'endpoint_unreachable')
      })
    ).resolves.toMatchObject({ ok: false, status: 'endpoint_unreachable', effectsApplied: false })

    await expect(
      admitLocalLmStudio({
        model: 'qwen/qwen3-coder-30b',
        inventory: inventory([], 'malformed_response')
      })
    ).resolves.toMatchObject({ ok: false, status: 'malformed_response' })

    await expect(
      admitLocalLmStudio({
        model: 'missing',
        inventory: inventory(['other'])
      })
    ).resolves.toMatchObject({ ok: false, status: 'model_absent' })

    await expect(
      admitLocalLmStudio({
        model: 'qwen/qwen3-coder-30b',
        inventory: inventory([{ id: 'qwen/qwen3-coder-30b', loaded_context_length: 1_048_576 }])
      })
    ).resolves.toMatchObject({ ok: false, status: 'context_unsafe' })

    await expect(
      admitLocalLmStudio({
        model: 'qwen/qwen3-coder-30b',
        inventory: inventory([
          { id: 'qwen/qwen3-coder-30b', state: 'loaded', loaded_context_length: 8_192 }
        ])
      })
    ).resolves.toMatchObject({ ok: false, status: 'context_unsafe' })

    const huge = 'x'.repeat(LOCAL_LM_STUDIO_INPUT_BUDGET * 4 + 16)
    await expect(
      admitLocalLmStudio({
        model: 'qwen/qwen3-coder-30b',
        spec: huge,
        inventory: inventory([
          {
            id: 'qwen/qwen3-coder-30b',
            state: 'loaded',
            loaded_context_length: LOCAL_LM_STUDIO_CONTEXT
          }
        ])
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'context_unsafe',
      splitRequired: true,
      requiredChunks: 2,
      inputBudgetTokens: 49_152,
      reservedToolTokens: 8_192,
      reservedOutputTokens: 8_192
    })
  })

  it('reserves explicit tool and output headroom inside the exact 65536 window', async () => {
    const plan = localLmStudioPromptSplitPlan('', 'short task')
    expect(plan).toMatchObject({
      contextWindowTokens: 65_536,
      inputBudgetTokens: 49_152,
      reservedToolTokens: 8_192,
      reservedOutputTokens: 8_192,
      splitRequired: false,
      requiredChunks: 1
    })
    expect(
      LOCAL_LM_STUDIO_INPUT_BUDGET +
        LOCAL_LM_STUDIO_RESERVED_TOOL_TOKENS +
        LOCAL_LM_STUDIO_RESERVED_OUTPUT_TOKENS
    ).toBe(LOCAL_LM_STUDIO_CONTEXT)
  })

  it('throws OrchestrationError with effectsApplied false for local targets', async () => {
    await expect(
      assertLocalLmStudioAdmission({
        agent: 'opencode',
        model: 'lmstudio/qwen/qwen3-coder-30b',
        inventory: { records: null, status: 'endpoint_unreachable' }
      })
    ).rejects.toMatchObject({
      name: 'OrchestrationError',
      code: 'endpoint_unreachable',
      data: { effectsApplied: false }
    })
    await expect(assertLocalLmStudioAdmission({ agent: 'claude' })).resolves.toMatchObject({
      status: 'skipped',
      inventoryFetches: 0
    })
    expect(OrchestrationError).toBeDefined()
  })
})
