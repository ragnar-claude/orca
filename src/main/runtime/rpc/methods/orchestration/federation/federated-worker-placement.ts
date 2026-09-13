import {
  LOCAL_EXECUTION_HOST_ID,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { runtimePathsEqual } from '../../../../runtime-worktree-path-identity'
import type { GitRemoteIdentity } from '../../../../../../shared/git-remote-identity'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

export type FederatedPlacementWorktree = Pick<
  Worktree,
  'id' | 'path' | 'repoId' | 'displayName' | 'hostId'
> & {
  identity?: { key: string }
}

export type FederatedPlacementRepo = Pick<
  Repo,
  'id' | 'path' | 'displayName' | 'kind' | 'connectionId' | 'executionHostId' | 'gitRemoteIdentity'
>

export type FederatedPlacementCatalog = {
  origin: 'home' | 'remote-server'
  worktrees: readonly FederatedPlacementWorktree[]
  repos: readonly FederatedPlacementRepo[]
}

const HERMES_PATH = /(^|\/)\.hermes(?=\/|$)/i

export function isHermesCheckoutPath(worktreePath: string): boolean {
  return HERMES_PATH.test(worktreePath.replace(/\\/g, '/'))
}

function repoById(
  repos: readonly FederatedPlacementRepo[],
  repoId: string
): FederatedPlacementRepo | undefined {
  return repos.find((repo) => repo.id === repoId)
}

function hostIdFor(
  worktree: FederatedPlacementWorktree,
  repos: readonly FederatedPlacementRepo[]
): ExecutionHostId {
  return getWorktreeExecutionHostId(worktree, repoById(repos, worktree.repoId))
}

function isOnTargetHost(
  worktree: FederatedPlacementWorktree,
  catalog: FederatedPlacementCatalog,
  targetEnvironmentId: string
): boolean {
  if (catalog.origin === 'remote-server') {
    return true
  }
  const hostId = hostIdFor(worktree, catalog.repos)
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'runtime') {
    return parsed.environmentId === targetEnvironmentId
  }
  return hostId === toRuntimeExecutionHostId(targetEnvironmentId)
}

function isHomeLocal(
  worktree: FederatedPlacementWorktree,
  catalog: FederatedPlacementCatalog
): boolean {
  return hostIdFor(worktree, catalog.repos) === LOCAL_EXECUTION_HOST_ID
}

function identityKey(identity: GitRemoteIdentity | null | undefined): string | null {
  const key = identity?.canonicalKey?.trim()
  return key ? key : null
}

function selectorPath(selector: string): string | null {
  if (selector.startsWith('path:')) {
    return selector.slice('path:'.length)
  }
  if (selector.startsWith('/') || /^[A-Za-z]:[\\/]/.test(selector)) {
    return selector
  }
  if (selector.startsWith('id:')) {
    const body = selector.slice(3)
    const separator = body.indexOf('::')
    if (separator !== -1) {
      return body.slice(separator + 2).replace(/::workspace:[0-9a-f-]+$/i, '')
    }
  }
  return null
}

function selectorNamesHermes(selector: string): boolean {
  const path = selectorPath(selector)
  return Boolean(path && isHermesCheckoutPath(path)) || /hermes/i.test(selector)
}

function matchesSelector(worktree: FederatedPlacementWorktree, selector: string): boolean {
  if (selector.startsWith('identity:')) {
    return worktree.identity?.key === selector.slice('identity:'.length)
  }
  if (selector.startsWith('id:')) {
    const worktreeId = selector.slice(3)
    return worktree.id === worktreeId || worktree.id === selector
  }
  if (selector.startsWith('name:')) {
    return worktree.displayName === selector.slice(5)
  }
  if (selector.startsWith('folder:')) {
    return worktree.id === selector || worktree.id === `folder:${selector.slice(7)}`
  }
  const path = selectorPath(selector)
  return path !== null && runtimePathsEqual(worktree.path, path)
}

function remoteSelectorFor(worktree: FederatedPlacementWorktree): string {
  return worktree.id.startsWith('folder:') ? worktree.id : `id:${worktree.id}`
}

function isNestedUnder(childPath: string, parentPath: string): boolean {
  const child = childPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const parent = parentPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return child !== parent && (child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`))
}

/**
 * Translate a home-visible worktree selector into a selector the remote host can
 * resolve. A One `/root` path must not be forwarded: on M5 it is absent or can
 * collapse onto a nested Hermes checkout.
 */
export function mapFederatedExistingWorktreeSelector(args: {
  selector: string
  targetEnvironmentId: string
  home: FederatedPlacementCatalog
  remote: FederatedPlacementCatalog
}): string {
  const { selector, targetEnvironmentId, home, remote } = args
  if (selector === 'new-top-level') {
    return selector
  }

  const remoteCandidates = remote.worktrees.filter((worktree) =>
    isOnTargetHost(worktree, remote, targetEnvironmentId)
  )
  const remoteExact = remoteCandidates.filter((worktree) => matchesSelector(worktree, selector))
  if (remoteExact.length === 1) {
    return remoteSelectorFor(remoteExact[0])
  }
  if (remoteExact.length > 1) {
    throw new OrchestrationError(
      'selector_ambiguous',
      `Worktree ${selector} matches more than one checkout on the selected worker server.`
    )
  }

  const homeMatches = home.worktrees.filter(
    (worktree) => isHomeLocal(worktree, home) && matchesSelector(worktree, selector)
  )
  if (homeMatches.length > 1) {
    throw new OrchestrationError(
      'selector_ambiguous',
      `Worktree ${selector} is ambiguous on the home host and cannot be translated for remote placement.`
    )
  }

  const allowHermes = selectorNamesHermes(selector)
  const intendedRemote = remoteCandidates.filter(
    (worktree) => allowHermes || !isHermesCheckoutPath(worktree.path)
  )

  const homeMatch = homeMatches[0]
  if (homeMatch) {
    const homeRepo = repoById(home.repos, homeMatch.repoId)
    const homeIdentity = identityKey(homeRepo?.gitRemoteIdentity)
    if (homeIdentity) {
      const identityMatches = intendedRemote.filter((worktree) => {
        const remoteRepo = repoById(remote.repos, worktree.repoId)
        return identityKey(remoteRepo?.gitRemoteIdentity) === homeIdentity
      })
      if (identityMatches.length === 1) {
        return remoteSelectorFor(identityMatches[0])
      }
    }

    const nameMatches = intendedRemote.filter(
      (worktree) => worktree.displayName === homeMatch.displayName
    )
    if (nameMatches.length === 1) {
      return remoteSelectorFor(nameMatches[0])
    }

    const container =
      homeRepo?.kind === 'folder' ||
      home.worktrees.some(
        (candidate) => isHomeLocal(candidate, home) && isNestedUnder(candidate.path, homeMatch.path)
      )
    if (container && intendedRemote.length === 1) {
      return remoteSelectorFor(intendedRemote[0])
    }
  }

  if (intendedRemote.length === 1 && selectorPath(selector)) {
    return remoteSelectorFor(intendedRemote[0])
  }

  throw new OrchestrationError(
    'worktree_not_found_on_server',
    `Worktree ${selector} is a home-host path and does not map to a checkout on the selected worker server.`
  )
}

export function federatedWorktreeSelectorNeedsTranslation(selector: string): boolean {
  return (
    selector.startsWith('path:') ||
    selector.startsWith('folder:') ||
    selector.startsWith('/') ||
    selector.includes('::')
  )
}

function asCatalogSlice(value: unknown, key: 'worktrees' | 'repos'): unknown[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const listed = (value as Record<string, unknown>)[key]
  return Array.isArray(listed) ? listed : []
}

export async function translateFederatedWorktreeSelector(args: {
  runtime: OrcaRuntimeService
  selector: string
  targetEnvironmentId: string
  timeoutMs: number
  pairingFence: { expectedEnvironmentPairingRevision: number }
}): Promise<string> {
  if (!federatedWorktreeSelectorNeedsTranslation(args.selector)) {
    return args.selector
  }
  const homeList = await args.runtime.listManagedWorktrees(undefined, 10_000)
  const home: FederatedPlacementCatalog = {
    origin: 'home',
    worktrees: homeList.worktrees,
    repos: args.runtime.listRepos()
  }
  let remote: FederatedPlacementCatalog = { origin: 'remote-server', worktrees: [], repos: [] }
  try {
    const [worktrees, repos] = await Promise.all([
      args.runtime.callOrchestrationWorkerServer(
        args.targetEnvironmentId,
        'worktree.list',
        { limit: 10_000 },
        args.timeoutMs,
        undefined,
        args.pairingFence
      ),
      args.runtime.callOrchestrationWorkerServer(
        args.targetEnvironmentId,
        'repo.list',
        undefined,
        args.timeoutMs,
        undefined,
        args.pairingFence
      )
    ])
    remote = {
      origin: 'remote-server',
      worktrees: asCatalogSlice(worktrees, 'worktrees') as FederatedPlacementCatalog['worktrees'],
      repos: asCatalogSlice(repos, 'repos') as FederatedPlacementCatalog['repos']
    }
  } catch {
    remote = { origin: 'remote-server', worktrees: [], repos: [] }
  }
  return mapFederatedExistingWorktreeSelector({
    selector: args.selector,
    targetEnvironmentId: args.targetEnvironmentId,
    home,
    remote
  })
}
