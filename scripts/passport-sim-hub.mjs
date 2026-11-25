#!/usr/bin/env node
// scripts/passport-sim-hub.mjs
// Launches a live seeded PocketAgents Hub tailored for testing ALL 4 Full-Chinese localization
// & safety scenarios on FoloToy AI Passport inside VOID001/FoloToy-Passport-Simulator:
//   #1 Tier 2 (0ms rule)       : English Bash `npm test` -> instant Chinese title + verbatim cmd
//   #2 Tier 1 (0ms native ZH)  : Native Chinese multi-choice question -> 0 LLM calls
//   #3 Tier 3 (async BYOK LLM) : Complex English multi-choice -> live async small-model ZH upgrade
//   #4 L2 High-Risk Safety     : Destructive `rm -rf && git push --force` -> 409 PIN lock & long-DOWN deny
import { networkInterfaces } from 'node:os'
import { HubCore } from '../hub/hub-core.js'
import { createHubServer } from '../hub/server.js'

const PORT = Number(process.env.PA_SIM_PORT || 8787)
const HOST = process.env.PA_SIM_HOST || '0.0.0.0'
const TOKEN = process.env.PA_SIM_TOKEN || 'passport-sim-demo'

function detectLanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return '127.0.0.1'
}

const nowMs = Date.now()
const hub = new HubCore({ stateFile: '' })

const initialBridgeState = {
  tasks: [
    {
      id: 'claude:unit-tests',
      harness: 'claude',
      title: '修复支付单测',
      cwd: '/Users/dev/pocketagents',
      status: 'approval',
      updatedAt: nowMs - 1000,
      lastOutput: '补完重试退避逻辑，准备跑单测。',
      pendingApproval: true,
    },
    {
      id: 'agy:db-migration',
      harness: 'antigravity',
      title: '数据库迁移',
      cwd: '/Users/dev/pocketagents',
      status: 'approval',
      updatedAt: nowMs - 2000,
      lastOutput: '请确认迁移策略。',
      pendingApproval: true,
    },
    {
      id: 'codex:rollout-plan',
      harness: 'codex',
      title: 'v0.9.21 发布',
      cwd: '/Users/dev/pocketagents',
      status: 'approval',
      updatedAt: nowMs - 3000,
      lastOutput: 'Waiting for rollout strategy choice.',
      pendingApproval: true,
    },
    {
      id: 'codex:cleanup',
      harness: 'codex',
      title: '清理构建缓存',
      cwd: '/Users/dev/pocketagents',
      status: 'approval',
      updatedAt: nowMs - 4000,
      lastOutput: 'Requested destructive cleanup command.',
      pendingApproval: true,
    },
  ],
  approvals: [
    // #1 Tier 2 (0ms deterministic rule): English Bash npm test -> "终端命令" / "运行自动化测试" + verbatim cmd
    {
      code: 'CLD-101',
      agentId: 'claude:unit-tests',
      kind: 'approval',
      toolName: 'Bash',
      promptTitle: 'Allow running unit test suite?',
      commandLine: 'npm test -- device-lite-api.test.js',
      createdAt: nowMs - 40_000,
      options: [
        { index: 1, label: 'Allow once' },
        { index: 2, label: 'Always allow' },
        { index: 3, label: 'Deny' },
      ],
    },
    // #2 Tier 1 (0ms native Chinese passthrough): ZERO LLM calls
    {
      code: 'AGY-202',
      agentId: 'agy:db-migration',
      kind: 'question',
      toolName: 'ask_question',
      promptTitle: '请选择数据库迁移方式',
      createdAt: nowMs - 30_000,
      questions: [
        {
          id: 'q_db',
          question: '希望采用哪种迁移策略？',
          options: [
            { label: '只迁移测试库' },
            { label: '灰度双写' },
            { label: '暂缓执行' },
          ],
        },
      ],
    },
    // #3 Tier 3 (async BYOK small model): English multi-choice -> auto-translated to Chinese on next poll
    {
      code: 'CDX-203',
      agentId: 'codex:rollout-plan',
      kind: 'question',
      toolName: 'ask_question',
      promptTitle: 'Select release rollout strategy for v0.9.21',
      createdAt: nowMs - 20_000,
      questions: [
        {
          id: 'q_rollout',
          question: 'Choose rollout target:',
          options: [
            { label: 'Canary staging (10%)' },
            { label: 'Full production rollout' },
            { label: 'Hold and audit logs' },
          ],
        },
      ],
    },
    // #4 L2 High-Risk Safety: English destructive command -> "L2 高危" + "高危：删文件并强推代码" + verbatim cmd
    {
      code: 'CDX-303',
      agentId: 'codex:cleanup',
      kind: 'approval',
      toolName: 'Bash',
      promptTitle: 'Force push & wipe old build?',
      commandLine: 'rm -rf /tmp/old-build && git push --force origin main',
      createdAt: nowMs - 10_000,
      options: [
        { index: 1, label: 'Allow' },
        { index: 2, label: 'Deny' },
      ],
    },
  ],
}

hub.handleHeartbeat({
  hostId: 'macbook-pro',
  hostName: 'MacBook Pro',
  bridgeState: structuredClone(initialBridgeState),
})

// Mock BYOK fast small-model fetch (zero external API keys needed in simulator E2E)
let llmCallCount = 0
const simVoiceFetch = async (url, init = {}) => {
  const urlStr = String(url || '')
  if (urlStr.includes('/chat/completions')) {
    llmCallCount += 1
    // Simulate realistic ~220ms small-model latency
    await new Promise(r => setTimeout(r, 220))
    const rawBody = typeof init.body === 'string' ? init.body : ''
    let content = JSON.stringify({
      title: '选择 v0.9.21 发布策略',
      options: ['灰度发布 10%', '全量正式上线', '暂缓并查日志'],
    })
    if (!rawBody.includes('v0.9.21') && !rawBody.includes('rollout')) {
      content = JSON.stringify({
        title: '需要你确认下一步操作',
        options: ['继续执行', '暂缓处理'],
      })
    }
    console.log(`[SIM-HUB] Mock BYOK Small-Model call #${llmCallCount} -> ${content}`)
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        choices: [{ message: { content } }],
      }),
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    }
  }
  if (urlStr.includes('/audio/transcriptions')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ text: '查看当前状态' }),
      text: async () => JSON.stringify({ text: '查看当前状态' }),
    }
  }
  if (urlStr.includes('/audio/speech')) {
    const pcm = Buffer.alloc(1600 * 2, 0)
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      arrayBuffer: async () => pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
    }
  }
  throw new Error(`Unexpected simVoiceFetch URL: ${urlStr}`)
}

// Simulate live host daemon consuming queued commands every 250ms and settling approvals
const executedLog = []
setInterval(() => {
  const hb = hub.handleHeartbeat({
    hostId: 'macbook-pro',
    hostName: 'MacBook Pro',
  })
  const cmds = hb.commands || []
  if (cmds.length === 0) return

  const host = hub.hosts.get('macbook-pro')
  const curState = structuredClone(host?.bridgeState || { tasks: [], approvals: [] })
  for (const cmd of cmds) {
    executedLog.push({ at: Date.now(), ...cmd })
    console.log(`[SIM-HUB] Executed on host: ${JSON.stringify(cmd)}`)
    if (cmd.type === 'approve' || cmd.type === 'deny') {
      const code = String(cmd.code || '').toUpperCase()
      curState.approvals = (curState.approvals || []).filter(
        a => String(a?.code || '').toUpperCase() !== code,
      )
      for (const t of curState.tasks || []) {
        if (t.id === cmd.agentId) {
          t.pendingApproval = false
          t.status = cmd.type === 'approve' ? 'running' : 'idle'
          t.updatedAt = Date.now()
        }
      }
      hub.handleHeartbeat({
        hostId: 'macbook-pro',
        hostName: 'MacBook Pro',
        bridgeState: curState,
        commandResults: [{ id: cmd.id, ok: true, code, decision: cmd.type }],
      })
    }
  }
}, 250)

const { server, voiceVault } = createHubServer({
  hub,
  token: TOKEN,
  requireToken: true,
  voiceVaultFile: '',
  voiceFetch: simVoiceFetch,
})

// Seed an in-memory mock BYOK credential so Tier 3 small-model localization activates automatically
await voiceVault.init()
const credOut = await voiceVault.upsertCredential({
  provider: 'openai_compat',
  name: 'Sim Fast Brain',
  apiKey: 'sk-sim-demo-only',
  baseUrl: 'https://sim.local/v1',
  defaultModel: 'qwen-turbo-sim',
})
await voiceVault.upsertProfile({
  id: 'sim-zh-profile',
  name: 'Sim ZH',
  activate: true,
  stt: { provider: 'openai_compat', credId: credOut.credential.id, model: 'whisper-1' },
  brain: { provider: 'openai_compat', credId: credOut.credential.id, model: 'qwen-turbo-sim' },
  tts: { provider: 'openai_compat', credId: credOut.credential.id, model: 'tts-1', voice: 'alloy' },
})

// Expose tiny read-only test inspection hook for automated E2E verification
const origEmit = server.listeners('request')[0]
server.removeAllListeners('request')
server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/__sim_log') {
    const host = hub.hosts.get('macbook-pro')
    const pendingCodes = (host?.bridgeState?.approvals || []).map(a => a.code)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, executed: executedLog, llmCalls: llmCallCount, pendingCodes }))
    return
  }
  return origEmit(req, res)
})

server.listen(PORT, HOST, () => {
  const lanIp = detectLanIp()
  console.log(`[SIM-HUB] PocketAgents Full-ZH Sim Hub listening on http://${lanIp}:${PORT}`)
  console.log(`[SIM-HUB] Token: ${TOKEN}`)
  console.log(`[SIM-HUB] Digest URL: http://${lanIp}:${PORT}/api/device/digest`)
})
