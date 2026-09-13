import { describe, expect, it } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  isHermesCheckoutPath,
  mapFederatedExistingWorktreeSelector,
  type FederatedPlacementCatalog,
  type FederatedPlacementRepo,
  type FederatedPlacementWorktree
} from './federated-worker-placement'

const M5 = 'm5-mac'
const LIVEWELL_KEY = 'github.com/livewell/hub'
const HERMES_KEY = 'github.com/hermes-agent/hermes'

function repo(
  partial: Partial<FederatedPlacementRepo> & Pick<FederatedPlacementRepo, 'id' | 'path'>
): FederatedPlacementRepo {
  return {
    displayName: partial.id,
    ...partial
  }
}

function worktree(
  partial: Partial<FederatedPlacementWorktree> &
    Pick<FederatedPlacementWorktree, 'id' | 'path' | 'repoId'>
): FederatedPlacementWorktree {
  return {
    displayName: partial.repoId,
    ...partial
  }
}

const home: FederatedPlacementCatalog = {
  origin: 'home',
  repos: [
    repo({ id: 'root-folder', path: '/root', kind: 'folder', displayName: 'root' }),
    repo({
      id: 'hermes',
      path: '/root/.hermes',
      displayName: 'Hermes',
      gitRemoteIdentity: {
        canonicalKey: HERMES_KEY,
        remoteName: 'origin',
        remoteUrl: `https://${HERMES_KEY}.git`
      }
    }),
    repo({
      id: 'hub-one',
      path: '/root/prod',
      displayName: 'hub',
      gitRemoteIdentity: {
        canonicalKey: LIVEWELL_KEY,
        remoteName: 'origin',
        remoteUrl: `https://${LIVEWELL_KEY}.git`
      }
    })
  ],
  worktrees: [
    worktree({
      id: 'root-folder::/root',
      path: '/root',
      repoId: 'root-folder',
      hostId: 'local',
      displayName: 'root'
    }),
    worktree({
      id: 'hermes::/root/.hermes',
      path: '/root/.hermes',
      repoId: 'hermes',
      hostId: 'local',
      displayName: 'Hermes'
    }),
    worktree({
      id: 'hub-one::/root/prod',
      path: '/root/prod',
      repoId: 'hub-one',
      hostId: 'local',
      displayName: 'hub'
    })
  ]
}

const remote: FederatedPlacementCatalog = {
  origin: 'remote-server',
  repos: [
    repo({
      id: 'hub-m5',
      path: '/Users/oliver/hub',
      displayName: 'hub',
      gitRemoteIdentity: {
        canonicalKey: LIVEWELL_KEY,
        remoteName: 'origin',
        remoteUrl: `https://${LIVEWELL_KEY}.git`
      }
    }),
    repo({
      id: 'hermes-m5',
      path: '/Users/oliver/.hermes',
      displayName: 'Hermes',
      gitRemoteIdentity: {
        canonicalKey: HERMES_KEY,
        remoteName: 'origin',
        remoteUrl: `https://${HERMES_KEY}.git`
      }
    })
  ],
  worktrees: [
    worktree({
      id: 'hub-m5::/Users/oliver/hub',
      path: '/Users/oliver/hub',
      repoId: 'hub-m5',
      hostId: 'local',
      displayName: 'hub'
    }),
    worktree({
      id: 'hermes-m5::/Users/oliver/.hermes',
      path: '/Users/oliver/.hermes',
      repoId: 'hermes-m5',
      hostId: 'local',
      displayName: 'Hermes'
    })
  ]
}

describe('mapFederatedExistingWorktreeSelector', () => {
  it('maps One visible /root to the intended M5 checkout, not Hermes and not path:/root', () => {
    const mapped = mapFederatedExistingWorktreeSelector({
      selector: 'path:/root',
      targetEnvironmentId: M5,
      home,
      remote
    })
    expect(mapped).toBe('id:hub-m5::/Users/oliver/hub')
    expect(mapped).not.toContain('/root')
    expect(mapped).not.toMatch(/hermes/i)
  })

  it('maps a home git path by remote identity onto the M5 checkout', () => {
    expect(
      mapFederatedExistingWorktreeSelector({
        selector: 'path:/root/prod',
        targetEnvironmentId: M5,
        home,
        remote
      })
    ).toBe('id:hub-m5::/Users/oliver/hub')
  })

  it('does not place a /root dispatch onto Hermes even when Hermes is the only nested home match', () => {
    expect(isHermesCheckoutPath('/root/.hermes')).toBe(true)
    expect(
      mapFederatedExistingWorktreeSelector({
        selector: 'id:root-folder::/root',
        targetEnvironmentId: M5,
        home,
        remote
      })
    ).toBe('id:hub-m5::/Users/oliver/hub')
  })

  it('refuses to forward /root when the remote has no non-Hermes checkout', () => {
    expect(() =>
      mapFederatedExistingWorktreeSelector({
        selector: 'path:/root',
        targetEnvironmentId: M5,
        home,
        remote: {
          origin: 'remote-server',
          repos: remote.repos.filter((repo) => repo.id === 'hermes-m5'),
          worktrees: remote.worktrees.filter((worktree) => worktree.repoId === 'hermes-m5')
        }
      })
    ).toThrow(OrchestrationError)
    try {
      mapFederatedExistingWorktreeSelector({
        selector: 'path:/root',
        targetEnvironmentId: M5,
        home,
        remote: { origin: 'remote-server', repos: [], worktrees: [] }
      })
      throw new Error('expected mapping to refuse an absent remote path')
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      expect((error as OrchestrationError).code).toBe('worktree_not_found_on_server')
      expect((error as Error).message).not.toContain('path:/root was reused')
    }
  })

  it('keeps an explicit Hermes selector on the matching remote Hermes checkout', () => {
    expect(
      mapFederatedExistingWorktreeSelector({
        selector: 'path:/root/.hermes',
        targetEnvironmentId: M5,
        home,
        remote
      })
    ).toBe('id:hermes-m5::/Users/oliver/.hermes')
  })

  it('passes through new-top-level', () => {
    expect(
      mapFederatedExistingWorktreeSelector({
        selector: 'new-top-level',
        targetEnvironmentId: M5,
        home,
        remote
      })
    ).toBe('new-top-level')
  })
})
