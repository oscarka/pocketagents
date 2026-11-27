import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyStateHysteresis,
  discoverAntigravityHubInstances,
  loadAntigravityIdeSessions,
} from '../lib/antigravity-ide.js'
import { HubCore } from '../../hub/hub-core.js'
import { createHubServer } from '../../hub/server.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('v0.9.48 Antigravity IDE 2.8.0 hub_<PORT>.json discovery: resolves CSRF from daemon JSON, rejects stale PID, ignores dead files', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'pa-agy28-home-'))
  const origCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN
  const origAddr = process.env.ANTIGRAVITY_LS_ADDRESS
  delete process.env.ANTIGRAVITY_CSRF_TOKEN
  delete process.env.ANTIGRAVITY_LS_ADDRESS
  try {
    const daemonDir = join(fakeHome, '.gemini', 'antigravity', 'daemon')
    const ideDaemonDir = join(fakeHome, '.gemini', 'antigravity-ide', 'daemon')
    await mkdir(daemonDir, { recursive: true })
    await mkdir(ideDaemonDir, { recursive: true })

    // Live v2.8.0 hub (matching PID 2711)
    await writeFile(
      join(daemonDir, 'hub_50899.json'),
      JSON.stringify({
        pid: 2711,
        httpsPort: 50901,
        httpPort: 50899,
        lsVersion: '2.35.2',
        csrfToken: 'v28-live-csrf-token-50899',
      }),
      'utf8',
    )

    // Stale file for port 51234 whose PID does NOT match live PID 9999
    await writeFile(
      join(daemonDir, 'hub_51234.json'),
      JSON.stringify({
        pid: 1111,
        httpsPort: 51236,
        httpPort: 51234,
        lsVersion: '2.34.0',
        csrfToken: 'stale-dead-pid-token',
      }),
      'utf8',
    )

    // Custom --app_data_dir=antigravity-ide file
    await writeFile(
      join(ideDaemonDir, 'hub_52000.json'),
      JSON.stringify({
        pid: 4242,
        httpsPort: 52002,
        httpPort: 52000,
        lsVersion: '2.35.2',
        csrfToken: 'ide-dir-csrf-token-52000',
      }),
      'utf8',
    )

    // 1. Live v2.8.0 hub + stale-PID hub + custom app_data_dir + legacy inline --csrf_token hub
    const psExec = async bin => {
      assert.equal(bin, 'ps')
      return {
        stdout: [
          `2711 ${join(fakeHome, '.gemini', 'bin', 'agy')} --hub --hub-port=50899 --app_data_dir=antigravity`,
          `9999 ${join(fakeHome, '.gemini', 'bin', 'agy')} --hub --hub-port=51234 --app_data_dir=antigravity`,
          `4242 ${join(fakeHome, '.gemini', 'bin', 'agy')} --hub --hub-port=52000 --app_data_dir=antigravity-ide`,
          `3333 ${join(fakeHome, '.gemini', 'bin', 'agy')} --hub --hub-port=53000 --csrf_token=legacy-inline-tok`,
        ].join('\n'),
      }
    }

    const found = await discoverAntigravityHubInstances({ execImpl: psExec, homeDir: fakeHome })
    assert.equal(found.length, 3, 'should discover live v2.8.0, custom app_data_dir, and legacy inline hubs, while rejecting stale PID 1111 != 9999')

    const live28 = found.find(h => h.port === 50899)
    assert.ok(live28)
    assert.equal(live28.address, '127.0.0.1:50899')
    assert.equal(live28.csrfToken, 'v28-live-csrf-token-50899')
    assert.equal(live28.binPath, join(fakeHome, '.gemini', 'bin', 'agy'))
    assert.equal(live28.kind, 'agy-hub')

    const customDirHub = found.find(h => h.port === 52000)
    assert.ok(customDirHub)
    assert.equal(customDirHub.csrfToken, 'ide-dir-csrf-token-52000')

    const legacyHub = found.find(h => h.port === 53000)
    assert.ok(legacyHub)
    assert.equal(legacyHub.csrfToken, 'legacy-inline-tok')

    assert.equal(found.find(h => h.port === 51234), undefined, 'stale hub_51234.json with mismatched PID must be rejected')

    // 2. Empty `ps` MUST return [] even though valid hub_*.json files exist on disk
    const emptyRes = await discoverAntigravityHubInstances({
      execImpl: async () => ({ stdout: '' }),
      homeDir: fakeHome,
    })
    assert.equal(emptyRes.length, 0, 'must never trust daemon JSON files without a live ps process')
  } finally {
    if (origCsrf !== undefined) process.env.ANTIGRAVITY_CSRF_TOKEN = origCsrf
    if (origAddr !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = origAddr
    await rm(fakeHome, { recursive: true, force: true })
  }
})

test('v0.9.48 end-to-end loadAntigravityIdeSessions with v2.8.0 hub JSON keeps 20-min-old running subagent session active (prevents false completed push)', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'pa-agy28-e2e-'))
  const origCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN
  const origAddr = process.env.ANTIGRAVITY_LS_ADDRESS
  delete process.env.ANTIGRAVITY_CSRF_TOKEN
  delete process.env.ANTIGRAVITY_LS_ADDRESS
  try {
    const daemonDir = join(fakeHome, '.gemini', 'antigravity', 'daemon')
    const brainDir = join(fakeHome, '.gemini', 'antigravity', 'brain')
    const mainConvId = '0c207017-test-main-conv'
    const subConvId = 'fcb2866a-test-sub-conv'
    const logsDir = join(brainDir, mainConvId, '.system_generated', 'logs')
    await mkdir(daemonDir, { recursive: true })
    await mkdir(logsDir, { recursive: true })

    await writeFile(
      join(daemonDir, 'hub_50899.json'),
      JSON.stringify({
        pid: 2711,
        httpsPort: 50901,
        httpPort: 50899,
        lsVersion: '2.35.2',
        csrfToken: 'e2e-v28-secret-token',
      }),
      'utf8',
    )

    // Transcript last updated 20 minutes ago (> 15-minute fallback ceiling!) while subagent is still running
    const now = Date.now()
    const twentyMinAgo = new Date(now - 20 * 60_000).toISOString()
    const transcript = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: twentyMinAgo,
        content: '<USER_REQUEST>跑全量压测</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: twentyMinAgo,
        content: '正在派发子智能体跑压测...',
        tool_calls: [{ name: 'invoke_subagent', id: 'tc-sub-1', arguments: '{"Role":"Load Tester"}' }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'TOOL_RESULT',
        created_at: twentyMinAgo,
        tool_name: 'invoke_subagent',
        tool_call_id: 'tc-sub-1',
        content: JSON.stringify({ conversationId: subConvId }),
      }),
    ].join('\n')
    await writeFile(join(logsDir, 'transcript.jsonl'), `${transcript}\n`, 'utf8')

    const psExec = async () => ({
      stdout: `2711 ${join(fakeHome, '.gemini', 'bin', 'agy')} --hub --hub-port=50899 --app_data_dir=antigravity\n`,
    })

    let seenToken = ''
    const fetchImpl = async (url, init) => {
      seenToken = init?.headers?.['x-codeium-csrf-token'] || ''
      if (String(url).endsWith('/GetAllCascadeTrajectories')) {
        return {
          ok: true,
          async json() {
            return {
              trajectorySummaries: {
                [mainConvId]: {
                  summary: 'minihealth压测',
                  stepCount: 3,
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  lastModifiedTime: twentyMinAgo,
                },
                [subConvId]: {
                  summary: 'Load Tester',
                  stepCount: 42,
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  lastModifiedTime: new Date(now - 2000).toISOString(),
                  trajectoryMetadata: {
                    parentConversationId: mainConvId,
                    rootConversationId: mainConvId,
                    subagentSpec: { role: 'Load Tester', typeName: 'self' },
                  },
                },
              },
            }
          },
        }
      }
      return { ok: false, async json() { return {} } }
    }

    const sessions = await loadAntigravityIdeSessions({
      brainDirs: [brainDir],
      now,
      execImpl: psExec,
      fetchImpl,
      homeDir: fakeHome,
    })

    assert.equal(seenToken, 'e2e-v28-secret-token', 'must authenticate to hub_50899 using daemon JSON csrfToken')
    const mainSess = sessions.find(s => s.rawId === mainConvId)
    assert.ok(mainSess, 'main session should be loaded')
    assert.equal(mainSess.hasLiveSummary, true)
    assert.equal(mainSess.status, 'running', '20-min-old main session with active subagent MUST stay running')
    assert.equal(mainSess.hasActiveBackgroundTask, true)
    assert.equal(mainSess.stateMeta?.source, 'ls-rpc')
    assert.equal(mainSess.stateMeta?.confidence, 'high')
    assert.equal(mainSess.activeSubagents?.length, 1)
    assert.equal(mainSess.activeSubagents[0].role, 'Load Tester')
  } finally {
    if (origCsrf !== undefined) process.env.ANTIGRAVITY_CSRF_TOKEN = origCsrf
    if (origAddr !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = origAddr
    await rm(fakeHome, { recursive: true, force: true })
  }
})

test('v0.9.48 applyStateHysteresis protects active high-confidence ls-rpc sessions from transient medium-confidence jsonl-tail idle drops', () => {
  const cache = new Map()
  const t0 = 100_000

  // 1. Live ls-rpc reports running
  const runningHigh = applyStateHysteresis(
    {
      id: 'agy-ide:med-hyst-1',
      status: 'running',
      turnState: 'running',
      isMidTurn: true,
      hasActiveBackgroundTask: true,
      hasLiveSummary: true,
      statusLabel: '🟢 运行中',
      lastStepIndex: 12,
      transcript: [{ role: 'user', text: 'deploy' }],
      pendingApproval: null,
      stateMeta: { source: 'ls-rpc', observedAt: t0, confidence: 'high' },
    },
    cache,
    t0,
  )
  assert.equal(runningHigh.status, 'running')

  // 2. 2s later, ls-rpc transiently times out -> falls back to jsonl-tail (medium) idle -> MUST stay running!
  const medDrop = applyStateHysteresis(
    {
      id: 'agy-ide:med-hyst-1',
      status: 'idle',
      turnState: 'conclusion',
      isMidTurn: false,
      hasActiveBackgroundTask: false,
      hasLiveSummary: false,
      statusLabel: '🔵 已出结论',
      lastStepIndex: 12,
      transcript: [{ role: 'user', text: 'deploy' }],
      pendingApproval: null,
      stateMeta: { source: 'jsonl-tail', observedAt: t0 + 2000, confidence: 'medium' },
    },
    cache,
    t0 + 2000,
  )
  assert.equal(medDrop.status, 'running', 'transient medium-confidence idle drop within 5s must be blocked')
  assert.equal(medDrop.turnState, 'running')
  assert.equal(medDrop.isMidTurn, true)
  assert.equal(medDrop.hasActiveBackgroundTask, true)
  assert.equal(medDrop.stateMeta.hysteresisProtected, true)
  assert.equal(medDrop.stateMeta.ignoredLowConfidenceSource, 'jsonl-tail')

  // 3. Genuine high-confidence ls-rpc idle arrives at t0 + 2500 -> settles immediately!
  const realIdleHigh = applyStateHysteresis(
    {
      id: 'agy-ide:med-hyst-1',
      status: 'idle',
      turnState: 'conclusion',
      isMidTurn: false,
      hasActiveBackgroundTask: false,
      hasLiveSummary: true,
      statusLabel: '🔵 已出结论',
      lastStepIndex: 14,
      transcript: [{ role: 'user', text: 'deploy' }],
      pendingApproval: null,
      stateMeta: { source: 'ls-rpc', observedAt: t0 + 2500, confidence: 'high' },
    },
    cache,
    t0 + 2500,
  )
  assert.equal(realIdleHigh.status, 'idle', 'authoritative high-confidence ls-rpc idle must settle immediately')
  assert.equal(realIdleHigh.turnState, 'conclusion')

  // 4. Separate ACP-only session with NO prior ls-rpc state: medium-confidence jsonl-tail idle is NOT blocked
  const acpIdle = applyStateHysteresis(
    {
      id: 'agy-ide:acp-only-1',
      status: 'idle',
      turnState: 'conclusion',
      isMidTurn: false,
      hasActiveBackgroundTask: false,
      hasLiveSummary: false,
      statusLabel: '🔵 已出结论',
      lastStepIndex: 5,
      transcript: [{ role: 'user', text: 'hi' }],
      pendingApproval: null,
      stateMeta: { source: 'jsonl-tail', observedAt: t0 + 3000, confidence: 'medium' },
    },
    cache,
    t0 + 3000,
  )
  assert.equal(acpIdle.status, 'idle', 'ACP-only session with no prior ls-rpc state must never be delayed')
})

test('v0.9.48 HubCore completion push debounce: suppresses running->idle->running flicker, cancels on approval/interrupted, fires once when stably idle, and respects read-during-debounce', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pa-debounce-hub-'))
  try {
    const hub = new HubCore({
      stateFile: join(root, 'hub-state.json'),
      completionPushDebounceMs: 120,
    })
    await hub.init()

    const completedCallbacks = []
    const sseEvents = []
    hub.onTaskCompleted = payload => completedCallbacks.push(payload)
    hub.onStateChange(evt => sseEvents.push(typeof evt === 'string' ? evt : evt?.type))

    const baseTask = {
      id: 'agy-ide:debounce-1',
      harness: 'antigravity-ide',
      title: '后端接口压测',
      project: 'minihealth',
      transcript: [{ role: 'user', text: '跑压测' }],
    }

    // 1. Task starts running
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: {
        tasks: [{ ...baseTask, status: 'running', turnState: 'running', isMidTurn: true, lastStepIndex: 10 }],
        approvals: [],
      },
    })
    assert.equal(hub.pushHistory.length, 0)

    // 2. Transient flicker to idle for 50ms (< 120ms debounce) -> then back to running!
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: {
        tasks: [{
          ...baseTask,
          status: 'idle',
          turnState: 'conclusion',
          isMidTurn: false,
          lastStepIndex: 11,
          lastConclusionAt: Date.now(),
          lastOutput: '中间阶段小结（尚未真正完成）',
        }],
        approvals: [],
      },
    })
    assert.equal(hub.pushHistory.length, 0, 'must NOT push immediately on first idle heartbeat')
    assert.equal(hub.pendingCompletionPushTimers.size, 1)

    await sleep(50)
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: {
        tasks: [{ ...baseTask, status: 'running', turnState: 'running', isMidTurn: true, lastStepIndex: 12 }],
        approvals: [],
      },
    })
    assert.equal(hub.pendingCompletionPushTimers.size, 0, 'resuming running must immediately cancel pending completion timer')

    await sleep(160)
    assert.equal(hub.pushHistory.length, 0, 'cancelled flicker must produce ZERO pushes')
    assert.equal(completedCallbacks.length, 0)
    assert.equal(hub.getFullState().sessionReadState[baseTask.id], undefined)

    // 3. Flicker to idle -> then approval arrives within 50ms -> completion MUST be cancelled, ONLY approval pushes!
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: {
        tasks: [{
          ...baseTask,
          status: 'idle',
          turnState: 'conclusion',
          isMidTurn: false,
          lastStepIndex: 13,
          lastConclusionAt: Date.now(),
          lastOutput: '准备执行部署命令',
        }],
        approvals: [],
      },
    })
    await sleep(45)
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: {
        tasks: [{
          ...baseTask,
          status: 'approval',
          turnState: 'approval',
          stateMeta: { source: 'ls-rpc', confidence: 'high' },
          lastStepIndex: 14,
        }],
        approvals: [{
          code: 'AGY-DEBOUNCE-14',
          harness: 'antigravity-ide',
          agentId: baseTask.id,
          title: baseTask.title,
          toolName: 'run_command',
          commandLine: 'gcloud run deploy',
          reason: 'Deploy service',
        }],
      },
    })
    await sleep(160)
    assert.equal(hub.pushHistory.length, 1, 'only approval push should fire, not completion push')
    assert.equal(hub.pushHistory[0].data.type, 'approval')

    // 4. Genuine completion arrives and stays stably idle past 120ms -> fires EXACTLY ONE completion push!
    const doneAt = Date.now()
    const doneTask = {
      ...baseTask,
      status: 'idle',
      turnState: 'conclusion',
      isMidTurn: false,
      lastStepIndex: 20,
      lastConclusionAt: doneAt,
      updatedAt: doneAt,
      lastOutput: '全部压测与部署已完成，无错误。',
    }
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: { tasks: [doneTask], approvals: [] },
    })
    assert.equal(hub.pushHistory.length, 1, 'still debouncing before 120ms')

    // Intermediate confirming idle heartbeat at 50ms keeps the timer alive
    await sleep(50)
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: { tasks: [doneTask], approvals: [] },
    })
    await sleep(140)

    assert.equal(hub.pushHistory.length, 2, 'debounced completion push must fire once stably idle')
    assert.equal(hub.pushHistory[1].data.type, 'completed')
    assert.equal(hub.pushHistory[1].title, '✅ 后端接口压测')
    assert.equal(hub.pushHistory[1].body, '全部压测与部署已完成，无错误。')
    assert.equal(completedCallbacks.length, 1)
    assert.equal(hub.getFullState().sessionReadState[baseTask.id]?.unread, true)
    assert.ok(sseEvents.includes('task_concluded'))

    // 5. Repeat heartbeats with identical conclusion never push again
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: { tasks: [doneTask], approvals: [] },
    })
    await sleep(150)
    assert.equal(hub.pushHistory.length, 2)

    // 6. Fast idle->idle new conclusion where user ALREADY reads it during debounce window -> preserves unread: false!
    const fastAt = Date.now()
    const fastDoneTask = {
      ...baseTask,
      status: 'idle',
      turnState: 'conclusion',
      isMidTurn: false,
      lastStepIndex: 24,
      lastConclusionAt: fastAt,
      updatedAt: fastAt,
      lastOutput: '第二轮补充结论已出炉',
    }
    hub.handleHeartbeat({
      hostId: 'air',
      hostName: 'MacBook Air',
      bridgeState: { tasks: [fastDoneTask], approvals: [] },
    })
    await sleep(40)
    hub.markSessionRead({
      sessionId: baseTask.id,
      sig: 'conclusion:24:第二轮补充结论已出炉',
      at: fastAt + 40,
    })
    await sleep(140)
    assert.equal(hub.pushHistory.length, 3, 'fast idle->idle conclusion commits after debounce')
    assert.equal(
      hub.getFullState().sessionReadState[baseTask.id]?.unread,
      false,
      'if user already read conclusion during debounce window, must NOT flip unread back to true',
    )

    // 7. Production createHubServer default HubCore enables non-zero completionPushDebounceMs (4500ms)
    const { hub: prodDefaultHub } = createHubServer({ token: 'prod-default-test-token' })
    assert.equal(prodDefaultHub.completionPushDebounceMs, 4500)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
