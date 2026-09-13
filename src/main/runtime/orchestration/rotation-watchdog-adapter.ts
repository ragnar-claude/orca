/**
 * Coordinator-loop adapter for autonomous rotation-watchdog promotion.
 * Serving hook for /root/orca-control/rotation-watchdog.
 * Does not edit worker-lifecycle, resource-admission, or personality/SOUL files.
 */
export const EXACT_ORCA_PATH = '/root'
export const MODULE_ROOT = '/root/orca-control/rotation-watchdog'
export const SERVING_PROMOTION_HOOK = 'src/main/runtime/orchestration/rotation-watchdog-adapter.ts'
export const WORKTREE = 'id:22f53ae4-562e-43c9-907f-62ce3da5c07b::/root'
export const TOKEN_ROTATION_THRESHOLD = 120_000
export const SCHEMA = 'livewell.orca.rotation-watchdog-adapter.v1'

export const FORBIDDEN_OVERLAP_MARKERS = [
  'worker-lifecycle-policy',
  'local-lm-studio-admission',
  'resource-admission',
  'launch_guard',
  'oliver_persona',
  'SOUL'
] as const

export const SERVING_PROMOTION_CONTRACT = {
  schema: SCHEMA,
  exact_orca_path: EXACT_ORCA_PATH,
  module_root: MODULE_ROOT,
  serving_hook: SERVING_PROMOTION_HOOK,
  coordinator_loop: 'src/main/runtime/orchestration/coordinator.ts',
  public_api: [
    'planMailboxPreflight',
    'fenceGeneration',
    'planCheckpointNotification',
    'verifyFreshTakeover',
    'closeThenArchive',
    'assertSoleSourceOwner',
    'SERVING_PROMOTION_CONTRACT'
  ],
  forbidden_imports: [...FORBIDDEN_OVERLAP_MARKERS],
  does_not: [
    'acknowledge mailbox in preflight',
    'edit worker-lifecycle-policy',
    'edit resource-admission',
    'admit local-model/Qwen',
    'stop or release active workers',
    'touch personality/SOUL/PHI',
    'mutate /root/prod git'
  ],
  close_precedes_archive: true,
  retain_rollback: true,
  stop_on_source_ownership_overlap: true
} as const

export type MailboxSnapshot = {
  messageIds: readonly string[]
  acknowledged: boolean
  consumerGeneration: number
}

export type PreflightInput = {
  checkpointMessageIds: readonly string[]
  checkpointAcknowledged: boolean
  checkpointGeneration: number
  firstPeek: MailboxSnapshot
  secondPeek: MailboxSnapshot
}

export type PreflightResult = {
  ok: true
  acknowledgementPerformed: false
  preservedMessageIds: readonly string[]
  consumerGeneration: number
  mailArrivedDuringPreflight: readonly string[]
}

export function planMailboxPreflight(input: PreflightInput): PreflightResult {
  if (input.checkpointAcknowledged || input.checkpointMessageIds.length === 0) {
    throw new Error('checkpoint does not contain preserved unread mail')
  }
  if (input.firstPeek.acknowledged || input.secondPeek.acknowledged) {
    throw new Error('mailbox preflight must not acknowledge')
  }
  if (input.firstPeek.consumerGeneration !== input.secondPeek.consumerGeneration) {
    throw new Error('consumer generation changed during mailbox preflight')
  }
  if (input.firstPeek.consumerGeneration !== input.checkpointGeneration) {
    throw new Error('live consumer generation does not match checkpoint fence')
  }
  const missing = input.checkpointMessageIds.filter(
    (id) => !input.firstPeek.messageIds.includes(id) || !input.secondPeek.messageIds.includes(id)
  )
  if (missing.length > 0) {
    throw new Error(`checkpointed unread mail was not preserved: ${missing.join(',')}`)
  }
  return {
    ok: true,
    acknowledgementPerformed: false,
    preservedMessageIds: [...input.checkpointMessageIds],
    consumerGeneration: input.firstPeek.consumerGeneration,
    mailArrivedDuringPreflight: input.secondPeek.messageIds.filter(
      (id) => !input.firstPeek.messageIds.includes(id)
    )
  }
}

export function fenceGeneration(liveGeneration: number, expectedGeneration: number): number {
  if (liveGeneration !== expectedGeneration) {
    throw new Error(
      `generation fence failed before execution: live=${liveGeneration} expected=${expectedGeneration}`
    )
  }
  return liveGeneration
}

export function planCheckpointNotification(args: {
  triggered: boolean
  reasons: readonly string[]
  recipient: string
}): { planned: boolean; type: 'handoff'; subject: string; body: string; recipient: string } {
  return {
    planned: args.triggered,
    type: 'handoff',
    recipient: args.recipient,
    subject: 'Coordinator rotation checkpoint requested',
    body: args.triggered
      ? `Dry-run watchdog matched: ${args.reasons.join(', ')}`
      : 'No rotation trigger matched'
  }
}

export function replacementLaunchCommand(model: string, effort = 'medium'): readonly string[] {
  if (!model.trim()) {
    throw new Error('replacement launch requires an explicit model argument')
  }
  return [
    'codex',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m',
    model,
    '-c',
    `model_reasoning_effort=${effort}`,
    '-C',
    '/root'
  ]
}

export function verifyFreshTakeover(args: {
  runId: string
  expectedRunId: string
  replacementHandle: string
  liveHandle: string
  priorGeneration: number
  liveGeneration: number
}): { ok: true; consumerGeneration: number } {
  if (args.runId !== args.expectedRunId) {
    throw new Error('replacement is not bound to checkpoint run')
  }
  if (args.liveHandle !== args.replacementHandle) {
    throw new Error('verified replacement takeover failed: coordinator handle mismatch')
  }
  if (!Number.isInteger(args.liveGeneration) || args.liveGeneration <= args.priorGeneration) {
    throw new Error('verified replacement takeover failed: consumer generation did not advance')
  }
  return { ok: true, consumerGeneration: args.liveGeneration }
}

export function closeThenArchive(args: {
  oldHandle: string
  closed: boolean
  stillListed: boolean
}): { closed: true; archived: true; closePrecededArchive: true } {
  if (!args.closed) {
    throw new Error('old coordinator close must precede archive')
  }
  if (args.stillListed) {
    throw new Error('old coordinator still present after close')
  }
  return { closed: true, archived: true, closePrecededArchive: true }
}

export function assertSoleSourceOwner(args: {
  owner: string
  lockOwner?: string | null
  foreignAdapterExists: boolean
}): { ok: true; owner: string } {
  if (args.lockOwner && args.lockOwner !== args.owner) {
    throw new Error(`source ownership overlap: lock held by ${args.lockOwner}`)
  }
  if (args.foreignAdapterExists) {
    throw new Error('source ownership overlap: adapter already exists in another worktree')
  }
  return { ok: true, owner: args.owner }
}

export function workersPreserved(
  before: readonly string[],
  after: readonly string[]
): { ok: true } {
  const missing = before.filter((id) => !after.includes(id))
  const extra = after.filter((id) => !before.includes(id))
  if (missing.length || extra.length) {
    throw new Error('active workers were not preserved across rotation')
  }
  return { ok: true }
}

export function tokenTrigger(newInputTokens: number): boolean {
  return newInputTokens >= TOKEN_ROTATION_THRESHOLD
}
