import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from './worker-start-schema'
import {
  LOCAL_LM_STUDIO_INPUT_BUDGET,
  LOCAL_LM_STUDIO_RESERVED_OUTPUT_TOKENS,
  LOCAL_LM_STUDIO_RESERVED_TOOL_TOKENS,
  isContextUnsafe,
  localLmStudioPromptSplitPlan,
  recordContextWindow
} from './local-lm-studio-context-budget'

export * from './local-lm-studio-context-budget'

export const LOCAL_LM_STUDIO_ENDPOINT = 'http://127.0.0.1:1234'
export const LOCAL_LM_STUDIO_INVENTORY_PATH = '/api/v0/models'
export const LOCAL_LM_STUDIO_FALLBACKS = [
  'poolside/laguna-s-2.1',
  'qwen/qwen3-coder-30b',
  'qwen/qwen3-coder-next'
] as const

export type LocalLmStudioAdmissionStatus =
  | 'available'
  | 'skipped'
  | 'endpoint_unreachable'
  | 'http_error'
  | 'malformed_response'
  | 'model_absent'
  | 'context_unsafe'

export type LocalLmStudioInventoryRecord = LocalLmStudioContextRecord & {
  id: string
}

export type LocalLmStudioAdmission = ReturnType<typeof localLmStudioPromptSplitPlan> & {
  ok: boolean
  status: LocalLmStudioAdmissionStatus
  selectedModel: string | null
  fallbacks: readonly string[]
  inventoryFetches: number
  effectsApplied: false
}

export type LocalLmStudioFetchImpl = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export function normalizeLmStudioModelName(modelName: string): string {
  return modelName.startsWith('lmstudio/') ? modelName.slice('lmstudio/'.length) : modelName
}

export function shouldAdmitLocalLmStudio(args: {
  agent?: string | null
  model?: string | null
}): boolean {
  const model = args.model ?? ''
  if (model.startsWith('lmstudio/')) {
    return true
  }
  const normalized = normalizeLmStudioModelName(model)
  if ((LOCAL_LM_STUDIO_FALLBACKS as readonly string[]).includes(normalized)) {
    return true
  }
  return args.agent === 'opencode'
}

function findRecord(
  records: LocalLmStudioInventoryRecord[],
  modelName: string
): LocalLmStudioInventoryRecord | undefined {
  const normalized = normalizeLmStudioModelName(modelName)
  return records.find((item) => item.id === normalized || item.id === modelName)
}

export async function fetchLmStudioInventory(args: {
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: LocalLmStudioFetchImpl
}): Promise<{
  records: LocalLmStudioInventoryRecord[] | null
  status: LocalLmStudioAdmissionStatus
}> {
  const baseUrl = args.baseUrl ?? LOCAL_LM_STUDIO_ENDPOINT
  const timeoutMs = args.timeoutMs ?? 5_000
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as LocalLmStudioFetchImpl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}${LOCAL_LM_STUDIO_INVENTORY_PATH}`, {
      signal: controller.signal
    })
    if (!response || response.status === 0) {
      return { records: null, status: 'endpoint_unreachable' }
    }
    if (response.status >= 400) {
      return { records: null, status: 'http_error' }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { records: null, status: 'malformed_response' }
    }
    if (!payload || typeof payload !== 'object' || !('data' in payload)) {
      return { records: null, status: 'malformed_response' }
    }
    const data = (payload as { data: unknown }).data
    if (!Array.isArray(data)) {
      return { records: null, status: 'malformed_response' }
    }
    const records: LocalLmStudioInventoryRecord[] = []
    for (const item of data) {
      if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') {
        return { records: null, status: 'malformed_response' }
      }
      records.push(item as LocalLmStudioInventoryRecord)
    }
    return { records, status: 'available' }
  } catch {
    return { records: null, status: 'endpoint_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

export async function admitLocalLmStudio(args: {
  model?: string | null
  prompt?: string
  spec?: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: LocalLmStudioFetchImpl
  inventory?: {
    records: LocalLmStudioInventoryRecord[] | null
    status: LocalLmStudioAdmissionStatus
  }
}): Promise<LocalLmStudioAdmission> {
  const fallbacks = LOCAL_LM_STUDIO_FALLBACKS
  let inventoryFetches = 0
  let records: LocalLmStudioInventoryRecord[] | null
  let fetchStatus: LocalLmStudioAdmissionStatus
  if (args.inventory) {
    records = args.inventory.records
    fetchStatus = args.inventory.status
  } else {
    inventoryFetches += 1
    const fetched = await fetchLmStudioInventory({
      baseUrl: args.baseUrl,
      timeoutMs: args.timeoutMs,
      fetchImpl: args.fetchImpl
    })
    records = fetched.records
    fetchStatus = fetched.status === 'available' ? 'available' : fetched.status
  }

  const fail = (
    status: LocalLmStudioAdmissionStatus,
    contextWindow?: number
  ): LocalLmStudioAdmission => ({
    ok: false,
    status,
    selectedModel: null,
    fallbacks,
    inventoryFetches,
    effectsApplied: false,
    ...localLmStudioPromptSplitPlan(args.prompt, args.spec, contextWindow)
  })

  if (fetchStatus !== 'available') {
    return fail(fetchStatus === 'skipped' ? 'malformed_response' : fetchStatus)
  }
  if (!records) {
    return fail('malformed_response')
  }

  const candidates: string[] = []
  if (args.model) {
    candidates.push(args.model)
  }
  for (const fallback of fallbacks) {
    const already = candidates.some(
      (candidate) => normalizeLmStudioModelName(candidate) === normalizeLmStudioModelName(fallback)
    )
    if (!already) {
      candidates.push(fallback)
    }
  }

  let lastStatus: LocalLmStudioAdmissionStatus = 'model_absent'
  for (const candidate of candidates) {
    const record = findRecord(records, candidate)
    if (!record) {
      lastStatus = 'model_absent'
      continue
    }
    const window = recordContextWindow(record)
    const plan = localLmStudioPromptSplitPlan(args.prompt, args.spec, window)
    if (isContextUnsafe(record, args.prompt, args.spec)) {
      lastStatus = 'context_unsafe'
      if (
        args.model &&
        normalizeLmStudioModelName(candidate) === normalizeLmStudioModelName(args.model)
      ) {
        return {
          ...fail('context_unsafe', window),
          ...plan
        }
      }
      continue
    }
    return {
      ok: true,
      status: 'available',
      selectedModel: candidate.startsWith('lmstudio/')
        ? candidate
        : normalizeLmStudioModelName(candidate),
      fallbacks,
      inventoryFetches,
      effectsApplied: false,
      ...plan
    }
  }
  return fail(lastStatus)
}

export async function assertLocalLmStudioAdmission(args: {
  agent?: string | null
  model?: string | null
  prompt?: string
  spec?: string
  fetchImpl?: LocalLmStudioFetchImpl
  inventory?: {
    records: LocalLmStudioInventoryRecord[] | null
    status: LocalLmStudioAdmissionStatus
  }
  admit?: typeof admitLocalLmStudio
}): Promise<LocalLmStudioAdmission> {
  if (!shouldAdmitLocalLmStudio({ agent: args.agent, model: args.model })) {
    return {
      ok: true,
      status: 'skipped',
      selectedModel: null,
      fallbacks: LOCAL_LM_STUDIO_FALLBACKS,
      inventoryFetches: 0,
      effectsApplied: false,
      ...localLmStudioPromptSplitPlan(args.prompt, args.spec)
    }
  }
  const admit = args.admit ?? admitLocalLmStudio
  const admission = await admit({
    model: args.model,
    prompt: args.prompt,
    spec: args.spec,
    fetchImpl: args.fetchImpl,
    inventory: args.inventory
  })
  if (admission.ok) {
    return admission
  }
  throw new OrchestrationError(
    admission.status,
    `LM Studio admission refused worker-start (${admission.status}). No Dispatch, worktree, or terminal effects were applied.`,
    {
      ...admission,
      nextSteps: [
        'Start LM Studio on 127.0.0.1:1234 with qwen/qwen3-coder-30b (then qwen/qwen3-coder-next).',
        'Load Qwen at exactly 65536 context tokens; 8192 is explicitly unsafe.',
        `Keep the Task input at or below ${LOCAL_LM_STUDIO_INPUT_BUDGET} estimated tokens so ${LOCAL_LM_STUDIO_RESERVED_TOOL_TOKENS} tool and ${LOCAL_LM_STUDIO_RESERVED_OUTPUT_TOKENS} output tokens remain reserved.`,
        `If splitRequired is true, split the Task spec across at least ${admission.requiredChunks} workers before retrying.`
      ]
    }
  )
}

export async function assertLocalWorkerStartLmStudioAdmission(args: {
  agent?: string | null
  params: WorkerStartInput
  existingSpec?: string
  fetchImpl?: LocalLmStudioFetchImpl
  admit?: typeof admitLocalLmStudio
}): Promise<LocalLmStudioAdmission> {
  return assertLocalLmStudioAdmission({
    agent: args.agent,
    model: args.params.model,
    spec: args.params.spec ?? args.existingSpec ?? '',
    fetchImpl: args.fetchImpl,
    admit: args.admit
  })
}
