import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseAntigravityTranscript,
  previewAntigravityRevert,
  revertAntigravityToStep,
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
