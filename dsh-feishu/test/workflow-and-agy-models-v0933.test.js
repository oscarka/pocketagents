import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  discoverAntigravityModelCatalog,
  invalidateAntigravityModelCatalogCache,
  parseAgyModelsCliOutput,
  parseAntigravityTranscript,
  resolveAntigravityModelLabel,
} from '../lib/antigravity-ide.js'

test('v0.9.33 parseAntigravityTranscript hides completed and in-progress run_workflow worker sessions without false positives', () => {
  const completedWorkflowJsonl = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-21T16:22:23Z',
      content: '<USER_REQUEST>\n闭卷视觉理解测试（匿名考卷 exam_02 / 实验组 A）\n\nWhen you are done, call the finish tool with your result.\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T16:23:01Z',
      model: 'gemini-4-neon-xhigh',
      tool_calls: [{ name: 'finish', args: { result: '{"Q1":"UPS"}' } }],
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-21T16:23:02Z',
      content: 'Task is complete. Summarize what you did and do not call any more tools.',
    }),
  ].join('\n')

  const completedParsed = parseAntigravityTranscript(completedWorkflowJsonl, {
    conversationId: '9ab49e87-3762-45ac-80a6-9e284fd4a6ab',
    hasLiveSummary: false,
  })
  assert.ok(completedParsed)
  assert.equal(completedParsed.isSubagent, true)
  assert.equal(completedParsed.model, 'Gemini 4 Neon (XHigh)')

  // In-progress workflow worker before calling finish
  const inProgressWorkflowJsonl = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-21T16:22:23Z',
      content: '<USER_REQUEST>\nReview module A.\n\nWhen you are done, call the finish tool with your result.\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T16:22:25Z',
      model: 'gemini-4-neon-high',
      tool_calls: [{ name: 'read_file', args: { Path: '/Users/cc/app/index.js' } }],
    }),
  ].join('\n')

  const inProgressParsed = parseAntigravityTranscript(inProgressWorkflowJsonl, {
    conversationId: '11111111-2222-3333-4444-555555555555',
    hasLiveSummary: false,
  })
  assert.ok(inProgressParsed)
  assert.equal(inProgressParsed.isSubagent, true)

  // Normal user conversation that reads a workflow transcript via read_file must NEVER be marked as subagent
  const normalChatReadingWorkflowJsonl = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-26T00:00:00Z',
      content: '<USER_REQUEST>\n看看为什么聊天里出现了一堆重复的测试对话\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-26T00:00:02Z',
      model: 'gemini-4-neon-xhigh',
      tool_calls: [{ name: 'read_file', args: { Path: '/Users/cc/.gemini/antigravity/brain/abc/transcript.jsonl' } }],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-26T00:00:03Z',
      content: 'Showing lines 1-3 of 3\n1: When you are done, call the finish tool with your result.\n2: Task is complete. Summarize what you did and do not call any more tools.',
    }),
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-26T00:00:05Z',
      model: 'gemini-4-neon-xhigh',
      content: '已经查明原因，那些是 run_workflow 的后台 worker 记录。',
    }),
  ].join('\n')

  const normalParsed = parseAntigravityTranscript(normalChatReadingWorkflowJsonl, {
    conversationId: 'e5b8d936-c3cb-4634-bfac-83fed58c8f1b',
    hasLiveSummary: false,
  })
  assert.ok(normalParsed)
  assert.equal(Boolean(normalParsed.isSubagent), false)
  assert.equal(normalParsed.model, 'Gemini 4 Neon (XHigh)')
})

test('v0.9.33 parseAgyModelsCliOutput strips spinner & maps official agy models slugs cleanly', () => {
  const rawStdout = [
    '\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-high             Gemini 4 Neon (High)',
    'gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)',
    'gemini-4-carbon-high           Gemini 4 Carbon (High)',
    'gemini-4-hydrogen-xhigh        Gemini 4 Hydrogen (XHigh)',
    'gemini-pro-orchestrator-neon   Orchestrator (Neon)',
    'gemini-5-future-preview        Gemini 5 Future (Preview)',
    'I1126 08:00:00 server.go:10] noisy log line',
  ].join('\n')

  const parsed = parseAgyModelsCliOutput(rawStdout)
  assert.deepEqual(parsed, [
    { value: 'MODEL_PLACEHOLDER_M532', label: 'Gemini 4 Neon (High)' },
    { value: 'MODEL_PLACEHOLDER_M535', label: 'Gemini 4 Neon (XHigh)' },
    { value: 'MODEL_PLACEHOLDER_M427', label: 'Gemini 4 Carbon (High)' },
    { value: 'MODEL_PLACEHOLDER_M528', label: 'Gemini 4 Hydrogen (XHigh)' },
    { value: 'MODEL_PLACEHOLDER_M537', label: 'Orchestrator (Neon)' },
    { value: 'gemini-5-future-preview', label: 'Gemini 5 Future (Preview)' },
  ])
})

test('v0.9.33 discoverAntigravityModelCatalog falls back to agy CLI and full 27-model catalog on standalone Antigravity.app hosts', async () => {
  invalidateAntigravityModelCatalogCache()

  // Case 1: No Connect-RPC hub, but official `agy models` CLI is available
  const cliCatalog = await discoverAntigravityModelCatalog({
    agyBin: '/mock/bin/agy',
    execImpl: async (bin, args) => {
      if (bin === 'ps') return { stdout: '24223 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone\n' }
      if (bin === '/mock/bin/agy' && args[0] === 'models') {
        return {
          stdout: 'gemini-4-neon-high             Gemini 4 Neon (High)\ngemini-4-neon-xhigh            Gemini 4 Neon (XHigh)\n',
        }
      }
      throw new Error('unexpected')
    },
    fetchImpl: async () => {
      throw new Error('no rpc')
    },
  })
  assert.equal(cliCatalog.defaultModel, 'MODEL_PLACEHOLDER_M532')
  assert.equal(cliCatalog.defaultLabel, 'Gemini 4 Neon (High)')
  assert.equal(cliCatalog.models.length, 2)

  // Case 2: Neither Connect-RPC nor `agy` CLI available -> full 27-model built-in catalog
  const fallbackCatalog = await discoverAntigravityModelCatalog({
    agyBin: '/mock/bin/missing-agy',
    execImpl: async bin => {
      if (bin === 'ps') return { stdout: '' }
      throw new Error('ENOENT')
    },
    fetchImpl: async () => {
      throw new Error('no rpc')
    },
  })
  assert.equal(fallbackCatalog.defaultModel, 'MODEL_PLACEHOLDER_M532')
  assert.equal(fallbackCatalog.defaultLabel, 'Gemini 4 Neon (High)')
  assert.equal(fallbackCatalog.models.length, 27)
  assert.ok(fallbackCatalog.models.some(m => m.label === 'Gemini 4 Neon (XHigh)'))
  assert.ok(fallbackCatalog.models.some(m => m.label === 'Gemini 4 Carbon (High)'))
  assert.ok(fallbackCatalog.models.some(m => m.label === 'Gemini 4 Hydrogen (High)'))
  assert.ok(fallbackCatalog.models.some(m => m.label === 'Orchestrator (Neon)'))

  // resolveAntigravityModelLabel handles placeholder IDs, CLI aliases, and display labels
  assert.equal(resolveAntigravityModelLabel('MODEL_PLACEHOLDER_M535'), 'Gemini 4 Neon (XHigh)')
  assert.equal(resolveAntigravityModelLabel('gemini-4-neon-xhigh'), 'Gemini 4 Neon (XHigh)')
  assert.equal(resolveAntigravityModelLabel('gemini-pro-orchestrator-neon'), 'Orchestrator (Neon)')
})

test('v0.9.33 web controller includes full 27-model Antigravity fallback and upgrades legacy 13-model non-live host catalogs', async () => {
  const controllerSrc = await readFile(resolve(process.cwd(), 'hub/web/src/controller.js'), 'utf8')
  assert.match(controllerSrc, /MODEL_PLACEHOLDER_M532.*Gemini 4 Neon \(High\)/)
  assert.match(controllerSrc, /MODEL_PLACEHOLDER_M535.*Gemini 4 Neon \(XHigh\)/)
  assert.match(controllerSrc, /MODEL_PLACEHOLDER_M525.*Gemini 4 Hydrogen \(High\)/)
  assert.match(controllerSrc, /MODEL_PLACEHOLDER_M537.*Orchestrator \(Neon\)/)
  assert.match(controllerSrc, /function isLegacyStaticAgyFallback\(remoteCat, host\)/)
})
