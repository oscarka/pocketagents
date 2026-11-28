import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HubCore } from '../../hub/hub-core.js'
import { HubAgent } from '../lib/hub-agent.js'
import { isHostLiveOnline } from '../../hub/web/src/utils/session-labels.js'
import { isTriageEligibleSession, buildTriageCardViewModel } from '../../hub/web/src/triage-deck.js'

test('HubCore 1-minute offline detection: emits host_liveness transition at 60s, preserves 10-min offline queue, and broadcasts instant wake-up', () => {
  let nowMs = 1_795_200_000_000
  const hub = new HubCore({ now: () => nowMs })
  const events = []
  hub.onStateChange(evt => events.push(evt))

  // 1. Initial heartbeat marks host live online
  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'cc的MacBook Air',
    platform: 'darwin',
    arch: 'arm64',
    bridgeState: {
      tasks: [{ id: 'sess-1', project: 'tibet-project', title: '西藏项目', status: 'running' }],
      approvals: [],
    },
  })
  assert.equal(hub.getFullState().hosts[0].online, true)
  assert.equal(hub.getFullState().hosts[0].activelyConnected, true)
  assert.equal(hub.getHostsSummary()[0].online, true)
  assert.equal(hub.getHostsSummary()[0].activelyConnected, true)

  // 2. At 55s still online — no transition
  nowMs += 55_000
  assert.equal(hub.checkHostLivenessTransitions(), false)
  assert.equal(hub.getFullState().hosts[0].online, true)

  // 3. Past 60s (1 minute) — flips offline & bumps stateSeq + fires host_liveness SSE event
  const seqBefore = hub.stateSeq
  nowMs += 6_000 // total 61s since last heartbeat
  assert.equal(hub.checkHostLivenessTransitions(), true)
  assert.equal(hub.stateSeq, seqBefore + 1)
  assert.equal(events[events.length - 1], 'host_liveness')
  const offlineState = hub.getFullState()
  assert.equal(offlineState.hosts[0].online, false)
  assert.equal(offlineState.hosts[0].activelyConnected, false)
  assert.equal(hub.getHostsSummary()[0].online, false)
  assert.equal(hub.getHostsSummary()[0].activelyConnected, false)

  // Second check while still offline must be a silent no-op (zero spam)
  assert.equal(hub.checkHostLivenessTransitions(), false)

  // 4. Sending a message while offline still queues for 10 minutes
  const queued = hub.queueCommand('mac-air', {
    type: 'prompt',
    agentId: 'sess-1',
    text: '上线后继续推进',
  })
  assert.equal(queued.ok, true)
  assert.equal(queued.command.queued, true)
  assert.equal(queued.command.expiresAt, nowMs + 10 * 60_000)

  // 5. Host wakes up with identical snapshot — livenessChanged triggers immediate broadcast back to online
  nowMs += 10_000
  const seqBeforeWake = hub.stateSeq
  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'cc的MacBook Air',
    platform: 'darwin',
    arch: 'arm64',
    liteHeartbeat: true,
  })
  assert.ok(hub.stateSeq > seqBeforeWake, 'Wake-up heartbeat must emit state update immediately')
  assert.equal(hub.getFullState().hosts[0].online, true)
  assert.equal(hub.getFullState().hosts[0].activelyConnected, true)
})

test('isHostLiveOnline and Swipe Triage: offline approvals are excluded while unread conclusions remain readable with offline badge', () => {
  assert.equal(isHostLiveOnline({ online: true, activelyConnected: true }), true)
  assert.equal(isHostLiveOnline({ online: true, activelyConnected: false }), false)
  assert.equal(isHostLiveOnline({ online: false, activelyConnected: false }), false)
  assert.equal(isHostLiveOnline(null), false)

  // Offline approval must NOT surface in Swipe Triage deck
  assert.equal(
    isTriageEligibleSession({
      id: 'sess-app-off',
      status: 'approval',
      hostOnline: false,
      approvalObj: { code: 'AGY-1' },
    }),
    false,
  )
  // Online approval surfaces normally
  assert.equal(
    isTriageEligibleSession({
      id: 'sess-app-on',
      status: 'approval',
      hostOnline: true,
      approvalObj: { code: 'AGY-2' },
    }),
    true,
  )
  // Offline unread conclusion remains readable and displays offline subtitle badge (ZH & EN)
  const offlineConc = {
    id: 'sess-conc-off',
    hostId: 'mac-air',
    hostName: 'cc的MacBook Air',
    hostOnline: false,
    project: 'tibet-project',
    title: '西藏项目',
    status: 'idle',
    hasUnreadConclusion: true,
    transcript: [{ role: 'assistant', text: '任务已完成' }],
  }
  assert.equal(isTriageEligibleSession(offlineConc), true)
  const vmZh = buildTriageCardViewModel(offlineConc, { 'mac-air': 'Air' }, 'zh')
  const vmEn = buildTriageCardViewModel(offlineConc, { 'mac-air': 'Air' }, 'en')
  assert.match(vmZh.sub, /⚪ 电脑离线/)
  assert.match(vmEn.sub, /⚪ Offline/)
})

test('Web UI offline state contracts: in-place dimmed grey rows, chat offline banner, 10-min queue send button, and fixed host sheet subtitle', async () => {
  const ctrlSrc = await readFile(join(process.cwd(), 'hub/web/src/controller.js'), 'utf8')
  const stageSrc = await readFile(join(process.cwd(), 'hub/web/src/components/ChatStage.tsx'), 'utf8')
  const cssSrc = await readFile(join(process.cwd(), 'hub/web/src/styles/app.css'), 'utf8')

  assert.match(stageSrc, /id="chatOfflineBanner"/, 'ChatStage must provide dedicated #chatOfflineBanner slot')
  assert.match(ctrlSrc, /row-host-offline/, 'Session rows for offline hosts must apply in-place dimmed row-host-offline class')
  assert.match(ctrlSrc, /⚪ 离线 · 上次运行中/, 'Stale running rows on offline hosts must downgrade from green running badge to grey offline badge')
  assert.match(ctrlSrc, /⚪ 离线 · 待上线审批/, 'Stale approval rows on offline hosts must downgrade to grey offline badge')
  assert.match(ctrlSrc, /⏳ 排队发送/, 'Offline chat composer must label send button as 10-min queue send')
  assert.match(ctrlSrc, /sendBtn\.classList\.add\('offline-queue'\)/, 'Offline chat send button must use distinct offline-queue visual style')
  assert.match(ctrlSrc, /renderHostSheetList\(\)/, 'Host switcher sheet must refresh live and display both offline timestamp and Feishu primary badge')
  assert.match(cssSrc, /\.session-row\.row-host-offline/, 'CSS must define light & dark styling for .row-host-offline')
  assert.match(cssSrc, /\.chat-offline-banner/, 'CSS must define styling for .chat-offline-banner')
})

test('HubAgent heartbeat anti-hang guard: aborts stalled TCP/body sockets at heartbeatTimeoutMs, preserves pendingResults, and recovers immediately on next tick', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'dsh-hb-timeout-'))
  try {
    let callCount = 0
    const receivedCommandResults = []
    const warnings = []
    const mockFetch = async (url, init) => {
      if (!String(url || '').endsWith('/api/heartbeat')) {
        return { ok: false, status: 404, json: async () => ({}) }
      }
      callCount += 1
      if (callCount === 1) {
        // Simulate a hung half-open IPv6 / proxy-switched TCP socket that never responds until aborted
        return await new Promise((_resolve, reject) => {
          assert.ok(init?.signal, 'POST /api/heartbeat must pass an AbortSignal')
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason || new Error('aborted'))
          })
        })
      }
      if (callCount === 2) {
        // Simulate headers returned ok, then body stalled mid-read until aborted
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                reject(init.signal.reason || new Error('body aborted'))
              })
            }),
        }
      }
      const parsed = JSON.parse(String(init?.body || '{}'))
      receivedCommandResults.push(...(parsed.commandResults || []))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, shouldConnectFeishu: false, commands: [] }),
      }
    }

    const agent = new HubAgent({
      config: {
        hubUrl: 'https://hub.example.test',
        hubToken: 'test-token',
        hostId: 'mac-air-test',
        hostName: 'Air Test',
        dshHome: tempHome,
        enableAntigravityIde: false,
        enableExternalHarnesses: false,
      },
      bridge: {
        getSnapshotState: () => ({ tasks: [], approvals: [], workspaces: [] }),
      },
      fetchImpl: mockFetch,
      execImpl: async () => ({ stdout: '', stderr: '' }),
      logger: { warn: msg => warnings.push(String(msg)) },
      heartbeatTimeoutMs: 120,
    })

    agent.pendingResults.push({ id: 'cmd-preserve-1', type: 'prompt', ok: true, at: Date.now() })

    // 1st tick: hung TCP connect -> must abort cleanly ~120ms, release polling lock, and keep pendingResults
    const t1 = Date.now()
    await agent.tick()
    const elapsed1 = Date.now() - t1
    assert.ok(elapsed1 >= 90 && elapsed1 < 1500, `hung connect must abort near 120ms (took ${elapsed1}ms)`)
    assert.equal(agent.polling, false, 'polling lock must be released after timeout')
    assert.equal(agent.pendingResults.length, 1, 'pendingResults must be restored after connect timeout')
    assert.equal(agent.pendingResults[0].id, 'cmd-preserve-1')

    // 2nd tick: hung JSON body -> must ALSO abort cleanly and keep pendingResults
    const t2 = Date.now()
    await agent.tick()
    const elapsed2 = Date.now() - t2
    assert.ok(elapsed2 >= 90 && elapsed2 < 1500, `hung body must abort near 120ms (took ${elapsed2}ms)`)
    assert.equal(agent.polling, false, 'polling lock must be released after body timeout')
    assert.equal(agent.pendingResults.length, 1, 'pendingResults must be restored after body timeout')

    // 3rd tick: healthy IPv4 path -> recovers immediately and delivers preserved commandResults
    await agent.tick()
    assert.equal(callCount, 3)
    assert.equal(agent.polling, false)
    assert.equal(agent.pendingResults.length, 0, 'pendingResults must be flushed once heartbeat succeeds')
    assert.deepEqual(
      receivedCommandResults.map(r => r.id),
      ['cmd-preserve-1'],
    )
    assert.ok(warnings.some(w => /heartbeat timeout after 120ms/.test(w)))
  } finally {
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('Host daemon network resilience contracts: IPv4-first DNS order, Happy Eyeballs 1500ms timeout, and SSE watchdog', async () => {
  const daemonSrc = await readFile(join(process.cwd(), 'dsh-feishu/daemon.mjs'), 'utf8')
  const turboSrc = await readFile(join(process.cwd(), 'dsh-turbo/index.js'), 'utf8')
  assert.match(daemonSrc, /setDefaultResultOrder\?\.\('ipv4first'\)/, 'daemon.mjs must prefer IPv4 over lossy IPv6')
  assert.match(daemonSrc, /setDefaultAutoSelectFamilyAttemptTimeout\?\.\(1500\)/, 'daemon.mjs must cap Happy Eyeballs attempt timeout to 1500ms')
  assert.match(turboSrc, /host SSE connect timeout/, 'TurboController SSE must guard against hung connect sockets')
  assert.match(turboSrc, /host SSE idle read timeout/, 'TurboController SSE must abort zombie silent sockets')
})
