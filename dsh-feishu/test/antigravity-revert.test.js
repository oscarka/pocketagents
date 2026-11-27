import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  clearLocalAntigravityRevertCeilings,
  discoverAntigravityHubInstances,
  loadAntigravityIdeSessions,
  parseAntigravityTranscript,
  previewAntigravityRevert,
  revertAntigravityToStep,
  shutdownEphemeralRevertHub,
} from '../lib/antigravity-ide.js'
import { translateZhStringToEn } from '../../hub/web/src/utils/i18n.js'
import { HubCore } from '../../hub/hub-core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

function makeMockPsExec({ port = 43210, csrf = 'csrf_test_token_123', pid = 99999 } = {}) {
  return async (cmd, args) => {
    const joined = `${cmd} ${(args || []).join(' ')}`
    if (cmd === 'ps' || joined.includes('ps ')) {
      return {
        stdout: `${pid} /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token ${csrf} --workspace_id ws_demo\n`,
        stderr: '',
      }
    }
    if (cmd === 'lsof' || joined.includes('lsof')) {
      return {
        stdout: `p${pid}\nn127.0.0.1:${port}\n`,
        stderr: '',
      }
    }
    return { stdout: '', stderr: '' }
  }
}

test('parseAntigravityTranscript preserves numeric stepIndex on USER_INPUT and handles step-0 empty revert', () => {
  const jsonl = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>先帮我把按钮改成三段式</USER_REQUEST>',
      created_at: '2026-11-26T10:00:00Z',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: '好的，已经修改完成。',
      status: 'DONE',
      created_at: '2026-11-26T10:00:05Z',
    }),
    JSON.stringify({
      step_index: 4,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>再顺便把顶部颜色改成深蓝</USER_REQUEST>',
      created_at: '2026-11-26T10:01:00Z',
    }),
    JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      content: '已经改成深蓝了。',
      status: 'DONE',
      created_at: '2026-11-26T10:01:05Z',
    }),
  ].join('\n')

  const parsed = parseAntigravityTranscript(jsonl, {
    conversationId: 'conv-abc-123',
    mtimeMs: Date.parse('2026-11-26T10:01:05Z'),
    now: Date.parse('2026-11-26T10:02:00Z'),
  })
  assert.ok(parsed, 'parsed session should exist')
  const userMsgs = parsed.transcript.filter(m => m.role === 'user')
  assert.equal(userMsgs.length, 2)
  assert.equal(userMsgs[0].stepIndex, 0)
  assert.equal(userMsgs[1].stepIndex, 4)

  // Reverted to step 4 (so stepCount=4, lastUserInputStepIndex=0)
  const revertedMid = parseAntigravityTranscript(jsonl, {
    conversationId: 'conv-abc-123',
    mtimeMs: Date.parse('2026-11-26T10:01:05Z'),
    now: Date.parse('2026-11-26T10:02:00Z'),
    hasLiveSummary: true,
    liveStepCount: 4,
    liveLastUserInputStepIndex: 0,
    liveStatus: 'CASCADE_RUN_STATUS_IDLE',
    liveLastModifiedMs: Date.parse('2026-11-26T10:01:50Z'),
  })
  assert.ok(revertedMid)
  assert.equal(revertedMid.transcript.filter(m => m.role === 'user').length, 1)
  assert.equal(revertedMid.transcript[0].stepIndex, 0)

  // Reverted all the way back to step 0 (stepCount=0): session stays visible with empty transcript
  const revertedZero = parseAntigravityTranscript(jsonl, {
    conversationId: 'conv-abc-123',
    mtimeMs: Date.parse('2026-11-26T10:01:05Z'),
    now: Date.parse('2026-11-26T10:02:00Z'),
    nativeTitle: '按钮优化任务',
    nativeWorkspace: { cwd: '/Users/cc/demo-app', project: 'demo-app' },
    hasLiveSummary: true,
    liveStepCount: 0,
    liveStatus: 'CASCADE_RUN_STATUS_IDLE',
    liveLastModifiedMs: Date.parse('2026-11-26T10:01:55Z'),
  })
  assert.ok(revertedZero, 'reverted-to-zero session should remain visible instead of returning null')
  assert.equal(revertedZero.transcript.length, 0)
  assert.equal(revertedZero.status, 'idle')
  assert.equal(revertedZero.project, 'demo-app')
  assert.match(revertedZero.lastOutput, /已撤回到对话起点/)
})

test('previewAntigravityRevert queries GetRevertPreview and normalizes affected files', async () => {
  const calls = []
  const execImpl = makeMockPsExec({ port: 43211, csrf: 'csrf_preview_1' })
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {}
    calls.push({ url, headers: opts.headers, body })
    if (url.endsWith('/GetAllCascadeTrajectories')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trajectorySummaries: {
            '11111111-2222-3333-4444-555555555555': { stepCount: 6 },
          },
        }),
      }
    }
    if (url.endsWith('/GetCascadeTrajectory')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ trajectory: { steps: [] } }),
      }
    }
    if (url.endsWith('/GetRevertPreview')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          codeEditPreviews: [
            {
              fileUri: 'file:///Users/cc/demo-app/src/App.tsx',
              actionType: 'CODE_REVERT_ACTION_TYPE_MODIFY',
            },
            {
              fileUri: 'file:///Users/cc/demo-app/src/NewHelper.ts',
              actionType: 'CODE_REVERT_ACTION_TYPE_DELETE',
            },
            {
              fileUri: 'file:///Users/cc/demo-app/src/OldLegacy.ts',
              actionType: 'CODE_REVERT_ACTION_TYPE_CREATE',
            },
          ],
        }),
      }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }

  const res = await previewAntigravityRevert('agy-ide:11111111-2222-3333-4444-555555555555', 4, {
    preferredCwd: '/Users/cc/demo-app',
    execImpl,
    fetchImpl,
  })
  assert.equal(res.ok, true)
  assert.equal(res.stepIndex, 4)
  assert.equal(res.fileCount, 3)
  assert.deepEqual(
    res.files.map(f => ({ basename: f.basename, relPath: f.relPath, actionType: f.actionType })),
    [
      { basename: 'App.tsx', relPath: 'src/App.tsx', actionType: 'modify' },
      { basename: 'NewHelper.ts', relPath: 'src/NewHelper.ts', actionType: 'delete' },
      { basename: 'OldLegacy.ts', relPath: 'src/OldLegacy.ts', actionType: 'create' },
    ],
  )
  const previewCall = calls.find(c => c.url.endsWith('/GetRevertPreview'))
  assert.ok(previewCall)
  assert.equal(previewCall.headers['x-codeium-csrf-token'], 'csrf_preview_1')
  assert.equal(previewCall.body.cascadeId, '11111111-2222-3333-4444-555555555555')
  assert.equal(previewCall.body.stepIndex, 4)
})

test('revertAntigravityToStep supports both full code revert and conversationOnly mode', async () => {
  const revertPayloads = []
  let cancelledCount = 0
  const execImpl = makeMockPsExec({ port: 43212, csrf: 'csrf_rev_2' })
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {}
    if (url.endsWith('/GetAllCascadeTrajectories')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trajectorySummaries: {
            'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { stepCount: 10 },
          },
        }),
      }
    }
    if (url.endsWith('/CancelCascadeInvocation')) {
      cancelledCount += 1
      return { ok: true, status: 200, json: async () => ({}) }
    }
    if (url.endsWith('/RevertToCascadeStep')) {
      revertPayloads.push(body)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          metadata: {
            revertedUris: body.conversationOnly
              ? []
              : ['file:///Users/cc/demo-app/src/App.tsx', 'file:///Users/cc/demo-app/src/index.css'],
          },
        }),
      }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }

  const fullRes = await revertAntigravityToStep('agy-ide:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 2, {
    conversationOnly: false,
    preferredCwd: '/Users/cc/demo-app',
    execImpl,
    fetchImpl,
  })
  assert.equal(fullRes.ok, true)
  assert.equal(fullRes.conversationOnly, false)
  assert.equal(fullRes.revertedCount, 2)
  assert.equal(cancelledCount, 1)
  assert.equal(revertPayloads[0].stepIndex, 2)
  assert.equal(revertPayloads[0].conversationOnly, false)

  const chatOnlyRes = await revertAntigravityToStep('agy-ide:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 2, {
    conversationOnly: true,
    preferredCwd: '/Users/cc/demo-app',
    execImpl,
    fetchImpl,
  })
  assert.equal(chatOnlyRes.ok, true)
  assert.equal(chatOnlyRes.conversationOnly, true)
  assert.equal(chatOnlyRes.revertedCount, 0)
  assert.equal(revertPayloads[1].conversationOnly, true)
})

test('mobile revert sheet includes explicit Cancel button, Antigravity-only guard, and EN i18n', async () => {
  const sheetsSrc = await readFile(resolve(REPO_ROOT, 'hub/web/src/components/Sheets.tsx'), 'utf8')
  const ctrlSrc = await readFile(resolve(REPO_ROOT, 'hub/web/src/controller.js'), 'utf8')

  assert.match(sheetsSrc, /id="revertConfirmSheet"/)
  assert.match(sheetsSrc, /cancelAntigravityRevertSheet/)

  assert.match(ctrlSrc, /isAntigravityRevertEligibleSession/)
  assert.match(ctrlSrc, /openAntigravityRevertSheet/)
  assert.match(ctrlSrc, /confirmAntigravityRevert\(false\)/)
  assert.match(ctrlSrc, /confirmAntigravityRevert\(true\)/)
  assert.match(ctrlSrc, /id="revertCancelBtn"/)
  assert.match(ctrlSrc, /onclick="cancelAntigravityRevertSheet\(\)"/)
  assert.match(ctrlSrc, /hydratedWireTranscriptBySession\.delete\(targetSessionId\)/)
  assert.match(ctrlSrc, /expandedTranscriptBySession\.delete\(targetSessionId\)/)
  assert.match(ctrlSrc, /document\.getElementById\('globalPromptInput'\)/)

  assert.equal(translateZhStringToEn('↩ 撤回到此处'), '↩ Revert here')
  assert.equal(translateZhStringToEn('↩ 撤回对话并还原代码'), '↩ Revert Chat & Code')
  assert.equal(translateZhStringToEn('💬 仅撤回对话，保留已改代码'), '💬 Revert Chat Only (Keep Code)')
  assert.equal(translateZhStringToEn('📁 受影响的代码文件（共 3 个）'), '📁 Affected Code Files (3)')
  assert.equal(translateZhStringToEn('↩ 撤回对话并还原代码（3 个文件）'), '↩ Revert Chat & Code (3 files)')
})

test('HubCore.compactBridgeStateForWire preserves stepIndex even on synthetic preserved lastUserMsg', () => {
  const hub = new HubCore({ now: () => 1_800_000_000_000 })
  const bridgeState = {
    tasks: [
      {
        id: 'agy-ide:conv-wire-1',
        harness: 'antigravity-ide',
        status: 'idle',
        updatedAt: 1_800_000_000_000,
        transcript: [
          { role: 'user', text: '第一条指令', stepIndex: 0, time: 1_799_999_900_000 },
          { role: 'assistant', text: '中间回复 1', time: 1_799_999_910_000 },
          { role: 'assistant', text: '中间回复 2', time: 1_799_999_920_000 },
          { role: 'assistant', text: '最终结论', time: 1_799_999_930_000 },
        ],
      },
    ],
    approvals: [],
    workspaces: [],
  }
  const compactedLite = hub.compactBridgeStateForWire(bridgeState, 1_800_000_000_000, { lite: true })
  const liteUser = compactedLite.tasks[0].transcript.find(m => m.role === 'user')
  assert.ok(liteUser, 'synthetic lastUserMsg should be preserved in lite mode')
  assert.equal(liteUser.stepIndex, 0, 'stepIndex must be preserved on synthetic lastUserMsg')
})

test('standalone Antigravity 2.0 / ACP host falls back to on-demand ephemeral agy --hub, hides it from IDE discovery, and syncs local revert ceiling', async () => {
  shutdownEphemeralRevertHub()
  clearLocalAntigravityRevertCeilings()
  const prevLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS
  const prevLsCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN
  delete process.env.ANTIGRAVITY_LS_ADDRESS
  delete process.env.ANTIGRAVITY_CSRF_TOKEN
  const tmpBrain = await mkdtemp(join(tmpdir(), 'pa-agy-eph-revert-'))
  try {
    const convId = '12345678-aaaa-bbbb-cccc-1234567890ab'
    const logsDir = join(tmpBrain, convId, '.system_generated', 'logs')
    await mkdir(logsDir, { recursive: true })
    const transcriptPath = join(logsDir, 'transcript.jsonl')
    const initialJsonl = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>第一步</USER_REQUEST>', created_at: '2026-11-27T01:00:00Z' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '已完成第一步', status: 'DONE', created_at: '2026-11-27T01:00:05Z' }),
      JSON.stringify({ step_index: 4, type: 'USER_INPUT', content: '<USER_REQUEST>继续 2b</USER_REQUEST>', created_at: '2026-11-27T01:01:00Z' }),
      JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', content: '已完成 2b', status: 'DONE', created_at: '2026-11-27T01:01:05Z' }),
    ].join('\n')
    await writeFile(transcriptPath, initialJsonl, 'utf8')

    const spawnedCalls = []
    let killed = false
    const spawnImpl = (bin, args, opts = {}) => {
      spawnedCalls.push({ bin, args, env: opts?.env || {} })
      const child = new EventEmitter()
      child.pid = 77889
      child.killed = false
      child.exitCode = null
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {
        killed = true
        child.killed = true
        child.exitCode = 0
        child.emit('exit', 0)
      }
      return child
    }

    const emptyPsExec = async (cmd) => {
      if (cmd === 'ps') {
        // Before spawn: no running hub. After spawn: ps shows our ephemeral hub PID 77889,
        // which discoverAntigravityHubInstances MUST exclude.
        if (spawnedCalls.length > 0 && !killed) {
          return {
            stdout: '77889 /Users/tester/.gemini/bin/agy --hub --hub-port=54321 --app_data_dir=antigravity --csrf_token=fake-tok\n',
            stderr: '',
          }
        }
        return { stdout: '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }

    const rpcCalls = []
    const fetchImpl = async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {}
      rpcCalls.push({ url, body })
      if (url.endsWith('/GetAllCascadeTrajectories')) {
        return { ok: true, status: 200, json: async () => ({ trajectorySummaries: {} }) }
      }
      if (url.endsWith('/LoadTrajectory') || url.endsWith('/CancelCascadeInvocation')) {
        return { ok: true, status: 200, json: async () => ({}) }
      }
      if (url.endsWith('/GetRevertPreview')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            codeEditPreviews: [
              { fileUri: 'file:///Users/tester/blender/leaf.py', actionType: 'CODE_REVERT_ACTION_TYPE_MODIFY' },
            ],
          }),
        }
      }
      if (url.endsWith('/RevertToCascadeStep')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            metadata: { revertedUris: ['file:///Users/tester/blender/leaf.py'] },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }

    // 1. Preview spins up ephemeral agy --hub and returns real file diff
    const prevRes = await previewAntigravityRevert(`agy-ide:${convId}`, 4, {
      preferredCwd: '/Users/tester/blender',
      execImpl: emptyPsExec,
      fetchImpl,
      spawnImpl,
      cliPath: '/Users/tester/.gemini/bin/agy',
      home: '/Users/tester',
      portAllocator: async () => 54321,
    })
    assert.equal(prevRes.ok, true)
    assert.equal(prevRes.engine, 'agy-ephemeral-hub')
    assert.equal(prevRes.fileCount, 1)
    assert.equal(prevRes.files[0].relPath, 'leaf.py')
    assert.equal(spawnedCalls.length, 1)
    assert.ok(spawnedCalls[0].args.includes('--hub'))
    assert.ok(spawnedCalls[0].args.includes('--app_data_dir=antigravity'))
    assert.equal(spawnedCalls[0].env.AGY_ENABLE_HUB, '1', 'must set AGY_ENABLE_HUB=1 for headless macOS LaunchAgent')

    // 2. Normal IDE hub discovery MUST ignore our ephemeral revert hub PID & address
    const discovered = await discoverAntigravityHubInstances({ execImpl: emptyPsExec })
    assert.equal(discovered.length, 0, 'ephemeral revert hub must never leak into IDE discovery')

    // 3. Revert reuses warm ephemeral hub (no second spawn!) and records local revert ceiling
    const revRes = await revertAntigravityToStep(`agy-ide:${convId}`, 4, {
      conversationOnly: false,
      preferredCwd: '/Users/tester/blender',
      brainDirs: [tmpBrain],
      execImpl: emptyPsExec,
      fetchImpl,
      spawnImpl,
      cliPath: '/Users/tester/.gemini/bin/agy',
      home: '/Users/tester',
      portAllocator: async () => 54321,
    })
    assert.equal(revRes.ok, true)
    assert.equal(revRes.engine, 'agy-ephemeral-hub')
    assert.equal(revRes.revertedCount, 1)
    assert.equal(spawnedCalls.length, 1, 'should reuse warm ephemeral hub without respawning')

    // 4. Immediately after revert (before transcript.jsonl is appended), ACP-only loadAntigravityIdeSessions trims step >= 4
    //    AND keeps hasLiveSummary === false so host stays truthfully in ACP mode
    const afterRevertSessions = await loadAntigravityIdeSessions({
      brainDirs: [tmpBrain],
      execImpl: emptyPsExec,
      fetchImpl,
    })
    const sessAfter = afterRevertSessions.find(s => s.id === `agy-ide:${convId}`)
    assert.ok(sessAfter)
    assert.equal(sessAfter.hasLiveSummary, false)
    assert.deepEqual(
      sessAfter.transcript.filter(m => m.role === 'user').map(m => ({ text: m.text, stepIndex: m.stepIndex })),
      [{ text: '第一步', stepIndex: 0 }],
    )

    // 5. Once user sends a new replacement prompt (appending step_index=4 to transcript.jsonl), ceiling auto-expires cleanly
    await writeFile(
      transcriptPath,
      `${initialJsonl}\n${JSON.stringify({ step_index: 4, type: 'USER_INPUT', content: '<USER_REQUEST>改小一点分步做</USER_REQUEST>', created_at: '2026-11-27T01:02:00Z' })}\n`,
      'utf8',
    )
    const afterNewPrompt = await loadAntigravityIdeSessions({
      brainDirs: [tmpBrain],
      execImpl: emptyPsExec,
      fetchImpl,
    })
    const sessNext = afterNewPrompt.find(s => s.id === `agy-ide:${convId}`)
    assert.ok(sessNext)
    assert.deepEqual(
      sessNext.transcript.filter(m => m.role === 'user').map(m => ({ text: m.text, stepIndex: m.stepIndex })),
      [
        { text: '第一步', stepIndex: 0 },
        { text: '改小一点分步做', stepIndex: 4 },
      ],
    )

    shutdownEphemeralRevertHub()
    assert.equal(killed, true, 'shutdownEphemeralRevertHub must terminate child cleanly')
  } finally {
    if (prevLsAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS
    else process.env.ANTIGRAVITY_LS_ADDRESS = prevLsAddr
    if (prevLsCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN
    else process.env.ANTIGRAVITY_CSRF_TOKEN = prevLsCsrf
    shutdownEphemeralRevertHub()
    clearLocalAntigravityRevertCeilings()
    await rm(tmpBrain, { recursive: true, force: true })
  }
})
