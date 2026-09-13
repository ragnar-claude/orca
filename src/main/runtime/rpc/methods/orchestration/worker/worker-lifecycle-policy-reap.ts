import { existsSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import {
  ENV_INCARNATION,
  ENV_SESSION,
  TERMINAL_LIVE_STATES,
  identityComplete,
  identitiesEqual,
  type PositiveIdentity,
  type ProcRecord,
  type ReapVerdict,
  type WorkerLifecycleState
} from './worker-lifecycle-policy-model'

function parseProcStat(
  text: string
): { pid: number; comm: string; ppid: number; pgrp: number } | null {
  const lparen = text.indexOf('(')
  const rparen = text.lastIndexOf(')')
  if (lparen === -1 || rparen === -1) {
    return null
  }
  const pid = Number.parseInt(text.slice(0, lparen).trim(), 10)
  const comm = text.slice(lparen + 1, rparen)
  const rest = text
    .slice(rparen + 1)
    .trim()
    .split(/\s+/)
  if (rest.length < 3 || !Number.isInteger(pid)) {
    return null
  }
  const ppid = Number.parseInt(rest[1] ?? '', 10)
  const pgrp = Number.parseInt(rest[2] ?? '', 10)
  if (!Number.isInteger(ppid) || !Number.isInteger(pgrp)) {
    return null
  }
  return { pid, comm, ppid, pgrp }
}

function parseEnviron(raw: Buffer): Record<string, string> {
  const env: Record<string, string> = {}
  for (const chunk of raw.toString('utf8').split('\0')) {
    if (!chunk.includes('=')) {
      continue
    }
    const eq = chunk.indexOf('=')
    env[chunk.slice(0, eq)] = chunk.slice(eq + 1)
  }
  return env
}

export function readLinuxProcessTable(procRoot = '/proc'): ProcRecord[] {
  const records: ProcRecord[] = []
  if (!existsSync(procRoot)) {
    return records
  }
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return records
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue
    }
    const pid = Number.parseInt(name, 10)
    const entry = `${procRoot}/${name}`
    let statText: string
    try {
      statText = readFileSync(`${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    const parsed = parseProcStat(statText)
    if (!parsed) {
      continue
    }
    let cwd: string | null = null
    try {
      const link = readlinkSync(`${entry}/cwd`)
      cwd = link.startsWith('/') ? resolvePath(link) : resolvePath(entry, link)
    } catch {
      cwd = null
    }
    let sessionId: string | null = null
    let incarnation: string | null = null
    try {
      const env = parseEnviron(readFileSync(`${entry}/environ`))
      sessionId = env[ENV_SESSION] || null
      incarnation = env[ENV_INCARNATION] || null
    } catch {
      // unverifiable environ is not identity
    }
    records.push({
      pid,
      pgid: parsed.pgrp,
      ppid: parsed.ppid,
      cwd,
      sessionId,
      incarnation,
      comm: parsed.comm
    })
  }
  return records
}

function identityOf(proc: ProcRecord): PositiveIdentity | null {
  if (!proc.cwd || !proc.sessionId || !proc.incarnation || proc.pgid <= 0) {
    return null
  }
  const ident: PositiveIdentity = {
    cwd: proc.cwd,
    sessionId: proc.sessionId,
    incarnation: proc.incarnation,
    pgid: proc.pgid
  }
  return identityComplete(ident) ? ident : null
}

export function reconcileOrphans(args: {
  claimed: PositiveIdentity
  table: readonly ProcRecord[]
  workerState: WorkerLifecycleState
  liveParentPids?: readonly number[]
}): ReapVerdict {
  const { claimed, table, workerState } = args
  const liveParentPids = args.liveParentPids ?? []
  if (!identityComplete(claimed)) {
    return {
      action: 'refuse',
      reason: 'claimed identity incomplete: cwd/session/incarnation/pgid required',
      pgid: claimed.pgid || null,
      identity: null,
      matchedPids: []
    }
  }
  if (TERMINAL_LIVE_STATES.has(workerState)) {
    return {
      action: 'refuse',
      reason: `worker still live in state ${workerState}; will not reap`,
      pgid: claimed.pgid,
      identity: claimed,
      matchedPids: []
    }
  }

  const matches: ProcRecord[] = []
  let unverifiable = 0
  for (const proc of table) {
    if (proc.pgid !== claimed.pgid) {
      continue
    }
    const ident = identityOf(proc)
    if (ident === null) {
      unverifiable += 1
      continue
    }
    if (identitiesEqual(ident, claimed)) {
      matches.push(proc)
    } else {
      return {
        action: 'refuse',
        reason: 'pgid members disagree on cwd/session/incarnation; unverifiable',
        pgid: claimed.pgid,
        identity: claimed,
        matchedPids: matches.map((row) => row.pid)
      }
    }
  }

  if (unverifiable) {
    return {
      action: 'refuse',
      reason: 'pgid has unverifiable members missing cwd/session/incarnation',
      pgid: claimed.pgid,
      identity: claimed,
      matchedPids: []
    }
  }
  if (!matches.length) {
    return {
      action: 'refuse',
      reason: 'no process positively matched claimed cwd/session/incarnation/pgid',
      pgid: claimed.pgid,
      identity: claimed,
      matchedPids: []
    }
  }

  const pids = matches.map((row) => row.pid)
  const liveParents = new Set(liveParentPids)
  const pidSet = new Set(pids)
  const orphan = matches.every((proc) => !liveParents.has(proc.ppid) && !pidSet.has(proc.ppid))
  const afterRelease: WorkerLifecycleState[] = ['releasing', 'closing', 'archiving', 'archived']
  if (!orphan && !afterRelease.includes(workerState)) {
    return {
      action: 'refuse',
      reason: 'process group still has a live parent; not an orphan',
      pgid: claimed.pgid,
      identity: claimed,
      matchedPids: pids
    }
  }
  if (!afterRelease.includes(workerState)) {
    return {
      action: 'refuse',
      reason: `orphan reap not authorized in state ${workerState}`,
      pgid: claimed.pgid,
      identity: claimed,
      matchedPids: pids
    }
  }
  return {
    action: 'reap',
    reason: 'positively identified orphan pgid (cwd/session/incarnation/pgid)',
    pgid: claimed.pgid,
    identity: claimed,
    matchedPids: pids
  }
}

export function reapFromProcessCount(count: number): ReapVerdict {
  return {
    action: 'refuse',
    reason: `refusing to reap from process count (${count}); positive identity required`,
    pgid: null,
    identity: null,
    matchedPids: []
  }
}
