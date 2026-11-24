import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { HubCore } from '../../hub/hub-core.js'
import { createHubServer } from '../../hub/server.js'
import { captureStateDigest, buildStateDelta } from '../../hub/delta-state.js'
import { applyStateDelta } from '../../hub/web/src/state/delta-merge.js'

function buildHeavyTranscript(msgCount, lastReplyText, extraToolsCount = 12) {
  const msgs = []
  for (let i = 0; i < msgCount; i += 1) {
    if (i % 2 === 0) {
      msgs.push({ role: 'user', text: `第 ${i / 2 + 1} 轮用户需求说明：请帮我深入排查日志并优化同步协议。` })
    } else {
      const isLast = i === msgCount - 1
      msgs.push({
        role: 'assistant',
        text: isLast ? lastReplyText : `第 ${(i + 1) / 2} 轮回复详情：` + '详细诊断结论与代码定位说明。'.repeat(120),
        thinking: `深度思考过程 #${i}: ` + '分析 SSE 流量与增量合并边界条件。'.repeat(280),
        tools: Array.from({ length: isLast ? extraToolsCount : 10 }, (_, k) => ({
          name: 'run_command',
          id: `tool-${i}-${k}`,
          summary: `执行检查步骤 #${k}`,
          commandLine: `python3 inspect_logs.py --step=${k} --verbose ` + 'x'.repeat(240),
        })),
      })
    }
  }
  return msgs
}

test('v0.9.17 Granular taskPatches achieve >95% raw SSE savings & bit-for-bit lossless reconstruction', () => {
  const baseTs = 1_795_520_000_000
  let nowMs = baseTs
  const hub = new HubCore({ now: () => nowMs })

  const baseReply = '正在实时分析服务端日志与增量同步状态：\n' + '已完成多轮采样与验证段落。'.repeat(25)
  const makeTasks = ({ msgCount = 14, reply = baseReply, tools = 12, rev = '14:100:running:running:', summary = '🔧 正在执行检查...' } = {}) => [
    {
      id: 'agy-ide:heavy-live-session',
      title: '超长实时排查会话',
      harness: 'antigravity-ide',
      status: 'running',
      turnState: 'running',
      sessionRev: rev,
      runningSummary: summary,
      updatedAt: nowMs,
      lastActivity: nowMs,
      messageCount: msgCount,
      artifacts: [{ name: 'plan.md', path: '/tmp/plan.md', kind: 'plan', title: '优化方案' }],
      changedFiles: [{ name: 'delta-state.js', path: 'hub/delta-state.js', added: 40, removed: 2 }],
      transcript: buildHeavyTranscript(msgCount, reply, tools),
    },
    ...Array.from({ length: 8 }, (_, idx) => ({
      id: `agy-ide:idle-${idx}`,
      title: `历史会话 ${idx}`,
      harness: 'antigravity-ide',
      status: 'idle',
      turnState: 'conclusion',
      updatedAt: baseTs - (idx + 2) * 30 * 60_000,
      lastActivity: baseTs - (idx + 2) * 30 * 60_000,
      messageCount: 10,
      transcript: buildHeavyTranscript(10, '历史结论正文：' + '段落内容。'.repeat(400), 8),
    })),
  ]

  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'cc的MacBook Air',
    bridgeState: { tasks: makeTasks(), approvals: [], workspaces: ['/Users/cc/proj'] },
  })

  const state1 = hub.getFullState()
  const liveTask1 = state1.hosts[0].bridgeState.tasks[0]
  const rawTask1Bytes = Buffer.byteLength(JSON.stringify(liveTask1), 'utf8')
  assert.ok(rawTask1Bytes > 50_000, `Expected heavy live task > 50KB raw, got ${rawTask1Bytes}B`)
  // Hot running session with long thinking/tools must NOT be flagged wireTruncated (stops 10s /transcript storm)
  assert.equal(liveTask1.wireTruncated, false)
  // Cold idle session (index >= 6 & >60m old) MUST remain wireTruncated for on-demand hydration
  const coldIdleTask = state1.hosts[0].bridgeState.tasks[8]
  assert.equal(coldIdleTask.wireTruncated, true)

  const digest1 = captureStateDigest(state1)

  // Tick 1: stream +60 chars text + 1 new tool call + summary bump
  nowMs += 1500
  const reply2 = baseReply + '\n新发现：重连旧 seq 触发 1.67MB 无压缩巨帧。'
  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'cc的MacBook Air',
    bridgeState: {
      tasks: makeTasks({ reply: reply2, tools: 13, rev: '14:101:running:running:', summary: '🔧 正在验证补丁...' }),
      approvals: [],
      workspaces: ['/Users/cc/proj'],
    },
  })
  const state2 = hub.getFullState()
  const { hasChanges: c1, delta: d1, nextDigest: digest2 } = buildStateDelta(digest1, state2, { granularTasks: true })
  assert.equal(c1, true)
  assert.equal(d1.hosts.length, 1)
  assert.equal(d1.hosts[0].upsertedTasks, undefined)
  assert.equal(d1.hosts[0].taskPatches.length, 1)
  assert.ok(d1.hosts[0].taskPatches[0].transcriptPatch.patchAtKeep.append.text.includes('1.67MB'))
  assert.equal(d1.hosts[0].taskPatches[0].transcriptPatch.patchAtKeep.toolsAppend.length, 1)

  const rawDelta1Bytes = Buffer.byteLength(JSON.stringify(d1), 'utf8')
  assert.ok(
    rawDelta1Bytes < 2500,
    `Expected granular streaming raw SSE delta < 2.5KB (vs ${rawTask1Bytes}B task), got ${rawDelta1Bytes}B`,
  )
  assert.ok(rawDelta1Bytes < rawTask1Bytes * 0.05, 'Granular delta must save >95% raw bytes vs full task')
  const merged2 = applyStateDelta(state1, d1)
  assert.equal(merged2.ok, true)
  assert.equal(merged2.noop, false)
  assert.deepStrictEqual(merged2.state, state2)

  // Tick 2: meta-only task update (transcript unchanged -> zero transcript bytes!)
  nowMs += 1500
  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'cc的MacBook Air',
    bridgeState: {
      tasks: makeTasks({ reply: reply2, tools: 13, rev: '14:102:running:running:', summary: '💭 正在整理最终结论...' }),
      approvals: [],
      workspaces: ['/Users/cc/proj'],
    },
  })
  const state3 = hub.getFullState()
  const { delta: d2, nextDigest: digest3 } = buildStateDelta(digest2, state3, { granularTasks: true })
  assert.equal(d2.hosts[0].taskPatches.length, 1)
  assert.equal(d2.hosts[0].taskPatches[0].transcriptPatch, undefined)
  const rawDelta2Bytes = Buffer.byteLength(JSON.stringify(d2), 'utf8')
  assert.ok(rawDelta2Bytes < 1000, `Expected meta-only task patch < 1KB raw, got ${rawDelta2Bytes}B`)
  const merged3 = applyStateDelta(state2, d2)
  assert.equal(merged3.ok, true)
  assert.deepStrictEqual(merged3.state, state3)

  // Tick 3: sliding window shift (15th message pushes oldest msg off the 14-msg wire window)
  nowMs += 1500
  const slidTr = [
    ...buildHeavyTranscript(14, reply2, 13),
    { role: 'user', text: '继续把回归测试也加上' },
  ]
  const tasks4 = makeTasks({ reply: reply2, tools: 13, rev: '15:103:running:running:', summary: '🔧 正在编写回归测试...' })
  tasks4[0].transcript = slidTr
  tasks4[0].messageCount = 15
  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'cc的MacBook Air',
    bridgeState: { tasks: tasks4, approvals: [], workspaces: ['/Users/cc/proj'] },
  })
  const state4 = hub.getFullState()
  const { delta: d3 } = buildStateDelta(digest3, state4, { granularTasks: true })
  assert.equal(d3.hosts[0].taskPatches.length, 1)
  assert.equal(d3.hosts[0].taskPatches[0].transcriptPatch.shift, 1)
  assert.equal(d3.hosts[0].taskPatches[0].transcriptPatch.keep, 13)
  assert.equal(d3.hosts[0].taskPatches[0].transcriptPatch.tail.length, 1)
  const rawDelta3Bytes = Buffer.byteLength(JSON.stringify(d3), 'utf8')
  assert.ok(rawDelta3Bytes < 2000, `Expected sliding-window shift patch < 2KB raw, got ${rawDelta3Bytes}B`)
  const merged4 = applyStateDelta(state3, d3)
  assert.equal(merged4.ok, true)
  assert.deepStrictEqual(merged4.state, state4)
})

test('v0.9.17 applyStateDelta handles stale in-flight delta safely and detects server seq_reset', () => {
  const baseState = { stateSeq: 430, hosts: [] }
  // Slightly older delta (e.g. concurrent /api/state already moved client ahead by 2 seqs) -> clean no-op
  const staleRes = applyStateDelta(baseState, { prevSeq: 427, stateSeq: 428 })
  assert.equal(staleRes.ok, true)
  assert.equal(staleRes.noop, true)
  assert.equal(staleRes.stale, true)

  // Large backward jump (e.g. Hub restarted and reset stateSeq to 2) -> must trigger resync
  const resetRes = applyStateDelta(baseState, { prevSeq: 1, stateSeq: 2 })
  assert.equal(resetRes.ok, false)
  assert.equal(resetRes.reason, 'seq_reset')

  // Forward gap -> still reports seq_mismatch
  const gapRes = applyStateDelta(baseState, { prevSeq: 432, stateSeq: 433 })
  assert.equal(gapRes.ok, false)
  assert.equal(gapRes.reason, 'seq_mismatch')
})

test('v0.9.17 SSE /api/events with tp=1&resync=1 eliminates megabyte resync frames & uses granular taskPatches', async () => {
  const baseTs = 1_795_520_000_000
  let nowMs = baseTs
  const hub = new HubCore({ now: () => nowMs })
  const baseReply = '实时诊断输出：' + '排查细节与性能数据。'.repeat(20)

  const makeTasks = (reply, rev) => [
    {
      id: 'agy-ide:sse-live',
      title: 'SSE 实测会话',
      harness: 'antigravity-ide',
      status: 'running',
      turnState: 'running',
      sessionRev: rev,
      runningSummary: '🔧 执行中...',
      updatedAt: nowMs,
      lastActivity: nowMs,
      messageCount: 14,
      transcript: buildHeavyTranscript(14, reply, 12),
    },
  ]

  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'cc的MacBook Air',
    bridgeState: { tasks: makeTasks(baseReply, '14:1:running:running:'), approvals: [], workspaces: [] },
  })
  const st1 = hub.getFullState()

  const { server } = createHubServer({
    hub,
    token: 'test-v0917-sse-stability-token-1234',
    requireToken: true,
    sseMinIntervalMs: 30,
    sseMaxLifetimeMs: 260,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const mobileHeaders = {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    }

    // 1. Stale seq with resync=1 MUST emit tiny `event: resync` and ZERO full `event: state`
    const resyncResp = await fetch(
      `http://127.0.0.1:${port}/api/events?initial=0&delta=1&tp=1&resync=1&seq=1&token=test-v0917-sse-stability-token-1234`,
      { headers: mobileHeaders },
    )
    assert.equal(resyncResp.status, 200)
    const resyncRaw = await resyncResp.text()
    assert.equal((resyncRaw.match(/^event: state$/gm) || []).length, 0)
    assert.equal((resyncRaw.match(/^event: resync$/gm) || []).length, 1)
    assert.ok(Buffer.byteLength(resyncRaw, 'utf8') < 1024, `Expected tiny resync stream < 1KB, got ${resyncRaw.length}B`)

    // 2. Aligned seq with tp=1&resync=1 emits compact `taskPatches` delta (<3KB vs >50KB full task)
    const liveResp = await fetch(
      `http://127.0.0.1:${port}/api/events?initial=0&delta=1&tp=1&resync=1&seq=${st1.stateSeq}&token=test-v0917-sse-stability-token-1234`,
      { headers: mobileHeaders },
    )
    assert.equal(liveResp.status, 200)
    const liveTextPromise = liveResp.text()
    nowMs += 1000
    hub.handleHeartbeat({
      hostId: 'mac-air',
      hostName: 'cc的MacBook Air',
      bridgeState: {
        tasks: makeTasks(baseReply + '\n增量追加一行文本。', '14:2:running:running:'),
        approvals: [],
        workspaces: [],
      },
    })
    const liveRaw = await liveTextPromise
    assert.equal((liveRaw.match(/^event: state$/gm) || []).length, 0)
    assert.equal((liveRaw.match(/^event: state_delta$/gm) || []).length, 1)
    assert.match(liveRaw, /"taskPatches":\[/)
    assert.doesNotMatch(liveRaw, /"upsertedTasks":\[/)
    assert.match(liveRaw, /增量追加一行文本/)
    assert.ok(Buffer.byteLength(liveRaw, 'utf8') < 3000, `Expected granular SSE stream < 3KB, got ${liveRaw.length}B`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('v0.9.17 Frontend controller & bundle enforce SSE stability invariants', async () => {
  const ctrlSrc = await readFile(join(process.cwd(), 'hub/web/src/controller.js'), 'utf8')
  assert.match(ctrlSrc, /\/api\/events\?initial=0&delta=1&tp=1&resync=1/)
  assert.match(ctrlSrc, /addEventListener\('resync'/)
  assert.match(ctrlSrc, /function scheduleSeqMismatchResync\(/)
  assert.match(ctrlSrc, /if \(isFullPayload && sseSource && sseUsingLite\)/)
  assert.match(ctrlSrc, /!\(hasLoadedFullState && \(s\.status === 'running' \|\| s\.status === 'approval'\)\)/)

  // Verify built production bundle carries the v0.9.17 SSE stability protocol
  const assetFiles = await readdir(join(process.cwd(), 'hub/public/assets'))
  const jsContents = await Promise.all(
    assetFiles.filter(f => f.endsWith('.js')).map(f => readFile(join(process.cwd(), 'hub/public/assets', f), 'utf8')),
  )
  const bundleSrc = jsContents.join('\n')
  assert.match(bundleSrc, /tp=1&resync=1/)
  assert.match(bundleSrc, /taskPatches/)
  assert.match(bundleSrc, /seq_reset/)
})
