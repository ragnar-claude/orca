import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog, mergeCatalogModels } from './agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import {
  resolveNativeChatSessionOptionDefaults,
  updateNativeChatSessionOptionDefaults
} from './native-chat-session-option-defaults'

describe('agent session option catalog', () => {
  it('returns no catalog for unknown agents', () => {
    expect(getAgentSessionOptionCatalog('future-agent')).toBeNull()
  })

  it('keeps Claude option sets model-scoped', () => {
    const catalog = getAgentSessionOptionCatalog('claude')
    expect(
      catalog?.models.find((model) => model.id === 'opus')?.options.map(({ id }) => id)
    ).toEqual(['effort', 'fastMode'])
    expect(catalog?.models.find((model) => model.id === 'haiku')?.options).toEqual([])
  })

  it('merges discovered labels while preserving cataloged option shapes', () => {
    const seed = getAgentSessionOptionCatalog('cursor')!.models
    const merged = mergeCatalogModels(seed, [
      { id: 'gpt-5.3-codex', label: 'GPT 5.3 (live)', options: [] },
      { id: 'new-account-model', label: 'new-account-model', options: [] }
    ])
    expect(merged.find((model) => model.id === 'gpt-5.3-codex')).toMatchObject({
      label: 'GPT 5.3 (live)',
      options: expect.arrayContaining([expect.objectContaining({ id: 'effort' })])
    })
    expect(merged.at(-1)).toEqual({
      id: 'new-account-model',
      label: 'new-account-model',
      options: []
    })
  })

  it('labels Claude seed models by alias family so no host is mislabeled', () => {
    const catalog = getAgentSessionOptionCatalog('claude')!
    expect(catalog.models.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'fable', label: 'Fable' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' }
    ])
    expect(catalog.models.find((model) => model.isDefault)?.id).toBe('sonnet')
  })

  it('parses Claude list_models discovery into catalog models with options', () => {
    const stdout = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          models: [
            {
              value: 'default',
              displayName: 'Default (recommended)',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true
            },
            {
              value: 'opus[1m]',
              displayName: 'Opus (1M context)',
              description: 'Opus 5 with 1M context',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true
            },
            {
              value: 'sonnet',
              displayName: 'Sonnet',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high']
            },
            { value: 'haiku', displayName: 'Haiku' }
          ]
        }
      }
    })
    const parsed = getAgentSessionOptionCatalog('claude')!.listModels!.parse(stdout)
    expect(parsed.map(({ id }) => id)).toEqual(['opus[1m]', 'sonnet', 'haiku'])
    expect(parsed[0]).toMatchObject({
      label: 'Opus (1M context)',
      description: 'Opus 5 with 1M context'
    })
    expect(parsed[0].options.map(({ id }) => id)).toEqual(['effort', 'fastMode'])
    const opusEffort = parsed[0].options[0]
    expect(opusEffort.kind).toMatchObject({ defaultValue: 'high' })
    expect(
      opusEffort.kind.type === 'select' ? opusEffort.kind.choices.map((c) => c.value) : []
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    const sonnetEffort = parsed[1].options[0]
    expect(
      sonnetEffort.kind.type === 'select' ? sonnetEffort.kind.choices.map((c) => c.value) : []
    ).toEqual(['low', 'medium', 'high'])
    expect(parsed[2].options).toEqual([])
  })

  it('keeps the Claude seed when list_models output is unsupported or malformed', () => {
    const parse = getAgentSessionOptionCatalog('claude')!.listModels!.parse
    const unsupported =
      '{"type":"control_response","response":{"subtype":"error","request_id":"x","error":"Unsupported control request subtype: list_models"}}'
    expect(parse(unsupported)).toEqual([])
    expect(parse('')).toEqual([])
    expect(parse('garbage')).toEqual([])
  })

  it('merges discovered Claude variants after the seed and overlays matched labels', () => {
    const catalog = getAgentSessionOptionCatalog('claude')!
    const merged = mergeCatalogModels(catalog.models, [
      { id: 'opus[1m]', label: 'Opus (1M context)', options: [] },
      { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient', options: [] }
    ])
    expect(merged.map(({ id }) => id)).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'opus[1m]'])
    const sonnet = merged.find((model) => model.id === 'sonnet')!
    expect(sonnet.description).toBe('Sonnet 5 · Efficient')
    expect(sonnet.isDefault).toBe(true)
    expect(sonnet.options.map(({ id }) => id)).toEqual(['effort'])
  })

  it('parses Cursor model discovery without treating headings as models', () => {
    const parsed = getAgentSessionOptionCatalog('cursor')!.listModels!.parse(
      'Available models:\n- auto (default)\n- gpt-5.3-codex\nmodels\n'
    )
    expect(parsed.map(({ id }) => id)).toEqual(['auto', 'gpt-5.3-codex'])
  })

  it('composes Cursor effort and fast mode into the supported slug form', () => {
    const resolved = resolveAgentSessionOptionLaunch('cursor', {
      model: 'gpt-5.3-codex',
      effort: 'high',
      fastMode: true
    })
    expect(resolved.args).toEqual(['--model', 'gpt-5.3-codex-high-fast'])
    expect(resolved.appliedValues).toEqual({
      model: 'gpt-5.3-codex',
      effort: 'high',
      fastMode: true
    })
  })

  it('forwards an explicit OpenCode model verbatim as a launch --model flag', () => {
    expect(
      resolveAgentSessionOptionLaunch('opencode', { model: 'lmstudio/qwen/qwen3-coder-30b' })
    ).toEqual({
      args: ['--model', 'lmstudio/qwen/qwen3-coder-30b'],
      appliedValues: { model: 'lmstudio/qwen/qwen3-coder-30b' }
    })
  })

  it('discovers OpenCode models from `opencode models` without leaking id-shape thinking levels', () => {
    const catalog = getAgentSessionOptionCatalog('opencode')!
    expect(catalog.listModels!.command).toBe('opencode models')
    const parsed = catalog.listModels!.parse(
      'opencode/big-pickle\nomniroute/codex/gpt-5.6-luna\nopencode/mimo-v2.5-free\n'
    )
    expect(parsed.map(({ id }) => id)).toEqual([
      'opencode/big-pickle',
      'omniroute/codex/gpt-5.6-luna',
      'opencode/mimo-v2.5-free'
    ])
    // OpenCode exposes no per-model effort menu, so every discovered model carries an empty option
    // set and nothing else — the codex/gpt-5 id must not leak the thinking levels parseLineModels
    // infers from its shape.
    expect(parsed.every((model) => model.options.length === 0)).toBe(true)
    const codex = parsed.find((model) => model.id === 'omniroute/codex/gpt-5.6-luna')!
    expect(Object.keys(codex).sort()).toEqual(['id', 'label', 'options'])
  })

  it('discovers Antigravity models live and forwards an explicit worker model', () => {
    const catalog = getAgentSessionOptionCatalog('antigravity')!
    expect(catalog.supportsWorkerLaunchPreferences).toBe(true)
    expect(catalog.models).toEqual([])
    expect(catalog.listModels!.command).toBe('agy models')
    expect(
      catalog.listModels!.parse('Gemini 3.8 Flash\nGemini 3.8 Pro (High)\n').map(({ id }) => id)
    ).toEqual(['Gemini 3.8 Flash', 'Gemini 3.8 Pro (High)'])
    expect(resolveAgentSessionOptionLaunch('antigravity', { model: 'Gemini 3.8 Flash' })).toEqual({
      args: ['--model', 'Gemini 3.8 Flash'],
      appliedValues: { model: 'Gemini 3.8 Flash' }
    })
  })

  it('passes unknown model and option values through launch mappings', () => {
    expect(
      resolveAgentSessionOptionLaunch('claude', {
        model: 'claude-future',
        effort: 'future-effort'
      })
    ).toEqual({ args: ['--model', 'claude-future'], appliedValues: { model: 'claude-future' } })
    expect(
      resolveAgentSessionOptionLaunch('claude', { model: 'opus', effort: 'future-effort' })
    ).toMatchObject({
      args: ['--model', 'opus', '--effort', 'future-effort'],
      appliedValues: { model: 'opus', effort: 'future-effort' }
    })
  })

  it('resolves only stored values without leaking values across models', () => {
    let persisted = updateNativeChatSessionOptionDefaults({
      persisted: undefined,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'model',
      value: 'opus'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'effort',
      value: 'xhigh'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'sonnet',
      optionId: 'model',
      value: 'sonnet'
    })

    expect(resolveNativeChatSessionOptionDefaults(persisted, 'claude')).toEqual({
      model: 'sonnet'
    })
    expect(persisted.claude?.valuesByModel?.opus).toEqual({ effort: 'xhigh' })
  })

  it('spawns vanilla when the user has not explicitly selected a model', () => {
    // Regression (#9085): a fresh launch must not force the catalog default
    // model/effort — the agent must spawn exactly as its own CLI would.
    expect(resolveNativeChatSessionOptionDefaults(undefined, 'claude')).toBeUndefined()
    expect(resolveNativeChatSessionOptionDefaults({}, 'claude')).toBeUndefined()
    expect(resolveNativeChatSessionOptionDefaults({}, 'future-agent')).toBeUndefined()
  })

  it('resolves an explicitly selected model and only its stored options', () => {
    let persisted = updateNativeChatSessionOptionDefaults({
      persisted: undefined,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'model',
      value: 'opus'
    })
    expect(resolveNativeChatSessionOptionDefaults(persisted, 'claude')).toEqual({
      model: 'opus'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'effort',
      value: 'xhigh'
    })
    expect(resolveNativeChatSessionOptionDefaults(persisted, 'claude')).toEqual({
      model: 'opus',
      effort: 'xhigh'
    })
  })

  it('keeps catalog option defaults after the user explicitly selects a model', () => {
    const persisted = updateNativeChatSessionOptionDefaults({
      persisted: undefined,
      agent: 'claude',
      modelId: 'sonnet',
      optionId: 'model',
      value: 'sonnet'
    })
    const defaults = resolveNativeChatSessionOptionDefaults(persisted, 'claude')

    expect(resolveAgentSessionOptionLaunch('claude', defaults)).toEqual({
      args: ['--model', 'sonnet', '--effort', 'high'],
      appliedValues: { model: 'sonnet', effort: 'high' }
    })
  })
})
