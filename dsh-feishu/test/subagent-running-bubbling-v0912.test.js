import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGY_IDE_PREFIX,
  isSubagentActivelyRunning,
  loadAntigravityIdeSessions,
  executeAntigravityIdeAction,
} from '../lib/antigravity-ide.js'

function createMockExec() {
  return async cmd => {
    if (cmd === 'ps') {
      return {
        stdout: '54321 /Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token test-v0912-csrf\n',
      }
    }
    if (cmd === 'lsof') {
      return { stdout: 'p54321\nn127.0.0.1:55123\n' }
    }
    return { stdout: '' }
  }
}

async function writeParentTranscript(brainDir, parentId, subId) {
  const logsDir = join(brainDir, parentId, '.system_generated', 'logs')
  await mkdir(logsDir, { recursive: true })
  const lines = [
    JSON.stringify({
      step_index: 1,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-23T10:00:00Z',
      content: '上传参考图到 Tripo Studio 生成 3D 模型',
    }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T10:00:08Z',
      content: '已派发浏览器子智能体。',
      tool_calls: [
        {
          id: 'call-sub-tripo',
          name: 'invoke_subagent',
          args: {
            TypeName: 'browser',
            Role: 'Tripo Studio 3D Generator',
            Prompt: 'Upload reference images to studio.tripo3d.ai',
          },
        },
      ],
    }),
    JSON.stringify({
      step_index: 3,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-23T10:00:10Z',
      content: `Created the following subagent:\n{\n "conversationId": "${subId}"\n}`,
    }),
    JSON.stringify({
      step_index: 4,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-23T11:00:00Z',
      content: '怎么样',
    }),
    JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T11:00:20Z',
      content: '需要你先在手机或电脑上确认浏览器上传弹窗，批准后子智能体会继续在后台生成 3D。',
    }),
  ].join('\n')
  await writeFile(join(logsDir, 'transcript.jsonl'), lines, 'utf8')
}

test('v0.9.12 isSubagentActivelyRunning strict guards prevent false positives', () => {
  const now = Date.parse('2026-11-23T13:15:00Z')
  // Active fresh running subagent -> true
  assert.equal(
    isSubagentActivelyRunning({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: '2026-11-23T13:14:30Z',
    }, now),
    true,
  )
  // Idle browser subagent -> false
  assert.equal(
    isSubagentActivelyRunning({
      status: 'CASCADE_RUN_STATUS_IDLE',
      lastModifiedTime: '2026-11-23T13:14:59Z',
    }, now),
    false,
  )
  // Waiting for user popup -> false (handled by blockedSubagents as approval, not running)
  assert.equal(
    isSubagentActivelyRunning({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      waitingSteps: [{ index: 145 }],
      lastModifiedTime: '2026-11-23T13:14:50Z',
    }, now),
    false,
  )
  // Killed subagent -> false
  assert.equal(
    isSubagentActivelyRunning({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      killed: true,
      lastModifiedTime: '2026-11-23T13:14:50Z',
    }, now),
    false,
  )
  // Stale zombie running subagent (>= 15 min without modification) -> false
  assert.equal(
    isSubagentActivelyRunning({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: '2026-11-23T12:59:00Z',
    }, now),
    false,
  )
  // Just under 15 min -> still true
  assert.equal(
    isSubagentActivelyRunning({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: '2026-11-23T13:01:00Z',
    }, now),
    true,
  )
})

test('v0.9.12 Subagent RUNNING bubbling: IDLE parent shows running after approval, updates steps, and cleanly returns to idle on finish or stale timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agy-subagent-running-'))
  try {
    const brainDir = join(root, 'brain')
    const parentId = '8aa4c338-6818-479b-9199-686d572ba137'
    const subId = '56a39c4c-1dc6-4185-ba87-7469274af26e'
    const otherParentId = '99999999-8888-4777-8666-555555555555'
    await writeParentTranscript(brainDir, parentId, subId)

    // Write a second unrelated IDLE parent to prove zero cross-session bleed
    const otherLogsDir = join(brainDir, otherParentId, '.system_generated', 'logs')
    await mkdir(otherLogsDir, { recursive: true })
    await writeFile(
      join(otherLogsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-23T12:00:00Z',
          content: '总结一下今天的任务',
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-23T12:00:15Z',
          content: '今天的任务已经全部完成了。',
        }),
      ].join('\n'),
      'utf8',
    )

    const mockExec = createMockExec()
    let subSummaryState = {
      trajectoryId: subId,
      summary: 'Tripo Studio 3D Generator',
      trajectoryMetadata: {
        parentConversationId: parentId,
        rootConversationId: parentId,
        subagentSpec: { typeName: 'browser', role: 'Tripo Studio 3D Generator' },
      },
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: '2026-11-23T13:14:50Z',
      stepCount: 146,
    }

    const mockFetch = async url => {
      const method = String(url || '').split('/').pop()
      if (method === 'GetAllCascadeTrajectories') {
        return {
          ok: true,
          json: async () => ({
            trajectorySummaries: {
              [parentId]: {
                trajectoryId: parentId,
                summary: '食梦貘blender',
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-11-23T11:00:20Z',
                stepCount: 5,
              },
              [otherParentId]: {
                trajectoryId: otherParentId,
                summary: '无关会话',
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-11-23T12:00:15Z',
                stepCount: 2,
              },
              [subId]: subSummaryState,
            },
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    }

    // Phase 1: Child subagent is actively RUNNING at step 146 while parent was concluded 2 hours ago
    const sessions1 = await loadAntigravityIdeSessions({
      brainDirs: [brainDir],
      now: Date.parse('2026-11-23T13:15:00Z'),
      execImpl: mockExec,
      fetchImpl: mockFetch,
    })
    assert.equal(sessions1.length, 2)
    const parent1 = sessions1.find(s => s.rawId === parentId)
    const other1 = sessions1.find(s => s.rawId === otherParentId)
    assert.ok(parent1 && other1)

    // Unrelated parent MUST stay idle/conclusion
    assert.equal(other1.status, 'idle')
    assert.equal(other1.turnState, 'conclusion')
    assert.equal(other1.activeSubagents, undefined)

    // Target parent MUST surface running with live subagent details
    assert.equal(parent1.status, 'running')
    assert.equal(parent1.turnState, 'running')
    assert.equal(parent1.statusLabel, '🟢 运行中')
    assert.equal(parent1.hasActiveBackgroundTask, true)
    assert.equal(parent1.stateMeta?.source, 'ls-rpc')
    assert.equal(parent1.stateMeta?.confidence, 'high')
    assert.match(parent1.runningSummary, /🌐.*Tripo Studio 3D Generator.*146/)
    assert.equal(parent1.activeSubagents?.length, 1)
    assert.equal(parent1.activeSubagents[0].id, subId)
    assert.equal(parent1.activeSubagents[0].stepCount, 146)
    const subTool1 = parent1.transcript.flatMap(m => m.tools || []).find(t => t.subagentId === subId)
    assert.ok(subTool1)
    assert.equal(subTool1.subagentStatus, 'running')

    // Phase 2: Subagent advances to step 148 -> cache invalidates and updates summary + sessionRev
    subSummaryState = {
      ...subSummaryState,
      stepCount: 148,
      lastModifiedTime: '2026-11-23T13:15:20Z',
    }
    const sessions2 = await loadAntigravityIdeSessions({
      brainDirs: [brainDir],
      now: Date.parse('2026-11-23T13:15:25Z'),
      execImpl: mockExec,
      fetchImpl: mockFetch,
    })
    const parent2 = sessions2.find(s => s.rawId === parentId)
    assert.equal(parent2.status, 'running')
    assert.match(parent2.runningSummary, /148/)
    assert.notEqual(parent2.sessionRev, parent1.sessionRev)

    // Phase 3: Stale protection — if clock advances 16 minutes with no subagent progress, cleanly drops to idle
    const sessionsStale = await loadAntigravityIdeSessions({
      brainDirs: [brainDir],
      now: Date.parse('2026-11-23T13:31:30Z'),
      execImpl: mockExec,
      fetchImpl: mockFetch,
    })
    const parentStale = sessionsStale.find(s => s.rawId === parentId)
    assert.equal(parentStale.status, 'idle')
    assert.equal(parentStale.turnState, 'conclusion')
    assert.equal(parentStale.activeSubagents, undefined)

    // Phase 4: Subagent finishes and transitions to CASCADE_RUN_STATUS_IDLE (idle browser tab) -> stays idle
    subSummaryState = {
      ...subSummaryState,
      status: 'CASCADE_RUN_STATUS_IDLE',
      lastModifiedTime: '2026-11-23T13:16:00Z',
    }
    const sessionsDone = await loadAntigravityIdeSessions({
      brainDirs: [brainDir],
      now: Date.parse('2026-11-23T13:16:05Z'),
      execImpl: mockExec,
      fetchImpl: mockFetch,
    })
    const parentDone = sessionsDone.find(s => s.rawId === parentId)
    assert.equal(parentDone.status, 'idle')
    assert.equal(parentDone.turnState, 'conclusion')
    assert.equal(parentDone.statusLabel, '🔵 已出结论')
    assert.equal(parentDone.activeSubagents, undefined)
    const subToolDone = parentDone.transcript.flatMap(m => m.tools || []).find(t => t.subagentId === subId)
    assert.equal(subToolDone?.subagentStatus, 'done')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('v0.9.12 Stop action on parent session also cancels actively running child subagents via CancelCascadeInvocation', async () => {
  const parentId = '8aa4c338-6818-479b-9199-686d572ba137'
  const runningSubId = '56a39c4c-1dc6-4185-ba87-7469274af26e'
  const idleSubId = '77777777-6666-4555-8444-333333333333'
  const mockExec = createMockExec()
  const cancelledIds = []
  const nowIso = new Date().toISOString()

  const mockFetch = async (url, init) => {
    const method = String(url || '').split('/').pop()
    const body = init?.body ? JSON.parse(init.body) : {}
    if (method === 'GetAllCascadeTrajectories') {
      return {
        ok: true,
        json: async () => ({
          trajectorySummaries: {
            [parentId]: {
              trajectoryId: parentId,
              status: 'CASCADE_RUN_STATUS_IDLE',
              lastModifiedTime: nowIso,
            },
            [runningSubId]: {
              trajectoryId: runningSubId,
              trajectoryMetadata: { parentConversationId: parentId },
              status: 'CASCADE_RUN_STATUS_RUNNING',
              lastModifiedTime: nowIso,
            },
            [idleSubId]: {
              trajectoryId: idleSubId,
              trajectoryMetadata: { parentConversationId: parentId },
              status: 'CASCADE_RUN_STATUS_IDLE',
              lastModifiedTime: nowIso,
            },
          },
        }),
      }
    }
    if (method === 'CancelCascadeInvocation') {
      cancelledIds.push(body.cascadeId)
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => ({}) }
  }

  const res = await executeAntigravityIdeAction(
    { type: 'stop', agentId: `${AGY_IDE_PREFIX}${parentId}` },
    { execImpl: mockExec, fetchImpl: mockFetch },
  )
  assert.equal(res.ok, true)
  assert.ok(cancelledIds.includes(parentId), 'parent should be cancelled')
  assert.ok(cancelledIds.includes(runningSubId), 'actively running child subagent should be cancelled')
  assert.ok(!cancelledIds.includes(idleSubId), 'idle child subagent must NOT be cancelled')
  assert.match(res.message, /1 个后台子智能体/)
})
