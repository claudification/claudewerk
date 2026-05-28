export interface ListenerRegistry {
  addSpawnListener: (requestId: string, cb: (result: unknown) => void) => void
  removeSpawnListener: (requestId: string) => void
  resolveSpawn: (requestId: string, result: unknown) => void
  addDirListener: (requestId: string, cb: (result: unknown) => void) => void
  removeDirListener: (requestId: string) => void
  resolveDir: (requestId: string, result: unknown) => void
  addFileListener: (requestId: string, cb: (result: unknown) => void) => void
  removeFileListener: (requestId: string) => void
  resolveFile: (requestId: string, result: unknown) => boolean
  addCcSessionsListener: (requestId: string, cb: (result: unknown) => void) => void
  removeCcSessionsListener: (requestId: string) => void
  resolveCcSessions: (requestId: string, result: unknown) => void
  /** Pending `git_log_request` RPCs keyed by requestId (recap grounding). */
  addGitLogListener: (requestId: string, cb: (result: unknown) => void) => void
  removeGitLogListener: (requestId: string) => void
  resolveGitLog: (requestId: string, result: unknown) => void
  /** Pending `sentinel_patch_config` requests keyed by `patchId`. The REST
   *  route registers a listener, sends the patch over the sentinel WS, and the
   *  `sentinel_patch_config_ack` handler resolves it. `resolvePatch` returns
   *  `true` when a listener was waiting (so a late / unmatched ack is a no-op). */
  addPatchListener: (patchId: string, cb: (result: unknown) => void) => void
  removePatchListener: (patchId: string) => void
  resolvePatch: (patchId: string, result: unknown) => boolean
}

export function createListenerRegistry(): ListenerRegistry {
  const spawnListeners = new Map<string, (result: unknown) => void>()
  const dirListeners = new Map<string, (result: unknown) => void>()
  const fileListeners = new Map<string, (result: unknown) => void>()
  const ccSessionsListeners = new Map<string, (result: unknown) => void>()
  const gitLogListeners = new Map<string, (result: unknown) => void>()
  const patchListeners = new Map<string, (result: unknown) => void>()

  return {
    addSpawnListener(requestId, cb) {
      spawnListeners.set(requestId, cb)
    },
    removeSpawnListener(requestId) {
      spawnListeners.delete(requestId)
    },
    resolveSpawn(requestId, result) {
      const cb = spawnListeners.get(requestId)
      if (cb) {
        spawnListeners.delete(requestId)
        cb(result)
      }
    },
    addDirListener(requestId, cb) {
      dirListeners.set(requestId, cb)
    },
    removeDirListener(requestId) {
      dirListeners.delete(requestId)
    },
    resolveDir(requestId, result) {
      const cb = dirListeners.get(requestId)
      if (cb) {
        dirListeners.delete(requestId)
        cb(result)
      }
    },
    addFileListener(requestId, cb) {
      fileListeners.set(requestId, cb)
    },
    removeFileListener(requestId) {
      fileListeners.delete(requestId)
    },
    resolveFile(requestId, result) {
      const cb = fileListeners.get(requestId)
      if (cb) {
        fileListeners.delete(requestId)
        cb(result)
        return true
      }
      return false
    },
    addCcSessionsListener(requestId, cb) {
      ccSessionsListeners.set(requestId, cb)
    },
    removeCcSessionsListener(requestId) {
      ccSessionsListeners.delete(requestId)
    },
    resolveCcSessions(requestId, result) {
      const cb = ccSessionsListeners.get(requestId)
      if (cb) {
        ccSessionsListeners.delete(requestId)
        cb(result)
      }
    },
    addGitLogListener(requestId, cb) {
      gitLogListeners.set(requestId, cb)
    },
    removeGitLogListener(requestId) {
      gitLogListeners.delete(requestId)
    },
    resolveGitLog(requestId, result) {
      const cb = gitLogListeners.get(requestId)
      if (cb) {
        gitLogListeners.delete(requestId)
        cb(result)
      }
    },
    addPatchListener(patchId, cb) {
      patchListeners.set(patchId, cb)
    },
    removePatchListener(patchId) {
      patchListeners.delete(patchId)
    },
    resolvePatch(patchId, result) {
      const cb = patchListeners.get(patchId)
      if (cb) {
        patchListeners.delete(patchId)
        cb(result)
        return true
      }
      return false
    },
  }
}
