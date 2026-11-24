// Incremental SSE state digest & diff engine for DSH Remote Control Hub.
// Computes compact JSON deltas (`event: state_delta`) so multi-host heartbeats
// only transmit changed host metadata and changed session tasks (~1-3 KB gzipped)
// instead of re-broadcasting the entire multi-host state (~360+ KB gzipped).

const OMITTED_TOP_KEYS = new Set(['hosts', 'now', 'stateSeq'])

function captureObjectKeyStrings(obj, omitKeys = null) {
  const map = new Map()
  if (!obj || typeof obj !== 'object') return map
  for (const [k, v] of Object.entries(obj)) {
    if (omitKeys && omitKeys.has(k)) continue
    if (v === undefined) continue
    map.set(k, JSON.stringify(v))
  }
  return map
}

function diffObjectAgainstDigest(prevMap, nextObj, omitKeys = null) {
  const changed = {}
  const deleted = []
  let hasChanged = false
  const seen = new Set()

  if (nextObj && typeof nextObj === 'object') {
    for (const [k, v] of Object.entries(nextObj)) {
      if (omitKeys && omitKeys.has(k)) continue
      seen.add(k)
      if (v === undefined) {
        if (prevMap.has(k)) {
          deleted.push(k)
          hasChanged = true
        }
        continue
      }
      const nextStr = JSON.stringify(v)
      if (prevMap.get(k) !== nextStr) {
        changed[k] = v
        hasChanged = true
      }
    }
  }

  for (const prevKey of prevMap.keys()) {
    if (!seen.has(prevKey)) {
      deleted.push(prevKey)
      hasChanged = true
    }
  }

  return { hasChanged, changed, deleted }
}

function captureHostDigest(host) {
  const { bridgeState, ...hostMeta } = host || {}
  const { tasks = [], ...bridgeMeta } =
    bridgeState && typeof bridgeState === 'object' ? bridgeState : {}
  const safeTasks = Array.isArray(tasks) ? tasks : []
  const taskOrder = []
  const taskStrings = new Map()
  for (const t of safeTasks) {
    if (!t || !t.id) continue
    taskOrder.push(t.id)
    taskStrings.set(t.id, JSON.stringify(t))
  }
  return {
    hasBridgeState: Boolean(bridgeState && typeof bridgeState === 'object'),
    hostMetaStrings: captureObjectKeyStrings(hostMeta),
    bridgeMetaStrings: captureObjectKeyStrings(bridgeMeta),
    taskOrder,
    taskOrderJson: JSON.stringify(taskOrder),
    taskStrings,
  }
}

export function captureStateDigest(fullState) {
  const state = fullState && typeof fullState === 'object' ? fullState : {}
  const rawHosts = Array.isArray(state.hosts) ? state.hosts : []
  const hostOrder = []
  const hosts = new Map()
  for (const h of rawHosts) {
    if (!h || !h.hostId) continue
    hostOrder.push(h.hostId)
    hosts.set(h.hostId, captureHostDigest(h))
  }
  return {
    stateSeq: Number(state.stateSeq) || 0,
    topStrings: captureObjectKeyStrings(state, OMITTED_TOP_KEYS),
    hostOrder,
    hostOrderJson: JSON.stringify(hostOrder),
    hosts,
  }
}

function buildMessagePatch(prevMsg, nextMsg) {
  if (!prevMsg || typeof prevMsg !== 'object' || !nextMsg || typeof nextMsg !== 'object') {
    return null
  }
  const set = {}
  const append = {}
  const del = []
  let toolsAppend = null
  let changed = false

  const seen = new Set()
  for (const [k, nextVal] of Object.entries(nextMsg)) {
    seen.add(k)
    if (nextVal === undefined) {
      if (prevMsg[k] !== undefined) {
        del.push(k)
        changed = true
      }
      continue
    }
    const prevVal = prevMsg[k]
    if (
      (k === 'text' || k === 'thinking') &&
      typeof prevVal === 'string' &&
      typeof nextVal === 'string'
    ) {
      if (prevVal === nextVal) continue
      if (prevVal.length >= 64 && nextVal.startsWith(prevVal)) {
        append[k] = nextVal.slice(prevVal.length)
        changed = true
        continue
      }
      set[k] = nextVal
      changed = true
      continue
    }
    if (k === 'tools' && Array.isArray(prevVal) && Array.isArray(nextVal)) {
      if (prevVal.length <= nextVal.length) {
        let prefixSame = true
        for (let i = 0; i < prevVal.length; i += 1) {
          if (JSON.stringify(prevVal[i]) !== JSON.stringify(nextVal[i])) {
            prefixSame = false
            break
          }
        }
        if (prefixSame) {
          if (nextVal.length > prevVal.length) {
            toolsAppend = nextVal.slice(prevVal.length)
            changed = true
          }
          continue
        }
      }
      set[k] = nextVal
      changed = true
      continue
    }
    if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
      set[k] = nextVal
      changed = true
    }
  }

  for (const prevKey of Object.keys(prevMsg)) {
    if (!seen.has(prevKey) && prevMsg[prevKey] !== undefined) {
      del.push(prevKey)
      changed = true
    }
  }

  if (!changed) return null
  const patch = {}
  if (Object.keys(set).length > 0) patch.set = set
  if (Object.keys(append).length > 0) patch.append = append
  if (toolsAppend && toolsAppend.length > 0) patch.toolsAppend = toolsAppend
  if (del.length > 0) patch.del = del
  return patch
}

function buildTranscriptPatch(prevTr, nextTr) {
  if (!Array.isArray(prevTr) || !Array.isArray(nextTr)) return null
  const prevStrs = prevTr.map(m => JSON.stringify(m))
  const nextStrs = nextTr.map(m => JSON.stringify(m))

  if (prevStrs.length === nextStrs.length) {
    let allSame = true
    for (let i = 0; i < prevStrs.length; i += 1) {
      if (prevStrs[i] !== nextStrs[i]) {
        allSame = false
        break
      }
    }
    if (allSame) return { unchanged: true }
  }

  // Detect sliding window shift (e.g. `.slice(-14)` dropped 1-4 oldest messages from the front)
  let bestShift = 0
  let bestPrefix = 0
  const maxShift = Math.min(4, prevStrs.length)
  for (let shift = 0; shift <= maxShift; shift += 1) {
    let prefix = 0
    const avail = prevStrs.length - shift
    const limit = Math.min(avail, nextStrs.length)
    while (prefix < limit && prevStrs[shift + prefix] === nextStrs[prefix]) {
      prefix += 1
    }
    if (prefix > bestPrefix || (shift === 0 && prefix === bestPrefix)) {
      bestPrefix = prefix
      bestShift = shift
    }
    // If shift=0 already matched at least one message, no need to probe front-shifts
    if (shift === 0 && prefix > 0) break
  }

  const shiftedPrev = bestShift > 0 ? prevTr.slice(bestShift) : prevTr
  let patchAtKeep = null
  let tailStart = bestPrefix
  if (bestPrefix < shiftedPrev.length && bestPrefix < nextTr.length) {
    const candidate = buildMessagePatch(shiftedPrev[bestPrefix], nextTr[bestPrefix])
    if (candidate) {
      const candidateLen = JSON.stringify(candidate).length + 24
      const rawLen = nextStrs[bestPrefix].length
      if (candidateLen < rawLen) {
        patchAtKeep = candidate
        tailStart = bestPrefix + 1
      }
    }
  }

  const tail = nextTr.slice(tailStart)
  const patch = {
    shift: bestShift,
    keep: bestPrefix,
  }
  if (patchAtKeep) patch.patchAtKeep = patchAtKeep
  if (tail.length > 0) patch.tail = tail
  return { unchanged: false, patch }
}

function buildTaskPatch(prevTask, nextTask) {
  if (!prevTask || typeof prevTask !== 'object' || !nextTask || typeof nextTask !== 'object') {
    return null
  }
  const set = {}
  const del = []
  let transcriptPatch = null
  let hasAny = false

  const seen = new Set()
  for (const [k, nextVal] of Object.entries(nextTask)) {
    seen.add(k)
    if (k === 'transcript') {
      if (Array.isArray(prevTask.transcript) && Array.isArray(nextVal)) {
        const trRes = buildTranscriptPatch(prevTask.transcript, nextVal)
        if (trRes && !trRes.unchanged && trRes.patch) {
          transcriptPatch = trRes.patch
          hasAny = true
        }
      } else if (JSON.stringify(prevTask.transcript) !== JSON.stringify(nextVal)) {
        if (nextVal === undefined) {
          if (prevTask.transcript !== undefined) {
            del.push('transcript')
            hasAny = true
          }
        } else {
          set.transcript = nextVal
          hasAny = true
        }
      }
      continue
    }
    if (nextVal === undefined) {
      if (prevTask[k] !== undefined) {
        del.push(k)
        hasAny = true
      }
      continue
    }
    if (JSON.stringify(prevTask[k]) !== JSON.stringify(nextVal)) {
      set[k] = nextVal
      hasAny = true
    }
  }

  for (const prevKey of Object.keys(prevTask)) {
    if (!seen.has(prevKey) && prevTask[prevKey] !== undefined) {
      del.push(prevKey)
      hasAny = true
    }
  }

  if (!hasAny) return null
  const out = { id: nextTask.id }
  if (Object.keys(set).length > 0) out.set = set
  if (del.length > 0) out.del = del
  if (transcriptPatch) out.transcriptPatch = transcriptPatch
  return out
}

export function buildStateDelta(prevDigest, nextState, { granularTasks = false } = {}) {
  const nextDigest = captureStateDigest(nextState)
  if (!prevDigest) {
    return {
      hasChanges: true,
      fullResetRequired: true,
      delta: null,
      nextDigest,
    }
  }

  const prevSeq = Number(prevDigest.stateSeq) || 0
  const stateSeq = nextDigest.stateSeq
  const delta = {
    prevSeq,
    stateSeq,
    now: Number(nextState?.now) || Date.now(),
  }

  let hasStructuralChanges = false

  const topDiff = diffObjectAgainstDigest(prevDigest.topStrings, nextState, OMITTED_TOP_KEYS)
  if (topDiff.hasChanged) {
    if (Object.keys(topDiff.changed).length > 0) {
      delta.top = topDiff.changed
    }
    if (topDiff.deleted.length > 0) {
      delta.topDeleted = topDiff.deleted
    }
    hasStructuralChanges = true
  }

  const nextHosts = Array.isArray(nextState?.hosts) ? nextState.hosts : []
  const nextHostIds = new Set(nextDigest.hostOrder)
  const removedHostIds = prevDigest.hostOrder.filter(id => !nextHostIds.has(id))
  if (removedHostIds.length > 0) {
    delta.removedHostIds = removedHostIds
    hasStructuralChanges = true
  }
  if (prevDigest.hostOrderJson !== nextDigest.hostOrderJson) {
    delta.hostOrder = nextDigest.hostOrder
    hasStructuralChanges = true
  }

  const hostPatches = []
  for (const host of nextHosts) {
    if (!host || !host.hostId) continue
    const prevHost = prevDigest.hosts.get(host.hostId)
    if (!prevHost) {
      hostPatches.push({ hostId: host.hostId, fullHost: host })
      hasStructuralChanges = true
      continue
    }

    const { bridgeState, ...hostMeta } = host
    const hasBridge = Boolean(bridgeState && typeof bridgeState === 'object')
    if (!hasBridge || !prevHost.hasBridgeState) {
      if (hasBridge !== prevHost.hasBridgeState) {
        hostPatches.push({ hostId: host.hostId, fullHost: host })
        hasStructuralChanges = true
        continue
      }
    }

    const hostMetaDiff = diffObjectAgainstDigest(prevHost.hostMetaStrings, hostMeta)
    const { tasks = [], ...bridgeMeta } = hasBridge ? bridgeState : {}
    const bridgeMetaDiff = diffObjectAgainstDigest(prevHost.bridgeMetaStrings, bridgeMeta)

    const safeTasks = Array.isArray(tasks) ? tasks : []
    const nextHostDigest = nextDigest.hosts.get(host.hostId)
    const nextTaskIds = new Set(nextHostDigest.taskOrder)
    const removedTaskIds = prevHost.taskOrder.filter(id => !nextTaskIds.has(id))
    const taskOrderChanged = prevHost.taskOrderJson !== nextHostDigest.taskOrderJson

    const upsertedTasks = []
    const taskPatches = []
    for (const t of safeTasks) {
      if (!t || !t.id) continue
      const nextTaskStr = nextHostDigest.taskStrings.get(t.id)
      const prevTaskStr = prevHost.taskStrings.get(t.id)
      if (prevTaskStr !== nextTaskStr) {
        if (granularTasks && prevTaskStr) {
          try {
            const prevTaskObj = JSON.parse(prevTaskStr)
            const tPatch = buildTaskPatch(prevTaskObj, t)
            if (tPatch && JSON.stringify(tPatch).length + 32 < nextTaskStr.length) {
              taskPatches.push(tPatch)
              continue
            }
          } catch {
            // fall back to full task upsert
          }
        }
        upsertedTasks.push(t)
      }
    }

    if (
      hostMetaDiff.hasChanged ||
      bridgeMetaDiff.hasChanged ||
      removedTaskIds.length > 0 ||
      taskOrderChanged ||
      upsertedTasks.length > 0 ||
      taskPatches.length > 0
    ) {
      const patch = { hostId: host.hostId }
      if (Object.keys(hostMetaDiff.changed).length > 0) {
        patch.hostMeta = hostMetaDiff.changed
      }
      if (hostMetaDiff.deleted.length > 0) {
        patch.hostMetaDeleted = hostMetaDiff.deleted
      }
      if (Object.keys(bridgeMetaDiff.changed).length > 0) {
        patch.bridgeMeta = bridgeMetaDiff.changed
      }
      if (bridgeMetaDiff.deleted.length > 0) {
        patch.bridgeMetaDeleted = bridgeMetaDiff.deleted
      }
      if (removedTaskIds.length > 0) {
        patch.removedTaskIds = removedTaskIds
      }
      if (upsertedTasks.length > 0) {
        patch.upsertedTasks = upsertedTasks
      }
      if (taskPatches.length > 0) {
        patch.taskPatches = taskPatches
      }
      if (taskOrderChanged) {
        patch.taskOrder = nextHostDigest.taskOrder
      }
      hostPatches.push(patch)
      hasStructuralChanges = true
    }
  }

  if (hostPatches.length > 0) {
    delta.hosts = hostPatches
  }

  const seqAdvanced = stateSeq !== prevSeq
  return {
    hasChanges: hasStructuralChanges || seqAdvanced,
    hasStructuralChanges,
    delta,
    nextDigest,
  }
}
